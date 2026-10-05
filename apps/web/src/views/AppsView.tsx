// Connect apps: a marketplace of the apps agents can use (vendors' remote MCP servers, and the Telegram and Slack
// chat apps), what is installed, and a page per app with its sign-in and the agents allowed to use it.
// Skills and the shared folder are the other sections of the same frame.
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, MoreHorizontal, Plug, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { Agent, McpServerStatus, McpToolSummary } from '@teambot/shared';
import { api } from '../api';
import { AppTile } from '../components/AppTile';
import { Avatar } from '../components/Avatar';
import { MenuButton, MenuItem } from '../components/Menu';
import { Switch } from '../components/panel/PanelPage';
import { SettingGroup, SettingRow, SettingsHeader, SettingsPage, SettingsShell, type Section } from '../components/settings/SettingsShell';
import { SlackSettings } from '../components/SlackSettings';
import { TelegramSettings } from '../components/TelegramSettings';
import { catalogApp, serverHref, stateOf, useBridges, useConnector, useInstalled, type AppState } from '../lib/apps';
import { CATALOG, CATEGORIES, CHAT_APPS, catalogEntryFor, searchApps, type CatalogApp, type ChatAppId } from '../lib/catalog';
import { useStore } from '../store';
import { ComponentsView } from './ComponentsView';
import { FilesView } from './FilesView';
import { SkillsView } from './SkillsView';

/** Members in team mode can look around; only owners connect, remove or hand out apps (the server enforces it too). */
function useCanManage() {
  const teamMode = useStore((s) => s.teamMode);
  const role = useStore((s) => s.me?.role);
  return !teamMode || role === 'owner';
}

const STATE_TEXT: Record<Exclude<AppState, 'none'>, string> = { connected: 'Connected', 'sign-in': 'Needs sign-in', error: "Can't connect", connecting: 'Connecting…' };

function StateLabel({ state, usesToken }: { state: AppState; usesToken?: boolean }) {
  if (state === 'none') return null;
  const text = state === 'sign-in' && usesToken ? 'Needs a token' : STATE_TEXT[state];
  return <span className={`app-state ${state}`}>{text}</span>;
}

/** One app in a list: tile, name and one line, opening its page, with the quickest action on the right. */
function AppRow({ href, tile, name, line, action }: { href: string; tile: ReactNode; name: string; line: ReactNode; action?: ReactNode }) {
  return (
    <div className="app-row">
      <Link href={href} className="app-row-link">
        {tile}
        <span className="app-row-text">
          <strong className="ellipsis">{name}</strong>
          <span className="ellipsis">{line}</span>
        </span>
      </Link>
      {action && <div className="app-row-action">{action}</div>}
    </div>
  );
}

function CatalogRow({ app, server, connector }: { app: CatalogApp; server?: McpServerStatus; connector: ReturnType<typeof useConnector> }) {
  const [, navigate] = useLocation();
  const servers = useStore((s) => s.health?.mcpServers ?? []);
  const canManage = useCanManage();
  const state = stateOf(server);
  let action: ReactNode = <StateLabel state={state} usesToken={server?.usesToken} />;
  if (state === 'none' && canManage) {
    action =
      app.auth === 'token' ? (
        <Link href={`/apps/${app.id}`} className="btn sm pill">
          Set up
        </Link>
      ) : (
        <button
          className="btn sm pill"
          disabled={connector.busy !== null}
          onClick={() => {
            void connector.add(app, servers);
            navigate(`/apps/${app.id}`);
          }}
        >
          {app.auth === 'none' ? 'Add' : 'Connect'}
        </button>
      );
  }
  return <AppRow href={`/apps/${app.id}`} tile={<AppTile name={app.name} color={app.color} />} name={app.name} line={app.blurb} action={action} />;
}

