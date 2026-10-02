// What Connect apps needs to know about installed apps, and the actions that connect and remove them.
import { useEffect, useMemo, useState } from 'react';
import type { McpServerStatus, SlackStatus, TelegramStatus } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';
import { CATALOG, catalogEntryFor, type CatalogApp } from './catalog';

export type ConnectResult = { authUrl?: string; servers: McpServerStatus[] };

/** Installed MCP servers, split into the ones added from the catalog (by catalog id) and everything else. */
export function useInstalled() {
  const servers = useStore((s) => s.health?.mcpServers);
  return useMemo(() => {
    const fromCatalog = new Map<string, McpServerStatus>();
    const others: McpServerStatus[] = [];
    for (const s of servers ?? []) {
      const entry = s.source === 'connector' ? catalogEntryFor(s.url) : undefined;
      if (entry && !fromCatalog.has(entry.id)) fromCatalog.set(entry.id, s);
      else others.push(s);
    }
    return { servers: servers ?? [], fromCatalog, others, loaded: !!servers };
  }, [servers]);
}

/** Where an installed server's page is. */
export const serverHref = (s: McpServerStatus) => {
  const entry = s.source === 'connector' ? catalogEntryFor(s.url) : undefined;
  return entry ? `/apps/${entry.id}` : `/apps/mcp/${encodeURIComponent(s.name)}`;
};

export type AppState = 'connected' | 'sign-in' | 'error' | 'connecting' | 'none';

export function stateOf(s: McpServerStatus | undefined): AppState {
  if (!s) return 'none';
  if (s.connected) return 'connected';
  if (s.needsSignIn) return 'sign-in';
  if (s.error) return 'error';
  return 'connecting';
}

/** Telegram and Slack: only owners may read their status, so members see null. */
export function useBridges() {
  const version = useStore((s) => s.events.reduce((n, e) => (e.type.startsWith('bridge.') ? n + 1 : n), 0));
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [slack, setSlack] = useState<(SlackStatus & { manifest?: string }) | null>(null);
  useEffect(() => {
    api.get<TelegramStatus>('/bridges/telegram').then(setTelegram, () => setTelegram(null));
    api.get<SlackStatus & { manifest: string }>('/bridges/slack').then(setSlack, () => setSlack(null));
  }, [version]);
  return { telegram, setTelegram, slack, setSlack };
}

/** A free connector name for a catalog app: its id, or id-2, id-3… when that is taken. */
function freeName(id: string, servers: McpServerStatus[]) {
  const taken = new Set(servers.map((s) => s.name));
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) if (!taken.has(`${id.slice(0, 21)}-${n}`)) return `${id.slice(0, 21)}-${n}`;
}

const showServers = (servers: McpServerStatus[]) => useStore.setState((s) => (s.health ? { health: { ...s.health, mcpServers: servers } } : {}));

/**
 * Connecting, signing in and removing. A sign-in page opens in a new tab: the tab is opened during the click (so
 * the browser doesn't block it) and then sent to the sign-in page, or closed when none was needed. When the browser
 * blocks it anyway, `blocked` holds the link to offer instead.
 */
export function useConnector() {
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ name: string; url: string } | null>(null);

  async function run(name: string, label: string, signIn: boolean, request: () => Promise<ConnectResult>): Promise<McpServerStatus | undefined> {
    setBusy(name);
    setBlocked(null);
    const tab = signIn ? window.open('', '_blank') : null;
    try {
      const { authUrl, servers } = await request();
      showServers(servers);
      const s = servers.find((x) => x.name === name);
      if (authUrl) {
        if (tab) {
          tab.location.href = authUrl;
          notify(`Sign in to ${label} in the new tab`);
        } else setBlocked({ name, url: authUrl });
      } else {
        tab?.close();
        if (s?.connected) notify(`${label} is connected. Choose which agents can use it.`);
        else notify(s?.error ?? `${label} could not connect`, 'error');
      }
      return s;
    } catch (err) {
      tab?.close();
      notify((err as Error).message, 'error');
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const origin = window.location.origin;
  return {
    busy,
    blocked,
    clearBlocked: () => setBlocked(null),
    /** Adds a catalog app. Token apps need the token. */
    add(app: CatalogApp, servers: McpServerStatus[], token?: string) {
      const name = freeName(app.id, servers);
      const auth = app.token && token ? { header: app.token.header, prefix: app.token.prefix, value: token } : undefined;
      return run(name, app.name, app.auth === 'oauth', () => api.post<ConnectResult>('/connectors', { name, url: app.url, origin, token: auth }));
    },
    addCustom(name: string, url: string, token?: { header: string; prefix: string; value: string }) {
      return run(name, name, !token, () => api.post<ConnectResult>('/connectors', { name, url, origin, token }));
    },
    reconnect(s: McpServerStatus, label: string) {
      return run(s.name, label, !s.usesToken, () => api.post<ConnectResult>(`/connectors/${s.name}/connect`, { origin }));
    },
    setToken(s: McpServerStatus, label: string, value: string) {
      return run(s.name, label, false, () => api.put<ConnectResult>(`/connectors/${s.name}/token`, { value }));
    },
    async remove(s: McpServerStatus, label: string) {
      if (!confirm(`Remove ${label}? Agents lose its tools and its sign-in is deleted.`)) return false;
      try {
        showServers(await api.del<McpServerStatus[]>(`/connectors/${s.name}`));
        notify(`${label} removed`);
        return true;
      } catch (err) {
        notify((err as Error).message, 'error');
        return false;
      }
    },
  };
}

/** Catalog entries by id, for routes. */
export const catalogApp = (id: string) => CATALOG.find((a) => a.id === id);
