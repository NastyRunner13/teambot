// Settings → Connectors: remote MCP servers (Notion, Linear, …) added by URL, with OAuth sign-in in a new tab.
import { Plug } from 'lucide-react';
import { useState } from 'react';
import type { McpServerStatus } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';

const PRESETS = [
  { name: 'notion', label: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'sentry', label: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'supabase', label: 'Supabase', url: 'https://mcp.supabase.com/mcp' },
];

type ConnectResult = { authUrl?: string; servers: McpServerStatus[] };

function statusText(s: McpServerStatus) {
  if (s.connected) return <span className="badge ok">connected · {s.tools} tools</span>;
  if (s.needsSignIn) return <span className="badge warn">needs sign-in</span>;
  if (s.error) return <span className="badge danger" title={s.error}>can't connect</span>;
  return <span className="badge">not connected</span>;
}

export function ConnectorSettings() {
  const notify = useStore((s) => s.notify);
  const servers = useStore((s) => s.health?.mcpServers);
  const [form, setForm] = useState({ name: '', url: '' });
  const [busy, setBusy] = useState<string | null>(null);
  // A sign-in page the browser refused to open as a pop-up, offered as a link instead.
  const [pending, setPending] = useState<{ name: string; url: string } | null>(null);

  const connectors = (servers ?? []).filter((s) => s.source === 'connector');

  /** The tab is opened during the click (so it isn't blocked), then sent to the sign-in page or closed. */
  async function connect(name: string, request: () => Promise<ConnectResult>) {
    setBusy(name);
    const tab = window.open('', '_blank');
    try {
      const { authUrl, servers: next } = await request();
      const s = next.find((x) => x.name === name);
      if (authUrl) {
        if (tab) {
          tab.location.href = authUrl;
          notify(`Sign in to ${name} in the new tab`);
        } else setPending({ name, url: authUrl });
      } else {
        tab?.close();
        if (s?.connected) notify(`${name} is connected`);
        else notify(s?.error ?? `${name} could not connect`, 'error');
      }
      return true;
    } catch (err) {
      tab?.close();
      notify((err as Error).message, 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const name = form.name.trim().toLowerCase();
    if (await connect(name, () => api.post<ConnectResult>('/connectors', { name, url: form.url.trim(), origin: window.location.origin }))) setForm({ name: '', url: '' });
  }

  async function remove(name: string) {
    if (!confirm(`Remove the ${name} connector? Agents lose its tools and its sign-in is deleted.`)) return;
    try {
      await api.del(`/connectors/${name}`);
      notify(`${name} removed`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  if (!servers) return null;
  return (
    <div className="section">
      <h2>Connectors</h2>
      <p className="muted small">
        Connect the apps your team works in through their MCP servers. You sign in once in your browser; the sign-in is stored encrypted and agents never see it. An agent gets a
        connector's tools when you tick it in the agent's Customize page, and every call passes your action policy (by default, it asks you first).
      </p>
      {connectors.length > 0 && (
        <div className="list" style={{ marginBottom: 12 }}>
          {connectors.map((s) => (
            <div key={s.name} className="list-row">
              <Plug size={15} className="faint" />
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{s.name}</strong> {statusText(s)}
                <div className="small muted mono ellipsis">{s.url}</div>
                {s.error && !s.connected && <div className="small error-text">{s.error}</div>}
                {pending?.name === s.name && !s.connected && (
                  <div className="small">
                    Your browser blocked the sign-in tab.{' '}
                    <a href={pending.url} target="_blank" rel="noreferrer noopener" onClick={() => setPending(null)}>
                      Open the {s.name} sign-in page
                    </a>
                  </div>
                )}
              </span>
              <button
                className={`btn sm ${s.connected ? '' : 'primary'}`}
                disabled={busy === s.name}
                onClick={() => connect(s.name, () => api.post<ConnectResult>(`/connectors/${s.name}/connect`, { origin: window.location.origin }))}
              >
                {busy === s.name ? 'Connecting…' : s.connected ? 'Reconnect' : s.needsSignIn ? 'Sign in' : 'Connect'}
              </button>
              <button className="btn sm ghost danger" onClick={() => remove(s.name)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        {PRESETS.filter((p) => !servers.some((s) => s.name === p.name)).map((p) => (
          <button key={p.name} className="btn sm" onClick={() => setForm({ name: p.name, url: p.url })}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="row wrap">
        <input className="input" style={{ flex: '0 1 140px', minWidth: 100 }} placeholder="name" aria-label="Connector name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })} />
        <input className="input mono" style={{ flex: '1 1 240px', minWidth: 0 }} placeholder="https://mcp.example.com/mcp" aria-label="MCP server URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <button className="btn primary" disabled={!form.name.trim() || !form.url.trim() || busy !== null} onClick={add}>
          {busy && busy === form.name.trim().toLowerCase() ? 'Connecting…' : 'Add and connect'}
        </button>
      </div>
    </div>
  );
}
