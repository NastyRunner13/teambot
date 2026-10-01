// Team mode: the sign-in page, and the page an invite link opens.
import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';

function AuthCard({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-card">
        <div className="auth-logo">
          <Bot size={22} strokeWidth={1.7} />
        </div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
        {children}
      </main>
    </div>
  );
}

export function SignInPage() {
  const [form, setForm] = useState({ name: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/sign-in', form);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in to TeamBot" sub="Your team's workspace. Ask its owner for an invite link if you don't have an account.">
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="signin-name">Name</label>
          <input id="signin-name" className="input" autoComplete="username" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="signin-password">Password</label>
          <input id="signin-password" className="input" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <button className="btn primary auth-submit" disabled={busy || !form.name.trim() || !form.password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  );
}

export function JoinPage({ token }: { token: string }) {
  const [invite, setInvite] = useState<{ invitedBy: string; role: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ invitedBy: string; role: string }>(`/auth/invites/${encodeURIComponent(token)}`).then(setInvite, (err) => setProblem((err as Error).message));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) return setError('The passwords are different');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/join', { token, name: form.name.trim(), password: form.password });
      window.location.replace('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (problem) {
    return (
      <AuthCard title="This invite can't be used" sub={problem}>
        <a className="btn auth-submit" href="/">
          Go to sign-in
        </a>
      </AuthCard>
    );
  }
  if (!invite) return <div className="center-fill muted">Checking your invite…</div>;
  return (
    <AuthCard
      title="Join the team"
      sub={
        <>
          {invite.invitedBy} invited you to their TeamBot workspace{invite.role === 'owner' ? ' as a co-owner' : ''}. Pick the name your teammates and agents will call you.
        </>
      }
    >
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="join-name">Your name</label>
          <input id="join-name" className="input" autoComplete="username" autoFocus placeholder="Dana" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <span className="hint">Letters, numbers, - and _. Agents use it for @mentions.</span>
        </div>
        <div className="field">
          <label htmlFor="join-password">Password</label>
          <input id="join-password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <span className="hint">At least 10 characters.</span>
        </div>
        <div className="field">
          <label htmlFor="join-confirm">Password again</label>
          <input id="join-confirm" className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <button className="btn primary auth-submit" disabled={busy || !form.name.trim() || !form.password}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </AuthCard>
  );
}