function ChatAppRow({ id, configured }: { id: ChatAppId; configured: boolean | null }) {
  const app = CHAT_APPS.find((a) => a.id === id)!;
  return (
    <AppRow
      href={`/apps/${id}`}
      tile={<AppTile name={app.name} color={app.color} />}
      name={app.name}
      line={app.blurb}
      action={configured ? <span className="app-state connected">Connected</span> : configured === false ? <Link href={`/apps/${id}`} className="btn sm pill">Set up</Link> : undefined}
    />
  );
}

/** The catalog entry a server came from, when it did. */
const entryOf = (s: McpServerStatus) => (s.source === 'connector' ? catalogEntryFor(s.url) : undefined);

/** "3 installed ›", with the first few tiles stacked. */
function InstalledLink({ telegram, slack }: { telegram: boolean; slack: boolean }) {
  const { servers } = useInstalled();
  const tiles: { key: string; name: string; color?: string }[] = [
    ...servers.map((s) => {
      const app = entryOf(s);
      return { key: s.name, name: app?.name ?? s.name, color: app?.color };
    }),
    ...CHAT_APPS.filter((a) => (a.id === 'telegram' ? telegram : slack)).map((a) => ({ key: a.id, name: a.name, color: a.color })),
  ];
  return (
    <Link href="/apps/installed" className="installed-link">
      {tiles.length > 0 && (
        <span className="tile-stack" aria-hidden="true">
          {tiles.slice(0, 4).map((t) => (
            <AppTile key={t.key} name={t.name} color={t.color} icon={t.color ? undefined : <Plug size={11} />} size={22} />
          ))}
        </span>
      )}
      {tiles.length ? `${tiles.length} installed` : 'Nothing installed'}
      <ChevronRight size={15} />
    </Link>
  );
}

function AppGrid({ children }: { children: ReactNode }) {
  return <div className="app-grid">{children}</div>;
}

function Category({ title, apps, render }: { title: string; apps: CatalogApp[]; render: (a: CatalogApp) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? apps : apps.slice(0, 4);
  return (
    <SettingGroup
      title={title}
      actions={
        apps.length > 4 && (
          <button className="link-btn" onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? 'Show fewer' : `Show all ${apps.length}`}
          </button>
        )
      }
    >
      <AppGrid>{shown.map(render)}</AppGrid>
    </SettingGroup>
  );
}

function SignInBlocked({ connector }: { connector: ReturnType<typeof useConnector> }) {
  if (!connector.blocked) return null;
  return (
    <div className="banner app-banner" role="status">
      <span className="grow">
        Your browser blocked the sign-in tab.{' '}
        <a href={connector.blocked.url} target="_blank" rel="noreferrer noopener" onClick={connector.clearBlocked}>
          Open the {connector.blocked.name} sign-in page
        </a>
      </span>
    </div>
  );
}

