// Settings → Team: turn on sign-in, invite teammates by link, manage members, change your password.
import { Copy, LogOut, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Human, Invite } from '@teambot/shared';
import { api } from '../api';
import { ago } from '../lib/format';
import { memberName, useStore } from '../store';

interface Team {
  teamMode: boolean;
  members: Human[];
  invites: Invite[];
}

function PasswordChange() {
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  if (!open) {
    return (
      <button className="btn sm" onClick={() => setOpen(true)}>
        Change password
      </button>
    );
  }
  async function save() {
    if (form.next !== form.confirm) return notify('The new passwords are different', 'error');
    try {
      await api.post('/auth/password', { current: form.current, next: form.next });
      notify('Password changed. Other devices have to sign in again.');
      setOpen(false);
      setForm({ current: '', next: '', confirm: '' });
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }
  return (
    <div className="row wrap" style={{ marginTop: 8 }}>
      <input className="input" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password" aria-label="New password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password again" aria-label="New password again" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
      <button className="btn primary" disabled={!form.current || !form.next} onClick={save}>
        Save
      </button>
      <button className="btn ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

export function TeamSettings() {
  const notify = useStore((s) => s.notify);
  const me = useStore((s) => s.me);
  const version = useStore((s) => s.events.filter((e) => e.type.startsWith('team.') || e.type.startsWith('human.')).length);
  const [team, setTeam] = useState<Team | null>(null);
  const [password, setPassword] = useState({ value: '', confirm: '' });
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = me?.role === 'owner';

  const load = () => api.get<Team>('/team').then(setTeam, () => undefined);
  useEffect(() => {
    void load();
  }, [version]);

  async function act<T>(fn: () => Promise<T>, done?: string): Promise<T | undefined> {
    setBusy(true);
    try {
      const out = await fn();
      if (done) notify(done);
      await load();
      return out;
    } catch (err) {
      notify((err as Error).message, 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    if (password.value !== password.confirm) return notify('The passwords are different', 'error');
    if (await act(() => api.post('/team/enable', { password: password.value }))) window.location.reload();
  }

  async function invite() {
    const out = await act(() => api.post<{ token: string }>('/team/invites', { role: 'member' }));
    if (out) setLink(`${window.location.origin}/join/${out.token}`);
  }

  async function signOut() {
    await api.post('/auth/sign-out').catch(() => undefined);
    window.location.replace('/');
  }

  if (!team) return null;
  if (!team.teamMode) {
    return (
      <div className="section">
        <h2>Team</h2>
        <p className="muted small">
          This is a personal workspace: whoever opens this page acts as you, which is safe while TeamBot only listens on this computer. To work with teammates, turn on
          sign-in: choose a password for <strong>{me?.name}</strong>, then send invite links. Before others reach TeamBot over a network, put it behind HTTPS and set{' '}
          <span className="mono">TEAMBOT_PUBLIC_URL</span>.
        </p>
        <div className="row wrap">
          <input className="input" type="password" autoComplete="new-password" placeholder="Your new password" aria-label="Your new password" value={password.value} onChange={(e) => setPassword({ ...password, value: e.target.value })} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Password again" aria-label="Password again" value={password.confirm} onChange={(e) => setPassword({ ...password, confirm: e.target.value })} />
          <button className="btn primary" disabled={busy || password.value.length < 10} onClick={enable}>
            <Users size={14} /> Turn on team sign-in
          </button>
        </div>
        <p className="small faint" style={{ marginTop: 6 }}>At least 10 characters. You sign in with your name and this password.</p>
      </div>
    );
  }

  return (
    <div className="section">
      <h2>Team</h2>
      <p className="muted small">
        Everyone signs in. Teammates share the agents and channels; your direct messages stay yours. {owner ? 'As an owner you' : 'Owners'} manage the policy, secrets,
        connectors, chat bridges and the team.
      </p>
      <div className="list" style={{ marginBottom: 12 }}>
        {team.members.map((h) => (
          <div key={h.id} className="list-row">
            <span className="grow">
              <strong>{h.name}</strong> {h.id === me?.id && <span className="small muted">(you)</span>}
            </span>
            <span className={`badge ${h.role === 'owner' ? 'accent' : ''}`}>{h.role}</span>
            {owner && h.id !== me?.id && (
              <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Remove ${h.name}? They are signed out and can't sign in again. Their messages stay.`) && act(() => api.del(`/team/members/${h.id}`), `${h.name} was removed`)}>
                Remove
              </button>
            )}
          </div>
        ))}
        {team.invites.map((i) => (
          <div key={i.id} className="list-row">
            <UserPlus size={15} className="faint" />
            <span className="grow small">
              Invite link from {memberName(i.createdBy)}, {ago(i.createdAt)} · {Date.parse(i.expiresAt) > Date.now() ? `works until ${new Date(i.expiresAt).toLocaleDateString()}` : 'expired'}
            </span>
            {owner && (
              <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.del(`/team/invites/${i.id}`), 'Invite revoked')}>
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>
      {link && (
        <div className="invite-link">
          <input className="input mono grow" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <button className="btn sm" onClick={() => navigator.clipboard.writeText(link).then(() => notify('Link copied'), () => notify('Could not copy; select the link instead', 'error'))}>
            <Copy size={13} /> Copy
          </button>
          <span className="small muted">Send it to one person. It works once, for 7 days, and isn't shown again.</span>
        </div>
      )}
      <div className="row wrap">
        {owner && (
          <button className="btn primary" disabled={busy} onClick={invite}>
            <UserPlus size={14} /> Create invite link
          </button>
        )}
        <PasswordChange />
        <button className="btn" onClick={signOut}>
          <LogOut size={14} /> Sign out
        </button>
        <span className="spacer" />
        {owner && (
          <button
            className="btn ghost danger"
            disabled={busy}
            onClick={() => confirm('Turn off team sign-in? Everyone is signed out, and whoever opens TeamBot acts as the owner again.') && act(() => api.post('/team/disable'), 'Team sign-in is off')}
          >
            Turn off sign-in
          </button>
        )}
      </div>
    </div>
  );
}
