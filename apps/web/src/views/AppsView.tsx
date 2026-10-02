// Connect apps: everything agents use beyond their own computer, in one place — plugins (MCP connectors and
// mcp.json servers), chat apps (Telegram, Slack), skills and the shared folder.
import { BookOpen, CheckCircle2, FolderOpen, Plug, XCircle } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'wouter';
import { ConnectorSettings } from '../components/ConnectorSettings';
import { SlackSettings } from '../components/SlackSettings';
import { TelegramSettings } from '../components/TelegramSettings';
import { useStore } from '../store';
import { FilesView } from './FilesView';
import { SkillsView } from './SkillsView';

export type AppsTab = 'apps' | 'skills' | 'files';

function Apps() {
  const me = useStore((s) => s.me);
  const teamMode = useStore((s) => s.teamMode);
  const servers = useStore((s) => s.health?.mcpServers);
  const fileServers = useMemo(() => servers?.filter((m) => m.source === 'file') ?? [], [servers]);
  const canManage = !teamMode || me?.role === 'owner';
  return (
    <div className="page page-narrow">
      {/* Members can read these; only owners change them (the server enforces it too). */}
      <fieldset className="owner-only" disabled={!canManage}>
        {!canManage && <p className="small muted owner-note">Only the workspace owners can connect or remove apps.</p>}
        <ConnectorSettings />
        {fileServers.length > 0 && (
          <div className="section">
            <h2>From mcp.json</h2>
            <p className="muted small">
              MCP servers listed in <span className="mono">mcp.json</span> next to the server. Edit that file to change them.
            </p>
            <div className="list">
              {fileServers.map((s) => (
                <div key={s.name} className="list-row">
                  {s.connected ? <CheckCircle2 size={16} color="var(--ok)" /> : <XCircle size={16} color="var(--danger)" />}
                  <span className="grow">
                    <strong>{s.name}</strong> <span className="small muted">{s.connected ? `${s.tools} tools` : s.error}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <TelegramSettings />
        <SlackSettings />
      </fieldset>
    </div>
  );
}

export function AppsView({ tab, skill }: { tab: AppsTab; skill?: string }) {
  const skills = useStore((s) => s.skills.length);
  const plugins = useStore((s) => s.health?.mcpServers.length ?? 0);
  const tabs: [AppsTab, string, string, typeof Plug, number?][] = [
    ['apps', '/apps', 'Apps', Plug, plugins],
    ['skills', '/skills', 'Skills', BookOpen, skills],
    ['files', '/files', 'Files', FolderOpen],
  ];
  return (
    <div className="hub">
      <header className="hub-head">
        <h1>Connect apps</h1>
        <p className="muted">Plugins, skills and files your agents can use.</p>
        <nav className="pill-tabs" aria-label="Sections">
          {tabs.map(([key, href, label, Icon, count]) => (
            <Link key={key} href={href} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined}>
              <Icon size={14} /> {label}
              {!!count && <span className="tab-count">{count}</span>}
            </Link>
          ))}
        </nav>
      </header>
      {tab === 'apps' && <Apps />}
      {tab === 'skills' && <SkillsView name={skill} />}
      {tab === 'files' && <FilesView />}
    </div>
  );
}