function Marketplace() {
  const [query, setQuery] = useState('');
  const { fromCatalog } = useInstalled();
  const { telegram, slack } = useBridges();
  const connector = useConnector();
  const results = useMemo(() => searchApps(query), [query]);
  const row = (app: CatalogApp) => <CatalogRow key={app.id} app={app} server={fromCatalog.get(app.id)} connector={connector} />;
  const chatMatches = CHAT_APPS.filter((a) => !query.trim() || `${a.name} ${a.blurb}`.toLowerCase().includes(query.trim().toLowerCase()));
  const configured = (id: ChatAppId) => {
    const s = id === 'telegram' ? telegram : slack;
    return s ? s.configured : null;
  };

  return (
    <SettingsPage wide>
      <SettingsHeader
        title="Connect apps"
        intro="Give your agents the apps your team works in. You sign in once and agents never see the sign-in; an agent gets an app only when you allow it, and every call passes your action policy."
        actions={<InstalledLink telegram={!!telegram?.configured} slack={!!slack?.configured} />}
      />
      <label className="market-search">
        <Search size={17} aria-hidden="true" />
        <input type="search" placeholder="Search apps" aria-label="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <SignInBlocked connector={connector} />
      {query.trim() ? (
        <SettingGroup title={results.length + chatMatches.length ? 'Results' : undefined}>
          {results.length + chatMatches.length > 0 ? (
            <AppGrid>
              {chatMatches.map((a) => (
                <ChatAppRow key={a.id} id={a.id} configured={configured(a.id)} />
              ))}
              {results.map(row)}
            </AppGrid>
          ) : (
            <div className="market-empty">
              No app matches “{query.trim()}”. If it has an MCP server, you can <Link href="/apps/custom">add it by its address</Link>.
            </div>
          )}
        </SettingGroup>
      ) : (
        <>
          <SettingGroup title="Featured">
            <AppGrid>{CATALOG.filter((a) => a.featured).map(row)}</AppGrid>
          </SettingGroup>
          <SettingGroup title="Chat apps" description="Not tools for agents: these bring your conversations and approvals to your phone.">
            <AppGrid>
              {CHAT_APPS.map((a) => (
                <ChatAppRow key={a.id} id={a.id} configured={configured(a.id)} />
              ))}
            </AppGrid>
          </SettingGroup>
          {CATEGORIES.map((c) => (
            <Category key={c.key} title={c.label} apps={CATALOG.filter((a) => a.category === c.key)} render={row} />
          ))}
        </>
      )}
      <Link href="/apps/custom" className="custom-app-link">
        <AppTile name="Custom" icon={<Plus size={18} />} />
        <span className="grow">
          <strong>Add a custom app</strong>
          <span>Any MCP server with an https address, including your own.</span>
        </span>
        <ChevronRight size={16} className="faint" />
      </Link>
    </SettingsPage>
  );
}

function Installed() {
  const { servers, loaded } = useInstalled();
  const { telegram, slack } = useBridges();
  const skills = useStore((s) => s.skills);
  const agents = useStore((s) => s.agents);
  const users = (name: string) => agents.filter((a) => a.mcpServers.includes(name) || a.mcpServers.includes('*')).length;

  const rows = servers.map((s) => {
    const app = entryOf(s);
    const state = stateOf(s);
    const n = users(s.name);
    const line = s.connected ? `${s.tools} tools · ${n ? `${n} agent${n === 1 ? '' : 's'}` : 'no agent yet'}` : s.source === 'file' ? 'From mcp.json' : (s.url ?? '');
    return (
      <AppRow
        key={s.name}
        href={serverHref(s)}
        tile={app ? <AppTile name={app.name} color={app.color} /> : <AppTile name={s.name} icon={<Plug size={17} />} />}
        name={app?.name ?? s.name}
        line={line}
        action={<StateLabel state={state} usesToken={s.usesToken} />}
      />
    );
  });
  const chats = CHAT_APPS.filter((a) => (a.id === 'telegram' ? telegram : slack)?.configured);
  const empty = loaded && !rows.length && !chats.length;

  return (
    <SettingsPage wide>
      <SettingsHeader
        title="Installed"
        intro="The apps agents can be given, and the skills they follow."
        actions={
          <Link href="/apps" className="btn">
            Browse apps
          </Link>
        }
      />
      <SettingGroup title="Apps">
        {empty ? (
          <div className="market-empty">
            Nothing yet. <Link href="/apps">Browse the marketplace</Link> to connect Notion, GitHub, Linear and more.
          </div>
        ) : (
          <AppGrid>
            {rows}
            {chats.map((a) => (
              <ChatAppRow key={a.id} id={a.id} configured />
            ))}
          </AppGrid>
        )}
      </SettingGroup>
      <SettingGroup
        title="Skills"
        actions={
          <Link href="/skills" className="link-btn">
            Manage skills
          </Link>
        }
      >
        {skills.length ? (
          <AppGrid>
            {skills.map((s) => (
              <AppRow key={s.name} href={`/skills/${s.name}`} tile={<AppTile name={s.name} icon={<BookOpen size={17} />} />} name={s.name} line={s.error ?? s.description} />
            ))}
          </AppGrid>
        ) : (
          <div className="market-empty">
            No skills yet. <Link href="/skills">Write one</Link>: how your team does a recurring job, once, for every agent to follow.
          </div>
        )}
      </SettingGroup>
    </SettingsPage>
  );
}

