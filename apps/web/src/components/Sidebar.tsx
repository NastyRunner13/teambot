// The conversation list: every agent and group chat, newest first, with your profile and the apps hub below.
import { BookOpen, FolderOpen, LogOut, Monitor, Moon, PanelLeft, Pause, Play, Plug, Plus, Search, Settings, Sun } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { api } from '../api';
import { previewOf, useConversations } from '../lib/conversations';
import { useTheme } from '../lib/theme';
import { memberName, useStore } from '../store';
import { Avatar, GroupAvatar } from './Avatar';
import { MenuButton, MenuItem, MenuLabel, MenuSeparator } from './Menu';

function ProfileMenu() {
  const me = useStore((s) => s.me);
  const teamMode = useStore((s) => s.teamMode);
  const pausedAll = useStore((s) => s.pausedAll);
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [theme, setTheme] = useTheme();

  async function togglePauseAll() {
    try {
      await api.post(pausedAll ? '/system/resume' : '/system/pause');
      notify(pausedAll ? 'All agents resumed' : 'All agents paused');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  async function signOut() {
    await api.post('/auth/sign-out').catch(() => undefined);
    window.location.replace('/');
  }

  return (
    <MenuButton label="Your profile and settings" align="start" className={`profile-button ${pausedAll ? 'paused' : ''}`} trigger={<Avatar member={me ?? undefined} size={34} />}>
      <div className="menu-profile">
        <Avatar member={me ?? undefined} size={36} />
        <div className="grow" style={{ minWidth: 0 }}>
          <strong className="ellipsis">{me?.name}</strong>
          <span>{teamMode ? 'Team workspace' : 'Personal workspace'}</span>
        </div>
      </div>
      <MenuSeparator />
      <MenuItem onSelect={() => navigate('/settings')}>
        <Settings size={15} className="faint" /> Settings
      </MenuItem>
      <MenuItem onSelect={() => navigate('/apps')}>
        <Plug size={15} className="faint" /> Connect apps
      </MenuItem>
      <MenuItem onSelect={() => void togglePauseAll()}>
        {pausedAll ? <Play size={15} className="faint" /> : <Pause size={15} className="faint" />} {pausedAll ? 'Resume all agents' : 'Pause all agents'}
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Appearance</MenuLabel>
      <div className="segmented menu-theme" role="group" aria-label="Appearance">
        {([['dark', 'Dark', Moon], ['light', 'Light', Sun], ['system', 'Auto', Monitor]] as const).map(([value, label, Icon]) => (
          <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>
      {teamMode && (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => void signOut()}>
            <LogOut size={15} className="faint" /> Sign out
          </MenuItem>
        </>
      )}
    </MenuButton>
  );
}

export function Sidebar() {
  const [location] = useLocation();
  const me = useStore((s) => s.me);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const pausedAll = useStore((s) => s.pausedAll);
  const conversations = useConversations();
  const is = (path: string) => location === path || location.startsWith(`${path}/`) || location.startsWith(`${path}?`);
  const inApps = is('/apps') || is('/skills') || is('/files');

  return (
    <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} id="workspace-navigation" aria-label="Workspace">
      <div className="side-top">
        <button className="icon-btn" onClick={toggleSidebar} aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title={collapsed ? 'Expand' : 'Collapse'}>
          <PanelLeft size={18} />
        </button>
        <span className="spacer" />
        <Link href="/search" className={`icon-btn ${is('/search') ? 'active' : ''}`} aria-label="Search" title="Search">
          <Search size={18} />
        </Link>
        <Link href="/new" className={`icon-btn ${is('/new') ? 'active' : ''}`} aria-label="New chat" title="New chat">
          <Plus size={19} />
        </Link>
      </div>
      {pausedAll && <div className="paused-note">{collapsed ? <Pause size={14} /> : <><Pause size={13} /> All agents are paused</>}</div>}
      <div className="chat-list">
        {conversations.map((c) => {
          const active = is(c.href) || (!!c.channel && is(`/c/${c.channel.id}`));
          const preview = c.waiting ? 'Needs your answer' : c.working ? 'Working…' : previewOf(c, me?.id, memberName);
          return (
            <Link key={c.key} href={c.href} className={`chat-row ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? c.title : undefined}>
              <span className="chat-row-avatar">
                {c.agent ? <Avatar member={c.agent} size={40} status /> : c.human ? <Avatar member={c.human} size={40} /> : <GroupAvatar agents={c.members} size={40} />}
                {c.waiting && !c.agent && <span className="attention-dot" />}
              </span>
              <span className="chat-row-text">
                <strong className="ellipsis">{c.title}</strong>
                {preview && <span className={`ellipsis ${c.waiting ? 'needs-you' : c.working ? 'working' : ''}`}>{preview}</span>}
              </span>
            </Link>
          );
        })}
        {conversations.length === 0 && !collapsed && (
          <Link href="/new" className="side-empty">
            <Plus size={15} /> Make your first bot
          </Link>
        )}
      </div>
      <div className="side-bottom">
        <ProfileMenu />
        <Link href="/apps" className={`connect-apps ${inApps ? 'active' : ''}`} title="Connect apps, skills and shared files" aria-label="Connect apps">
          <span className="connect-label">Connect apps</span>
          <span className="app-tiles" aria-hidden="true">
            <span className="tile plug"><Plug size={11} /></span>
            <span className="tile skill"><BookOpen size={11} /></span>
            <span className="tile file"><FolderOpen size={11} /></span>
          </span>
        </Link>
      </div>
    </nav>
  );
}
