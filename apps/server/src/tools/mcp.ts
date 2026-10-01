// MCP servers come from two places:
// - mcp.json (same shape as Claude's .mcp.json), read at startup;
// - connectors: remote MCP servers added in Settings by URL. A connector that needs sign-in uses OAuth (discovery,
//   dynamic client registration and PKCE are done by the MCP SDK). Its tokens are a reserved vault secret, so agents
//   never see them, and the SDK refreshes them as they expire.
// Their tools are offered to the agents that list the server in their settings, under the name
// mcp__<server>__<tool>, with risk "external".
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import type { Agent, Connector, McpServerStatus } from '@teambot/shared';
import type { Bus } from '../bus.js';
import type { Store } from '../store.js';
import type { Vault } from '../vault.js';
import { errorMessage } from '../util.js';
import type { ToolDef } from './types.js';

interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface HttpServer {
  url: string;
  headers?: Record<string, string>;
}
type ServerConfig = StdioServer | HttpServer;

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface Connected {
  source: 'file' | 'connector';
  url?: string;
  client?: Client;
  tools: McpToolInfo[];
  needsSignIn?: boolean;
  error?: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** Connector names become tool-name prefixes: short, lower-case, no spaces. */
export const CONNECTOR_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const connectorSecret = (name: string) => `TEAMBOT_MCP_${Buffer.from(name).toString('hex').toUpperCase()}`;
export const CONNECTOR_CALLBACK = '/api/connectors/callback';
const SIGN_IN_TTL_MS = 15 * 60_000;

/** Loaded on demand: the SDK is heavy and only needed when MCP servers are configured. */
const sdk = async () => {
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }, { SSEClientTransport }, { auth, UnauthorizedError }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/client/auth.js'),
  ]);
  return { Client, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport, auth, UnauthorizedError };
};

/** What the vault keeps for a connector. */
interface Credentials {
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
}

/** A sign-in in progress. The PKCE verifier stays in memory only: after a restart, click Connect again. */
interface SignIn {
  name: string;
  state: string;
  redirectUrl: string;
  startedAt: number;
  verifier?: string;
  authUrl?: string;
}

/** The SDK's view of a connector's OAuth client, backed by the vault. */
class VaultAuth implements OAuthClientProvider {
  constructor(
    private vault: Vault,
    private name: string,
    readonly signIn: SignIn,
  ) {}

  get redirectUrl() {
    return this.signIn.redirectUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'TeamBot',
      redirect_uris: [this.signIn.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return this.signIn.state;
  }
  /** A client registered for another callback address can't finish this sign-in, so register again. */
  clientInformation() {
    const c = this.read();
    return c.redirectUrl === this.signIn.redirectUrl ? c.client : undefined;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.write({ client, redirectUrl: this.signIn.redirectUrl });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
  }
  redirectToAuthorization(url: URL) {
    this.signIn.authUrl = url.toString();
  }
  saveCodeVerifier(verifier: string) {
    this.signIn.verifier = verifier;
  }
  codeVerifier() {
    if (!this.signIn.verifier) throw new Error('No sign-in is in progress for this connector');
    return this.signIn.verifier;
  }
  discoveryState() {
    return this.read().discovery;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.write({ discovery });
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'verifier') this.signIn.verifier = undefined;
    else if (scope === 'all') this.vault.delete(connectorSecret(this.name));
    else this.write({ [scope]: undefined });
  }

  read(): Credentials {
    try {
      return JSON.parse(this.vault.get(connectorSecret(this.name)) ?? '{}') as Credentials;
    } catch {
      return {};
    }
  }
  private write(patch: Partial<Credentials>) {
    this.vault.set(connectorSecret(this.name), JSON.stringify({ ...this.read(), ...patch }));
  }
}

/** "fetch failed" says nothing; name the address and the network error underneath. */
function connectError(err: unknown, url: string): string {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (errorMessage(err) === 'fetch failed') return `Couldn't reach ${new URL(url).host}${code ? ` (${code})` : ''}`;
  return errorMessage(err);
}

/** Remote servers must use https, except on this machine (local MCP servers, tests). */
export function checkConnectorUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Enter the MCP server URL, e.g. https://mcp.notion.com/mcp');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Connector URLs must start with https://');
  return url.toString();
}

export class McpManager {
  private servers = new Map<string, Connected>();
  private signIns = new Map<string, SignIn>();