function BackLink({ href = '/apps', label = 'Connect apps' }: { href?: string; label?: string }) {
  return (
    <Link href={href} className="back-link">
      <ChevronLeft size={15} /> {label}
    </Link>
  );
}

/** The app page's header: big tile, name, where it comes from, its state and its main action. */
function AppHead({ tile, name, sub, state, actions }: { tile: ReactNode; name: string; sub: ReactNode; state?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="app-head">
      {tile}
      <div className="grow" style={{ minWidth: 0 }}>
        <h1 className="ellipsis">{name}</h1>
        <div className="app-head-sub">{sub}</div>
        {state && <div className="app-head-state">{state}</div>}
      </div>
      {actions && <div className="app-head-actions">{actions}</div>}
    </div>
  );
}

/** A switch per agent for using this app. */
function AgentAccess({ name, label }: { name: string; label: string }) {
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  const canManage = useCanManage();

  async function set(agent: Agent, on: boolean) {
    const mcpServers = on ? [...agent.mcpServers, name] : agent.mcpServers.filter((x) => x !== name);
    try {
      await api.patch(`/agents/${agent.id}`, { mcpServers });
      notify(on ? `${agent.name} can use ${label}` : `${agent.name} can't use ${label} any more`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <SettingGroup title="Agents with access" description="An agent gets this app's tools only when it is on here. Every call still passes your action policy, which asks you first by default.">
      {agents.map((a) => {
        const all = a.mcpServers.includes('*');
        return (
          <SettingRow key={a.id} lead={<Avatar member={a} size={30} />} title={a.name} description={all ? 'Has every app' : a.role}>
            <Switch checked={all || a.mcpServers.includes(name)} onChange={(on) => void set(a, on)} label={`${a.name} can use ${label}`} disabled={!canManage || all} />
          </SettingRow>
        );
      })}
      {!agents.length && <SettingRow title="No agents yet" description={<><Link href="/new">Create an agent</Link>, then come back to let it use {label}.</>} />}
    </SettingGroup>
  );
}

function ToolList({ server }: { server: McpServerStatus }) {
  const [tools, setTools] = useState<McpToolSummary[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!server.connected) return setTools(null);
    api.get<McpToolSummary[]>(`/mcp-servers/${encodeURIComponent(server.name)}/tools`).then(setTools, () => setTools(null));
  }, [server.name, server.connected, server.tools]);
  if (!tools?.length) return null;
  const shown = all ? tools : tools.slice(0, 8);
  return (
    <SettingGroup
      title={`What agents can do (${tools.length} tools)`}
      actions={
        tools.length > 8 && (
          <button className="link-btn" onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? 'Show fewer' : `Show all ${tools.length}`}
          </button>
        )
      }
    >
      {shown.map((t) => (
        <SettingRow key={t.name} title={<span className="mono tool-name">{t.name}</span>} description={t.description && <span className="tool-desc">{t.description}</span>} />
      ))}
    </SettingGroup>
  );
}

function TokenForm({ label, help, helpUrl, busy, onSubmit, cta }: { label: string; help: string; helpUrl?: string; busy: boolean; onSubmit: (token: string) => Promise<unknown>; cta: string }) {
  const [token, setToken] = useState('');
  return (
    <SettingRow
      title={label}
      description={
        <>
          {help} Stored encrypted; agents never see it.{' '}
          {helpUrl && (
            <a href={helpUrl} target="_blank" rel="noreferrer noopener" className="nowrap">
              Create a token <ExternalLink size={12} />
            </a>
          )}
        </>
      }
      below={
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!token.trim()) return;
            await onSubmit(token.trim());
            setToken('');
          }}
        >
          <input className="input mono grow" type="password" autoComplete="off" placeholder="Paste the token" aria-label={label} value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn primary" disabled={!token.trim() || busy}>
            {busy ? 'Connecting…' : cta}
          </button>
        </form>
      }
    />
  );
}

