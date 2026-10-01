// One Docker container per agent: its own disk (named volume at /home/agent), the shared folder at
// /shared, and no published ports except computerd + VNC bound to 127.0.0.1.
import os from 'node:os';
import Docker from 'dockerode';
import type { ComputerStatus } from '@teambot/shared';
import type { Config } from '../config.js';
import type { Bus } from '../bus.js';
import type { Vault } from '../vault.js';
import { errorMessage, sleep } from '../util.js';
import type { CallOptions, ComputerHandle, ComputerProvider, ComputerSpec } from './types.js';

const API_PORT = '7070/tcp';
const VNC_PORT = '5900/tcp';

/** Proxy settings for login shells, apt and Chromium (convenience: the firewall is what enforces). */
const PROXY_SETTINGS = `set -e
if [ -n "$PROXY" ]; then
  echo "export http_proxy=http://$PROXY https_proxy=http://$PROXY HTTP_PROXY=http://$PROXY HTTPS_PROXY=http://$PROXY no_proxy=localhost,127.0.0.1 NO_PROXY=localhost,127.0.0.1" > /etc/profile.d/teambot-proxy.sh
  echo "Acquire::http::Proxy \\"http://$PROXY\\"; Acquire::https::Proxy \\"http://$PROXY\\";" > /etc/apt/apt.conf.d/95teambot-proxy
  mkdir -p /etc/chromium/policies/managed
  printf '{"ProxyMode":"fixed_servers","ProxyServer":"%s","ProxyBypassList":"localhost;127.0.0.1"}' "$PROXY" > /etc/chromium/policies/managed/teambot-proxy.json
else
  rm -f /etc/profile.d/teambot-proxy.sh /etc/apt/apt.conf.d/95teambot-proxy /etc/chromium/policies/managed/teambot-proxy.json
fi`;

/**
 * What may leave the computer. Always: loopback, and replies on connections made *to* it (the server reaching computerd
 * and VNC). Connections the computer opened itself get no such pass, so tightening the rules also cuts ones already
 * open. With a proxy: only the proxy, besides. Without: anything except the machine TeamBot runs on (its API acts as the
 * owner when sign-in is off), reached as the server's own addresses ($SERVER_IPS) or Docker's names for the host.
 * The computer starts with everything but loopback and replies blocked (entrypoint.sh) until this has run.
 */
const FIREWALL = `set -e
command -v iptables >/dev/null || { echo "iptables is not installed in this computer image" >&2; exit 1; }
iptables -F OUTPUT
ip6tables -F OUTPUT 2>/dev/null || true
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctdir REPLY -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -m conntrack --ctdir REPLY -j ACCEPT 2>/dev/null || true
if [ -n "$PROXY" ]; then
  PROXY_IP=$(getent ahostsv4 "$PROXY_HOST" | awk 'NR==1 {print $1}')
  [ -n "$PROXY_IP" ] || { echo "cannot resolve $PROXY_HOST" >&2; exit 1; }
  iptables -A OUTPUT -p tcp -d "$PROXY_IP" --dport "$PROXY_PORT" -j ACCEPT
  iptables -A OUTPUT -j REJECT
  ip6tables -A OUTPUT -j REJECT 2>/dev/null || true
else
  HOST4=$(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u || true)
  HOST6=$(getent ahostsv6 host.docker.internal 2>/dev/null | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ {print $1}' | sort -u || true)
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  for ip in $SERVER_IPS $HOST4; do iptables -A OUTPUT -d "$ip" -j REJECT; done
  for ip in $HOST6; do ip6tables -A OUTPUT -d "$ip" -j REJECT 2>/dev/null || true; done
fi`;

export class HttpComputerHandle implements ComputerHandle {
  constructor(
    private baseUrl: string,
    private token: string,
    readonly vnc: { host: string; port: number; password: string },
  ) {}

  async call<T>(path: string, body: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180_000);
    const isGet = path === '/health';
    const res = await fetch(this.baseUrl + path, {
      method: isGet ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: isGet ? undefined : JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    const data = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok) throw new Error(data.error ?? `computer returned HTTP ${res.status}`);
    return data.result as T;
  }
}

export class DockerComputers implements ComputerProvider {
  private docker = new Docker();
  private starting = new Map<string, Promise<ComputerHandle>>();