  constructor(
    private configPath: string,
    private vault: Vault,
    private store: Store,
    private bus: Bus,
    /** Where a browser reaches this server when no page origin is known (TEAMBOT_PUBLIC_URL or localhost). */
    private defaultOrigin: string,
  ) {}

  async start() {
    await Promise.all([
      ...Object.entries(this.readConfig()).map(([name, cfg]) => this.connectFile(safe(name), cfg)),
      ...this.connectors().map((c) => this.reconnect(c)),
    ]);
  }

  private readConfig(): Record<string, ServerConfig> {
    if (!fs.existsSync(this.configPath)) return {};
    try {
      return (JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as { mcpServers?: Record<string, ServerConfig> }).mcpServers ?? {};
    } catch (err) {
      console.error(`Could not read ${this.configPath}: ${errorMessage(err)}`);
      return {};
    }
  }

  private async connectFile(name: string, cfg: ServerConfig) {
    try {
      const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await sdk();
      const resolved = this.vault.resolve(cfg);
      const client = new Client({ name: 'teambot', version: '0.1.0' });
      const transport =
        'url' in resolved
          ? new StreamableHTTPClientTransport(new URL(resolved.url), { requestInit: { headers: resolved.headers } })
          : new StdioClientTransport({
              command: resolved.command,
              args: resolved.args ?? [],
              env: { ...(process.env as Record<string, string>), ...resolved.env },
              stderr: 'ignore',
            });
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.servers.set(name, { source: 'file', client, tools: tools as McpToolInfo[] });
      console.log(`MCP server "${name}" connected with ${tools.length} tools`);
    } catch (err) {
      this.servers.set(name, { source: 'file', tools: [], error: errorMessage(err) });
      console.error(`MCP server "${name}" failed to connect: ${errorMessage(err)}`);
    }
  }

  // ── connectors ─────────────────────────────────────────────────────────
  connectors(): Connector[] {
    try {
      return JSON.parse(this.store.getSetting('connectors') ?? '[]') as Connector[];
    } catch {
      return [];
    }
  }

  private connector(name: string): Connector {
    const c = this.connectors().find((x) => x.name === name);
    if (!c) throw new Error(`No connector named "${name}"`);
    return c;
  }

  addConnector(name: string, url: string): Connector {
    if (!CONNECTOR_NAME_RE.test(name)) throw new Error('Connector names are up to 24 lower-case letters, digits, - or _');
    if (this.servers.has(name) || this.connectors().some((c) => c.name === name)) throw new Error(`There is already an MCP server named "${name}"`);
    const connector: Connector = { name, url: checkConnectorUrl(url), createdAt: new Date().toISOString() };
    this.store.setSetting('connectors', JSON.stringify([...this.connectors(), connector]));
    this.servers.set(name, { source: 'connector', url: connector.url, tools: [] });
    return connector;
  }

  async removeConnector(name: string) {
    this.connector(name);
    await this.servers.get(name)?.client?.close().catch(() => undefined);
    this.servers.delete(name);
    this.vault.delete(connectorSecret(name));
    for (const [state, s] of this.signIns) if (s.name === name) this.signIns.delete(state);
    this.store.setSetting('connectors', JSON.stringify(this.connectors().filter((c) => c.name !== name)));
  }

  /** Connects, starting a sign-in if the server asks for one: the person opens `authUrl` and is sent back to the callback. */
  async connect(name: string, origin?: string): Promise<{ authUrl?: string }> {
    const connector = this.connector(name);
    const now = Date.now();
    for (const [state, s] of this.signIns) if (s.name === name || now - s.startedAt > SIGN_IN_TTL_MS) this.signIns.delete(state);
    const signIn: SignIn = { name, state: crypto.randomBytes(24).toString('base64url'), redirectUrl: new URL(CONNECTOR_CALLBACK, origin || this.defaultOrigin).toString(), startedAt: now };
    await this.open(connector, new VaultAuth(this.vault, name, signIn));
    if (!signIn.authUrl || this.servers.get(name)?.client) return {};
    this.signIns.set(signIn.state, signIn);
    return { authUrl: signIn.authUrl };
  }

  /** The browser came back from the sign-in page. Returns the connector's name. */
  async finishSignIn(state: string, code: string): Promise<string> {
    const signIn = this.signIns.get(state);
    if (!signIn || Date.now() - signIn.startedAt > SIGN_IN_TTL_MS) throw new Error('This sign-in has expired. Click Connect in TeamBot to start again.');
    this.signIns.delete(state);
    const connector = this.connector(signIn.name);
    const provider = new VaultAuth(this.vault, connector.name, signIn);
    const { auth } = await sdk();
    if ((await auth(provider, { serverUrl: connector.url, authorizationCode: code })) !== 'AUTHORIZED') throw new Error('The sign-in did not complete');
    await this.open(connector, provider);
    const server = this.servers.get(connector.name);
    if (!server?.client) throw new Error(server?.error ?? `Signed in, but ${connector.name} still refused the connection`);
    return connector.name;
  }