/** A catalog app or an installed server that isn't in the catalog. */
function AppPage({ app, server }: { app?: CatalogApp; server?: McpServerStatus }) {
  const [, navigate] = useLocation();
  const servers = useStore((s) => s.health?.mcpServers ?? []);
  const connector = useConnector();
  const canManage = useCanManage();
  const state = stateOf(server);
  const label = app?.name ?? server?.name ?? '';
  const busy = connector.busy !== null;
  const usesToken = server ? !!server.usesToken : app?.auth === 'token';
  const file = server?.source === 'file';

  let primary: ReactNode = null;
  if (canManage && !file) {
    if (state === 'none' && app && app.auth !== 'token')
      primary = (
        <button className="btn primary pill" disabled={busy} onClick={() => void connector.add(app, servers)}>
          {busy ? 'Connecting…' : app.auth === 'none' ? 'Add' : 'Connect'}
        </button>
      );
    else if (server && !usesToken && (state === 'sign-in' || state === 'error'))
      primary = (
        <button className="btn primary pill" disabled={busy} onClick={() => void connector.reconnect(server, label)}>
          {busy ? 'Connecting…' : state === 'sign-in' ? 'Sign in' : 'Try again'}
        </button>
      );
  }

  const menu = canManage && server && !file && (
    <MenuButton label={`More for ${label}`} trigger={<MoreHorizontal size={18} />} className="btn icon pill">
      {!usesToken && server.connected && (
        <MenuItem onSelect={() => void connector.reconnect(server, label)}>
          <Plug size={14} className="faint" /> Sign in again
        </MenuItem>
      )}
      <MenuItem danger onSelect={async () => (await connector.remove(server, label)) && navigate(app ? `/apps/${app.id}` : '/apps/installed')}>
        <Trash2 size={14} /> Remove
      </MenuItem>
    </MenuButton>
  );

  const stateLine = server && (
    <>
      <StateLabel state={state} usesToken={server.usesToken} />
      {server.connected && <span className="muted"> · {server.tools} tools</span>}
      {server.error && !server.connected && <div className="error-text">{server.error}</div>}
    </>
  );

  const signIn = file
    ? <>Set in <span className="mono">mcp.json</span> next to the server. Edit that file to change or remove it.</>
    : usesToken
      ? 'A token you paste, kept encrypted as a reserved secret and sent with every request.'
      : app?.auth === 'none'
        ? 'None needed.'
        : 'Through its own sign-in page, in a new tab. TeamBot keeps the sign-in encrypted, refreshes it, and agents never see it.';

  return (
    <SettingsPage>
      <BackLink href={app ? '/apps' : '/apps/installed'} label={app ? 'Connect apps' : 'Installed'} />
      <AppHead
        tile={app ? <AppTile name={app.name} color={app.color} size={56} /> : <AppTile name={label} icon={<Plug size={24} />} size={56} />}
        name={label}
        sub={
          app ? (
            <>
              {CATEGORIES.find((c) => c.key === app.category)?.label} ·{' '}
              <a href={app.website} target="_blank" rel="noreferrer noopener">
                {new URL(app.website).host.replace(/^www\./, '')}
              </a>
            </>
          ) : file ? (
            'MCP server from mcp.json'
          ) : (
            'Custom app'
          )
        }
        state={stateLine}
        actions={
          <>
            {primary}
            {menu}
          </>
        }
      />
      <SignInBlocked connector={connector} />
      {app && <p className="app-about">{app.about}</p>}
      {canManage && usesToken && state !== 'connected' && (
        <SettingGroup title={server ? 'Token' : 'Set up'}>
          <TokenForm
            label={app?.token?.label ?? 'Token'}
            help={app?.token?.help ?? `Paste a new token for ${label}.`}
            helpUrl={app?.token?.helpUrl}
            busy={busy}
            cta={server ? 'Save and connect' : 'Connect'}
            onSubmit={(token) => (server ? connector.setToken(server, label, token) : connector.add(app!, servers, token))}
          />
        </SettingGroup>
      )}
      {server && <AgentAccess name={server.name} label={label} />}
      {server && <ToolList server={server} />}
      <SettingGroup title="Details">
        <SettingRow title="Sign-in" description={signIn} />
        {(server?.url ?? app?.url) && <SettingRow title="Address" description={<span className="mono break">{server?.url ?? app?.url}</span>} />}
        <SettingRow title="Tool names" description={<span className="mono">mcp__{server?.name ?? app?.id}__…</span>} />
        {app?.registry && <SettingRow title="MCP Registry entry" description={<span className="mono">{app.registry}</span>} />}
      </SettingGroup>
    </SettingsPage>
  );
}

