import { AlertTriangle, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { Dock } from './components/Dock';
import { Sidebar } from './components/Sidebar';
import { ThreadPanel } from './components/ThreadPanel';
import { useStore } from './store';
import { ActivityView } from './views/ActivityView';
import { AgentView } from './views/AgentView';
import { ApprovalsView } from './views/ApprovalsView';
import { ChannelView } from './views/ChannelView';
import { FilesView } from './views/FilesView';
import { SettingsView } from './views/SettingsView';
import { JoinPage, SignInPage } from './views/SignIn';
import { SearchView } from './views/SearchView';
import { SkillsView } from './views/SkillsView';
import { TasksView } from './views/TasksView';

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
        <Link href="/settings">Check settings</Link>
      </div>
    </div>
  );
}

function Home() {
  const general = useStore((s) => s.channels.find((c) => c.kind === 'channel' && c.name === 'general') ?? s.channels.find((c) => c.kind === 'channel'));
  return general ? <Redirect to={`/c/${general.id}`} replace /> : null;
}

export function App() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [location] = useLocation();
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const dockAgentId = useStore((s) => s.dockAgentId);
  const threadRootId = useStore((s) => s.threadRootId);
  const toast = useStore((s) => s.toast);
  const signedOut = useStore((s) => s.signedOut);
  const teamMode = useStore((s) => s.teamMode);

  useEffect(() => {
    void init();
  }, [init]);
  useEffect(() => setNavigationOpen(false), [location]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setNavigationOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const join = location.match(/^\/join\/([^/?#]+)/);
  if (join) return <JoinPage token={decodeURIComponent(join[1])} />;
  if (signedOut) return <SignInPage />;
  if (!ready) {
    return <div className="center-fill muted">{error ? `Can't reach the TeamBot server: ${error}` : 'Loading TeamBot…'}</div>;
  }

  return (
    <div className={`app ${navigationOpen ? 'navigation-open' : ''}`}>
      <div className="mobile-bar">
        <button className="btn ghost icon" aria-label={navigationOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={() => setNavigationOpen(!navigationOpen)}>
          {navigationOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <strong>TeamBot</strong><span className="muted small">{teamMode ? 'Team workspace' : 'Your workspace'}</span>
      </div>
      <Sidebar />
      <main className="main">
        <HealthBanner />
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/c/:id">{(p) => <ChannelView id={p.id} />}</Route>
          <Route path="/agents/:id">{(p) => <AgentView id={p.id} />}</Route>
          <Route path="/tasks" component={TasksView} />
          <Route path="/approvals" component={ApprovalsView} />
          <Route path="/activity" component={ActivityView} />
          <Route path="/files" component={FilesView} />
          <Route path="/skills">{() => <SkillsView />}</Route>
          <Route path="/search" component={SearchView} />
          <Route path="/skills/:name">{(p) => <SkillsView name={p.name} />}</Route>
          <Route path="/settings" component={SettingsView} />
          <Route>
            <div className="center-fill muted">Page not found.</div>
          </Route>
        </Switch>
      </main>
      {threadRootId ? <ThreadPanel key={threadRootId} rootId={threadRootId} /> : dockAgentId ? <Dock agentId={dockAgentId} /> : <div />}
      {toast && <div role="status" className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>{toast.text}</div>}
    </div>
  );
}
