// Egress allowlists. An agent set to "allowlist" can reach the internet only through its own proxy here,
// which lets through the domains it is allowed and refuses the rest. The agent's computer is firewalled so
// that this proxy is the only thing it can connect to (see computers/docker.ts → applyNetwork); the agent
// runs without NET_ADMIN, so even with sudo it can't lift the firewall.
// Each restricted agent gets its own port, which is how the proxy knows who is asking.
import http from 'node:http';
import net from 'node:net';
import type { Agent } from '@teambot/shared';
import type { App } from './app.js';
import { domainMatches } from './policy.js';
import { errorMessage } from './util.js';

const BLOCK_LOG_MS = 60_000;

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return allow.some((p) => domainMatches(h, p.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')));
}

export class EgressProxy {
  private servers = new Map<string, { server: http.Server; port: number }>();
  private lastBlocked = new Map<string, number>();

  constructor(private app: App) {}

  /** How computers reach the proxy, and where it listens. */
  get host(): string {
    return this.app.cfg.egressHost;
  }

  start() {
    for (const agent of this.app.store.listAgents()) if (agent.network.mode === 'allowlist') void this.portFor(agent).catch((err) => console.error(`egress proxy for ${agent.name}: ${errorMessage(err)}`));
  }

  async stop() {
    await Promise.all([...this.servers.keys()].map((id) => this.close(id)));
  }

  async close(agentId: string) {
    const entry = this.servers.get(agentId);
    if (!entry) return;
    this.servers.delete(agentId);
    entry.server.closeAllConnections?.();
    await new Promise<void>((r) => entry.server.close(() => r()));
  }

  /** The agent's proxy port, starting its proxy if needed. Ports are remembered so they stay the same across restarts. */
  async portFor(agent: Agent): Promise<number> {
    const running = this.servers.get(agent.id);
    if (running) return running.port;
    const key = `egress_port:${agent.id}`;
    const remembered = Number(this.app.store.getSetting(key));
    const [lo, hi] = this.app.cfg.egressPorts;
    const taken = new Set([...this.servers.values()].map((s) => s.port));
    const candidates = [remembered, ...Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)].filter((p) => p >= lo && p <= hi && !taken.has(p));
    for (const port of candidates) {
      const server = this.createServer(agent.id);
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, this.app.cfg.egressBind, () => resolve(true));
      });
      if (!ok) continue;
      this.servers.set(agent.id, { server, port });
      this.app.store.setSetting(key, String(port));
      return port;
    }
    throw new Error(`no free port for ${agent.name}'s egress proxy in ${lo}-${hi}`);
  }

  private allowedFor(agentId: string, host: string): boolean {
    const agent = this.app.store.getAgent(agentId);
    // Read fresh every time, so allowlist edits apply to the next connection.
    return !!agent && agent.network.mode === 'allowlist' && hostAllowed(host, agent.network.allow);
  }

  private blocked(agentId: string, host: string) {
    const key = `${agentId}:${host}`;
    const now = Date.now();
    if ((this.lastBlocked.get(key) ?? 0) > now - BLOCK_LOG_MS) return;
    this.lastBlocked.set(key, now);
    this.app.bus.emit('egress.blocked', { agentId }, { host });
  }

  private createServer(agentId: string): http.Server {
    const server = http.createServer((req, res) => this.forward(agentId, req, res));
    server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => this.tunnel(agentId, req, client, head));
    server.on('clientError', (_err, socket) => socket.destroy());
    return server;
  }

  /** HTTPS and anything else tunnelled: CONNECT host:port. */
  private tunnel(agentId: string, req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    const [host, portText] = (req.url ?? '').split(/:(?=\d+$)/);
    const port = Number(portText) || 443;
    if (!host || !this.allowedFor(agentId, host)) {
      this.blocked(agentId, host || '(none)');
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nTeamBot: ${host} is not on this agent's allowlist.\r\n`);
      return;
    }
    const upstream = net.connect(port, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => upstream.destroy());
  }

  /** Plain HTTP: the request line carries the absolute URL. */
  private forward(agentId: string, req: http.IncomingMessage, res: http.ServerResponse) {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('TeamBot: this proxy expects absolute URLs');
      return;
    }
    if (!this.allowedFor(agentId, url.hostname)) {
      this.blocked(agentId, url.hostname);
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`TeamBot: ${url.hostname} is not on this agent's allowlist.\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request({ hostname: url.hostname, port: url.port || 80, path: `${url.pathname}${url.search}`, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end('TeamBot: could not reach the site')));
    req.pipe(upstream);
  }
}