function ChatAppPage({ id }: { id: ChatAppId }) {
  const app = CHAT_APPS.find((a) => a.id === id)!;
  const { telegram, setTelegram, slack, setSlack } = useBridges();
  const canManage = useCanManage();
  const status = id === 'telegram' ? telegram : slack;
  return (
    <SettingsPage>
      <BackLink />
      <AppHead
        tile={<AppTile name={app.name} color={app.color} size={56} />}
        name={app.name}
        sub="Chat app"
        state={status && <>{status.configured ? <span className="app-state connected">Connected</span> : <span className="muted">Not set up</span>}{status.error && <div className="error-text">{status.error}</div>}</>}
      />
      <p className="app-about">
        {id === 'telegram'
          ? 'Get approval requests with Approve and Deny buttons, and your agents’ messages to you, on your phone. Reply to continue a conversation, or start a message with @Name to talk to an agent.'
          : 'The same as Telegram, in your DMs with a TeamBot app in Slack: approvals with buttons, your agents’ messages to you, and replies in threads.'}
      </p>
      {!canManage || !status ? (
        <p className="small muted">Only the workspace owners can set up chat apps.</p>
      ) : id === 'telegram' && telegram ? (
        <TelegramSettings status={telegram} onChange={setTelegram} />
      ) : slack ? (
        <SlackSettings status={slack} onChange={setSlack} />
      ) : null}
    </SettingsPage>
  );
}