  constructor(
    private cfg: Config,
    private vault: Vault,
    private bus: Bus,
  ) {
    if (cfg.computerNetwork) {
      void this.refreshAddresses();
      setInterval(() => void this.refreshAddresses(), 30_000).unref();
    }
  }

  /** Addresses of the computers on the shared Docker network, so the API can refuse requests that come from them. */
  private addresses = new Set<string>();

  private async refreshAddresses() {
    try {
      const list = await this.docker.listContainers({ filters: { label: ['teambot=1'] } });
      const next = new Set<string>();
      for (const c of list) {
        const ip = c.NetworkSettings?.Networks?.[this.cfg.computerNetwork!]?.IPAddress;
        if (ip) next.add(ip);
      }
      this.addresses = next;
    } catch {
      /* Docker unreachable: keep what we knew */
    }
  }

  isComputerAddress(ip: string | undefined): boolean {
    return !!ip && this.addresses.has(ip.replace(/^::ffff:/, ''));
  }

  /** How computers reach this server when it runs on their Docker network: its own addresses there. */
  private serverIps(): string {
    if (!this.cfg.computerNetwork) return '';
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a!.address)
      .join(' ');
  }

  private name(agentId: string) {
    return `teambot-${agentId}`;
  }
  private volume(agentId: string) {
    return `teambot-home-${agentId}`;
  }
  private token(agentId: string) {
    return this.vault.derive(`computer-token:${agentId}`).slice(0, 48);
  }
  private vncPassword(agentId: string) {
    return this.vault.derive(`vnc:${agentId}`).slice(0, 8);
  }

  async available(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async imageId(image: string): Promise<string | null> {
    try {
      return (await this.docker.getImage(image).inspect()).Id;
    } catch {
      return null;
    }
  }

  async imageReady(image = this.cfg.computerImage): Promise<boolean> {
    return (await this.imageId(image)) !== null;
  }

  private async inspect(agentId: string): Promise<Docker.ContainerInspectInfo | null> {
    try {
      return await this.docker.getContainer(this.name(agentId)).inspect();
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  async status(agentId: string): Promise<ComputerStatus> {
    if (this.starting.has(agentId)) return { agentId, state: 'starting' };
    try {
      const info = await this.inspect(agentId);
      if (!info) return { agentId, state: 'missing' };
      return { agentId, state: info.State.Running ? 'running' : 'stopped' };
    } catch (err) {
      return { agentId, state: 'unavailable', detail: errorMessage(err) };
    }
  }

  ensure(agentId: string, spec: ComputerSpec = {}): Promise<ComputerHandle> {
    const inFlight = this.starting.get(agentId);
    if (inFlight) return inFlight;
    const p = this.doEnsure(agentId, spec.image || this.cfg.computerImage)
      .then(async (handle) => {
        if (spec.network !== undefined) await this.syncNetwork(agentId, spec.network);
        return handle;
      })
      .finally(() => this.starting.delete(agentId));
    this.starting.set(agentId, p);
    return p;
  }

  /** What was last applied to each computer, keyed to its start time (firewall rules don't survive a restart). */
  private network = new Map<string, string>();

  private async syncNetwork(agentId: string, net: ComputerSpec['network']) {
    const info = await this.inspect(agentId);
    if (!info?.State.Running) return;
    const want = `${info.State.StartedAt}|${net ? `${net.proxyHost}:${net.proxyPort}` : 'open'}`;
    if (this.network.get(agentId) === want) return;
    try {
      await this.applyNetwork(agentId, net ?? null);
    } catch (err) {
      // Fail closed: a computer doesn't get used until its firewall is in place (open mode still keeps it off the host).
      throw new Error(`could not set up ${agentId}'s network rules: ${errorMessage(err)}. If the computer image is old, rebuild it: pnpm computer:build`);
    }
    this.network.set(agentId, want);
    this.bus.emit('computer.network', { agentId }, { mode: net ? 'allowlist' : 'open', proxy: net ? `${net.proxyHost}:${net.proxyPort}` : null });
  }

  /** Run a shell command inside the computer as root (optionally with full privileges, for the firewall). */
  private async exec(agentId: string, script: string, opts: { privileged?: boolean; user?: string; env?: string[] } = {}): Promise<string> {
    const exec = await this.docker.getContainer(this.name(agentId)).exec({
      Cmd: ['sh', '-c', script],
      User: opts.user ?? 'root',
      Privileged: !!opts.privileged,
      Env: opts.env,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const { ExitCode } = await exec.inspect();
    const output = Buffer.concat(chunks).toString('utf8').replace(/[\x00-\x08]/g, '').trim();
    if (ExitCode !== 0) throw new Error(output.slice(-500) || `exit code ${ExitCode}`);
    return output;
  }

  /**
   * Route the computer's traffic through the agent's egress proxy, or open it up again. The firewall is set from a
   * privileged exec: the agent's own processes have no NET_ADMIN, so even with sudo they can't change it.
   */
  private async applyNetwork(agentId: string, net: { proxyHost: string; proxyPort: number } | null) {
    const env = [
      ...(net ? [`PROXY=${net.proxyHost}:${net.proxyPort}`, `PROXY_HOST=${net.proxyHost}`, `PROXY_PORT=${net.proxyPort}`] : ['PROXY=']),
      `SERVER_IPS=${this.serverIps()}`,
    ];
    await this.exec(agentId, PROXY_SETTINGS, { env });
    await this.exec(agentId, FIREWALL, { env, privileged: true });
    // Chromium reads its proxy policy at start.
    await this.exec(agentId, 'supervisorctl -c /etc/teambot/supervisord.conf restart chromium >/dev/null', { user: 'agent' }).catch(() => undefined);
  }

  private async doEnsure(agentId: string, image: string): Promise<ComputerHandle> {
    let info = await this.inspect(agentId);
    if (info?.State.Running) {
      const handle = this.handleFor(agentId, info);
      // Fast path: already healthy.
      try {
        await handle.call('/health', {}, { timeoutMs: 3000 });
        return handle;
      } catch {
        /* fall through to wait */
      }
      return this.waitHealthy(agentId, handle);
    }

    this.bus.emit('computer.starting', { agentId });
    try {
      // A stopped computer built from another (or an older) image is recreated; its disk (the volume) is kept.
      const latest = info ? await this.imageId(image) : null;
      if (info && latest && latest !== info.Image) {
        await this.docker.getContainer(this.name(agentId)).remove({ force: true });
        info = null;
      }
      if (!info) {
        if (!(await this.imageReady(image))) {
          throw new Error(
            image === this.cfg.computerImage
              ? `Computer image ${image} is missing. Build it with: pnpm computer:build`
              : `Computer image ${image} is missing. Build or pull it (docker pull ${image}), or clear the agent's custom image.`,
          );
        }
        await this.create(agentId, image);
      }
      await this.docker.getContainer(this.name(agentId)).start().catch((err: any) => {
        if (err?.statusCode !== 304) throw err; // 304 = already started
      });
      info = (await this.inspect(agentId))!;
      const handle = await this.waitHealthy(agentId, this.handleFor(agentId, info));
      this.bus.emit('computer.started', { agentId });
      return handle;
    } catch (err) {
      this.bus.emit('computer.error', { agentId }, { error: errorMessage(err) });
      throw err;
    }
  }

  private async create(agentId: string, image: string) {
    const memory = this.cfg.computerMemoryMb * 1024 * 1024;
    const onNetwork = !!this.cfg.computerNetwork;
    await this.docker.createContainer({
      name: this.name(agentId),
      Image: image,
      Hostname: 'computer',
      Env: [`COMPUTERD_TOKEN=${this.token(agentId)}`, `VNC_PASSWORD=${this.vncPassword(agentId)}`, `TEAMBOT_AGENT_ID=${agentId}`, 'TZ=UTC'],
      Labels: { teambot: '1', 'teambot.agent': agentId },
      ExposedPorts: { [API_PORT]: {}, [VNC_PORT]: {} },
      HostConfig: {
        // On a host, publish to 127.0.0.1 only. Inside Docker, the server reaches computers over the private network.
        PortBindings: onNetwork
          ? {}
          : {
              [API_PORT]: [{ HostIp: '127.0.0.1', HostPort: '' }],
              [VNC_PORT]: [{ HostIp: '127.0.0.1', HostPort: '' }],
            },
        NetworkMode: onNetwork ? this.cfg.computerNetwork : undefined,
        // Lets computers reach the egress proxy on a Linux host too (Docker Desktop has this name built in).
        ExtraHosts: onNetwork ? undefined : ['host.docker.internal:host-gateway'],
        Mounts: [
          { Type: 'volume', Source: this.volume(agentId), Target: '/home/agent' },
          this.cfg.sharedVolume
            ? { Type: 'volume', Source: this.cfg.sharedVolume, Target: '/shared' }
            : { Type: 'bind', Source: this.cfg.sharedDir, Target: '/shared' },
        ],
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: Math.round(this.cfg.computerCpus * 1e9),
        ShmSize: 512 * 1024 * 1024,
        PidsLimit: 2048,
        Runtime: this.cfg.sandboxRuntime || undefined,
        // Only for the entrypoint, which blocks the network before anything else starts and then drops this
        // capability for every process it starts (sudo included). The server sets the real rules from outside.
        CapAdd: ['NET_ADMIN'],
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
  }

  private handleFor(agentId: string, info: Docker.ContainerInspectInfo): HttpComputerHandle {
    if (this.cfg.computerNetwork) {
      const ip = info.NetworkSettings.Networks?.[this.cfg.computerNetwork]?.IPAddress;
      if (ip) this.addresses.add(ip);
      const host = this.name(agentId);
      return new HttpComputerHandle(`http://${host}:7070`, this.token(agentId), { host, port: 5900, password: this.vncPassword(agentId) });
    }
    const ports = info.NetworkSettings.Ports ?? {};
    const api = ports[API_PORT]?.[0]?.HostPort;
    const vnc = ports[VNC_PORT]?.[0]?.HostPort;
    if (!api || !vnc) throw new Error('computer is running but its ports are not published');
    return new HttpComputerHandle(`http://127.0.0.1:${api}`, this.token(agentId), {
      host: '127.0.0.1',
      port: Number(vnc),
      password: this.vncPassword(agentId),
    });
  }

  async cancelWork(agentId: string): Promise<void> {
    const info = await this.inspect(agentId);
    if (!info?.State.Running) return;
    await this.handleFor(agentId, info).call('/cancel', {}, { timeoutMs: 15_000 });
  }

  private async waitHealthy(agentId: string, handle: HttpComputerHandle): Promise<HttpComputerHandle> {
    const deadline = Date.now() + 90_000;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const h = await handle.call<{ ok: boolean; browser: boolean }>('/health', {}, { timeoutMs: 3000 });
        if (h.ok && h.browser) return handle;
      } catch (err) {
        last = err;
      }
      await sleep(750);
    }
    throw new Error(`computer for ${agentId} did not become healthy: ${errorMessage(last)}`);
  }

  async vnc(agentId: string) {
    const info = await this.inspect(agentId).catch(() => null);
    if (!info?.State.Running) return null;
    try {
      return this.handleFor(agentId, info).vnc;
    } catch {
      return null;
    }
  }

  async stop(agentId: string) {
    const info = await this.inspect(agentId);
    if (!info?.State.Running) return;
    await this.docker.getContainer(this.name(agentId)).stop({ t: 5 });
    this.bus.emit('computer.stopped', { agentId });
  }

  /** The container must exist (it may be stopped) for Docker's archive API. */
  private async container(agentId: string, spec?: ComputerSpec) {
    if (!(await this.inspect(agentId))) await this.ensure(agentId, spec);
    return this.docker.getContainer(this.name(agentId));
  }

  async exportHome(agentId: string, spec?: ComputerSpec): Promise<NodeJS.ReadableStream> {
    // The archive's top folder is "agent/" (the last part of /home/agent).
    return (await this.container(agentId, spec)).getArchive({ path: '/home/agent' });
  }

  async importHome(agentId: string, tar: NodeJS.ReadableStream, spec?: ComputerSpec) {
    // Exactly the snapshot: stop the browser (it holds its profile open), empty the home folder, unpack, restart.
    await this.ensure(agentId, spec);
    await this.exec(agentId, 'supervisorctl -c /etc/teambot/supervisord.conf stop chromium >/dev/null 2>&1 || true; find /home/agent -mindepth 1 -delete');
    await this.docker.getContainer(this.name(agentId)).putArchive(tar, { path: '/home' });
    await this.exec(agentId, 'supervisorctl -c /etc/teambot/supervisord.conf start chromium >/dev/null 2>&1 || true', { user: 'agent' });
  }

  async reset(agentId: string) {
    const info = await this.inspect(agentId);
    if (info) await this.docker.getContainer(this.name(agentId)).remove({ force: true });
    await this.docker.getVolume(this.volume(agentId)).remove().catch(() => undefined);
    this.bus.emit('computer.reset', { agentId });
  }
}
