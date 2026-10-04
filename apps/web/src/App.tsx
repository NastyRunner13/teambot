import { AlertTriangle, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { FilePreviewDialog } from './components/FilePreview';
import { Sidebar } from './components/Sidebar';
import { useConversations } from './lib/conversations';
import { overlayPanel, useStore } from './store';
import { AppsView } from './views/AppsView';
import { AgentChat, ChannelChat, Welcome } from './views/ChatView';
import { NewChatView } from './views/NewChatView';
import { PagesView, PageView } from './views/PagesView';
import { SETTINGS_SECTIONS, SettingsView, type SettingsSection } from './views/SettingsView';
import { JoinPage, SignInPage } from './views/SignIn';
import { SearchView } from './views/SearchView';

function HealthBanner() {
  const health = useStore((s) => s.health);
  const connected = useStore((s) => s.connected);
  const ready = useStore((s) => s.ready);
  if (ready && !connected) {
    return (
      <div className="banner danger">
        <AlertTriangle size={15} /> Lost the connection to the TeamBot server. Reconnecting…
      </div>
    );
  }
  if (!health) return null;
  const problems: React.ReactNode[] = [];
  if (!health.openrouterKey) problems.push(<>No OpenRouter API key yet: add <span className="mono">OPENROUTER_API_KEY</span> to <span className="mono">.env</span> and restart the server.</>);
  if (!health.docker) problems.push(<>Docker isn't reachable, so agents can't use their computers. Start Docker Desktop.</>);
  else if (!health.computerImage) problems.push(<>The agent computer image is missing. Run <span className="mono">pnpm computer:build</span>.</>);
  if (!problems.length) return null;
  return (
    <div className="banner">
      <AlertTriangle size={15} />
      <div>
        {problems.map((p, i) => (
          <div key={i}>{p}</div>
        ))}
        <Link href="/settings/system">Check settings</Link>
      </div>
    </div>
  );
}

/** The most recent conversation, or a welcome when there are no agents yet. */
function Home() {
  const conversations = useConversations();
  const hasAgents = useStore((s) => s.agents.length > 0);
  if (!hasAgents) return <Welcome />;
  return conversations[0] ? <Redirect to={conversations[0].href} replace /> : <Welcome />;
}

export function App() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [location] = useLocation();
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const toast = useStore((s) => s.toast);
  const signedOut = useStore((s) => s.signedOut);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const panelOpen = useStore((s) => s.panel.open);

  useEffect(() => {
    void init();
  }, [init]);
  useEffect(() => setNavigationOpen(false), [location]);
  // Where the panel covers the chat, going to another page closes it, unless it was just opened for that page.
  useEffect(() => {
    useStore.setState((s) => (overlayPanel() && s.panel.open && s.panel.at !== location ? { panel: { ...s.panel, open: false, view: null } } : {}));
  }, [location]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setNavigationOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const join = location.match(/^\/join\/([^/?#]+)/);
  if (join) return <JoinPage token={decodeURIComponent(join[1])} />;
  if (signedOut) return <SignInPage />;
  if (!ready) {
    return <div className="center-fill muted boot">{error ? `Can't reach the TeamBot server: ${error}` : 'Loading TeamBot…'}</div>;
  }

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''} ${navigationOpen ? 'navigation-open' : ''} ${panelOpen ? 'panel-open' : ''}`}>
      <div className="mobile-bar">
        <button className="icon-btn" aria-label={navigationOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={() => setNavigationOpen(!navigationOpen)}>
          {navigationOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <strong>TeamBot</strong>
      </div>
      <Sidebar />
      <main className="main">
        <HealthBanner />
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/new" component={NewChatView} />
          <Route path="/c/:id">{(p) => <ChannelChat id={p.id} />}</Route>
          <Route path="/agents/:id">{(p) => <AgentChat id={p.id} />}</Route>
          <Route path="/apps">{() => <AppsView page={{ kind: 'browse' }} />}</Route>
          <Route path="/apps/installed">{() => <AppsView page={{ kind: 'installed' }} />}</Route>
          <Route path="/apps/custom">{() => <AppsView page={{ kind: 'custom' }} />}</Route>
          <Route path="/apps/mcp/:name">{(p) => <AppsView page={{ kind: 'server', name: decodeURIComponent(p.name) }} />}</Route>
          <Route path="/apps/:id">{(p) => <AppsView page={{ kind: 'app', id: p.id }} />}</Route>
          <Route path="/skills">{() => <AppsView page={{ kind: 'skills' }} />}</Route>
          <Route path="/skills/:name">{(p) => <AppsView page={{ kind: 'skills', skill: p.name }} />}</Route>
          <Route path="/components">{() => <AppsView page={{ kind: 'components' }} />}</Route>
          <Route path="/components/:name">{(p) => <AppsView page={{ kind: 'components', name: p.name }} />}</Route>
          <Route path="/files">{() => <AppsView page={{ kind: 'files' }} />}</Route>
          <Route path="/pages" component={PagesView} />
          <Route path="/pages/:id">{(p) => <PageView id={p.id} />}</Route>
          <Route path="/search" component={SearchView} />
          <Route path="/settings">{() => <SettingsView section="general" />}</Route>
          <Route path="/settings/:section">
            {(p) => (SETTINGS_SECTIONS.includes(p.section as SettingsSection) ? <SettingsView section={p.section as SettingsSection} /> : <Redirect to="/settings" replace />)}
          </Route>
          {/* Pages that are now part of the chats: old links land on the latest one. */}
          {['/tasks', '/approvals', '/activity'].map((old) => (
            <Route key={old} path={old}>
              <Redirect to="/" replace />
            </Route>
          ))}
          <Route>
            <div className="center-fill muted">Page not found.</div>
          </Route>
        </Switch>
      </main>
      <FilePreviewDialog />
      {toast && <div role="status" className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>{toast.text}</div>}
    </div>
  );
}