function CustomAppPage() {
  const [, navigate] = useLocation();
  const canManage = useCanManage();
  const connector = useConnector();
  const [form, setForm] = useState({ name: '', url: '', auth: 'auto' as 'auto' | 'token', header: 'Authorization', prefix: 'Bearer ', token: '' });
  const name = form.name.trim().toLowerCase();
  const ready = name && form.url.trim() && (form.auth === 'auto' || (form.header.trim() && form.token.trim()));

  async function add() {
    const token = form.auth === 'token' ? { header: form.header.trim(), prefix: form.prefix, value: form.token.trim() } : undefined;
    const s = await connector.addCustom(name, form.url.trim(), token);
    if (s) navigate(serverHref(s));
  }

  return (
    <SettingsPage>
      <BackLink />
      <AppHead tile={<AppTile name="Custom" icon={<Plus size={24} />} size={56} />} name="Add a custom app" sub="Any remote MCP server" />
      <p className="app-about">
        For an app that isn't listed, or your own server: TeamBot connects to its address (Streamable HTTP, or SSE at an address ending in <span className="mono">/sse</span>) and signs in with
        OAuth when the server asks for it. Some servers take an API key instead; choose “Token” for those.
      </p>
      <SignInBlocked connector={connector} />
      <fieldset className="owner-only" disabled={!canManage}>
        {!canManage && <p className="small muted owner-note">Only the workspace owners can add apps.</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void add();
          }}
        >
          <SettingGroup>
            <SettingRow title="Name" description={<>Lower-case, up to 24 characters. Its tools are named <span className="mono">mcp__{name || 'name'}__…</span></>}>
              <input className="input mono setting-input" placeholder="crm" aria-label="App name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24) })} />
            </SettingRow>
            <SettingRow
              title="Address"
              description="Its MCP endpoint, starting with https:// (http:// only on this computer)."
              below={<input className="input mono" placeholder="https://mcp.example.com/mcp" aria-label="MCP server address" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />}
            />
            <SettingRow title="Sign-in" description={form.auth === 'auto' ? 'OAuth in a new tab if the server asks for it, otherwise none.' : 'A token you paste, sent in a header with every request.'}>
              <div className="segmented" role="group" aria-label="Sign-in">
                <button type="button" aria-pressed={form.auth === 'auto'} onClick={() => setForm({ ...form, auth: 'auto' })}>
                  Automatic
                </button>
                <button type="button" aria-pressed={form.auth === 'token'} onClick={() => setForm({ ...form, auth: 'token' })}>
                  Token
                </button>
              </div>
            </SettingRow>
            {form.auth === 'token' && (
              <SettingRow
                title="Token"
                description="Stored encrypted as a reserved secret; agents never see it."
                below={
                  <div className="row wrap">
                    <input className="input mono" style={{ flex: '0 1 160px' }} aria-label="Header" placeholder="Authorization" value={form.header} onChange={(e) => setForm({ ...form, header: e.target.value })} />
                    <input className="input mono" style={{ flex: '0 1 100px' }} aria-label="Prefix" placeholder="Bearer " value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} />
                    <input className="input mono" style={{ flex: '1 1 200px' }} type="password" autoComplete="off" aria-label="Token" placeholder="Paste the token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
                  </div>
                }
              />
            )}
          </SettingGroup>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary pill" disabled={!ready || connector.busy !== null}>
              {connector.busy ? 'Connecting…' : 'Add and connect'}
            </button>
          </div>
        </form>
      </fieldset>
    </SettingsPage>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <SettingsPage>
      <BackLink />
      <p className="muted">{what} isn't installed or in the marketplace.</p>
    </SettingsPage>
  );
}

export type AppsPage =
  | { kind: 'browse' }
  | { kind: 'installed' }
  | { kind: 'custom' }
  | { kind: 'app'; id: string }
  | { kind: 'server'; name: string }
  | { kind: 'skills'; skill?: string; draft?: string }
  | { kind: 'components'; name?: string }
  | { kind: 'files' };

export function AppsView({ page }: { page: AppsPage }) {
  const { servers, fromCatalog, loaded } = useInstalled();
  let active: Section = 'apps';
  let body: ReactNode;
  switch (page.kind) {
    case 'browse':
      body = <Marketplace />;
      break;
    case 'installed':
      active = 'installed';
      body = <Installed />;
      break;
    case 'custom':
      body = <CustomAppPage />;
      break;
    case 'app': {
      if (page.id === 'telegram' || page.id === 'slack') {
        body = <ChatAppPage id={page.id} />;
        break;
      }
      const app = catalogApp(page.id);
      body = app ? <AppPage key={app.id} app={app} server={fromCatalog.get(app.id)} /> : <NotFound what={`“${page.id}”`} />;
      break;
    }
    case 'server': {
      active = 'installed';
      const server = servers.find((s) => s.name === page.name);
      body = server ? <AppPage key={server.name} server={server} /> : loaded ? <NotFound what={`“${page.name}”`} /> : null;
      break;
    }
    case 'skills':
      return (
        <SettingsShell active="skills" fill>
          <SkillsView name={page.skill} draft={page.draft} />
        </SettingsShell>
      );
    case 'components':
      return (
        <SettingsShell active="components" fill>
          <ComponentsView name={page.name} />
        </SettingsShell>
      );
    case 'files':
      return (
        <SettingsShell active="files" fill>
          <FilesView />
        </SettingsShell>
      );
  }
  return <SettingsShell active={active}>{body}</SettingsShell>;
}