  /** At startup: reconnect with saved tokens. A sign-in that was never finished waits for the person to click Connect. */
  private async reconnect(connector: Connector) {
    const auth = new VaultAuth(this.vault, connector.name, { name: connector.name, state: '', redirectUrl: '', startedAt: 0 });
    const saved = auth.read();
    if (saved.client && !saved.tokens) {
      this.servers.set(connector.name, { source: 'connector', url: connector.url, tools: [], needsSignIn: true });
      return;
    }
    auth.signIn.redirectUrl = saved.redirectUrl ?? new URL(CONNECTOR_CALLBACK, this.defaultOrigin).toString();
    await this.open(connector, auth);
  }

  private async open(connector: Connector, auth: VaultAuth) {
    await this.servers.get(connector.name)?.client?.close().catch(() => undefined);
    const { Client, StreamableHTTPClientTransport, SSEClientTransport, UnauthorizedError } = await sdk();
    const url = new URL(connector.url);
    // Older servers speak SSE at a URL ending in /sse; everything else uses Streamable HTTP.
    const transport = /\/sse\/?$/.test(url.pathname) ? new SSEClientTransport(url, { authProvider: auth }) : new StreamableHTTPClientTransport(url, { authProvider: auth });
    const client = new Client({ name: 'teambot', version: '0.1.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.servers.set(connector.name, { source: 'connector', url: connector.url, client, tools: tools as McpToolInfo[] });
    } catch (err) {
      await client.close().catch(() => undefined);
      const needsSignIn = err instanceof UnauthorizedError || !!auth.signIn.authUrl;
      const error = needsSignIn ? undefined : connectError(err, connector.url);
      this.servers.set(connector.name, { source: 'connector', url: connector.url, tools: [], needsSignIn, error });
      if (error) console.error(`Connector "${connector.name}" failed to connect: ${error}`);
    }
  }

  /** The server stopped accepting our tokens and they could not be refreshed. */
  private async signedOut(name: string) {
    const server = this.servers.get(name);
    if (!server?.client) return;
    await server.client.close().catch(() => undefined);
    this.servers.set(name, { ...server, client: undefined, tools: [], needsSignIn: true });
    this.bus.emit('connector.updated', {}, { name, change: 'signed_out', servers: this.status() });
  }

  status(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      source: s.source,
      url: s.url,
      connected: !!s.client,
      tools: s.tools.length,
      needsSignIn: !!s.needsSignIn,
      error: s.error,
    }));
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  toolsFor(agent: Agent): ToolDef[] {
    const out: ToolDef[] = [];
    for (const [server, s] of this.servers) {
      if (!s.client) continue;
      if (!agent.mcpServers.includes(server) && !agent.mcpServers.includes('*')) continue;
      for (const tool of s.tools) {
        const client = s.client;
        out.push({
          name: `mcp__${server}__${safe(tool.name)}`.slice(0, 64),
          description: (tool.description ?? `${tool.name} from the ${server} MCP server`).slice(0, 1000),
          schema: z.record(z.string(), z.unknown()),
          parameters: { type: 'object', ...tool.inputSchema },
          risk: 'external',
          untrusted: true,
          summarize: () => `${server}: ${tool.name}`,
          execute: async (args, ctx) => {
            let result;
            try {
              result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal: ctx.signal, timeout: 120_000 });
            } catch (err) {
              if (s.source === 'connector' && err instanceof (await sdk()).UnauthorizedError) {
                await this.signedOut(server);
                throw new Error(`The ${server} connector needs a human to sign in again (Settings → Connectors).`);
              }
              throw err;
            }
            const parts = (result.content as { type: string; text?: string }[] | undefined) ?? [];
            const text = parts.map((p) => (p.type === 'text' ? p.text : `[${p.type} content]`)).join('\n');
            return result.isError ? `Error from ${server}: ${text}` : text || '(no output)';
          },
        });
      }
    }
    return out;
  }

  async stop() {
    await Promise.all([...this.servers.values()].map((s) => s.client?.close().catch(() => undefined)));
  }
}
