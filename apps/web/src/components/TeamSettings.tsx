// Settings → Team: turn on sign-in, invite teammates by link, manage members, change your password.
import { Copy, LogOut, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Human, Invite } from '@teambot/shared';
import { api } from '../api';
import { ago } from '../lib/format';
import { memberName, useStore } from '../store';
import { Avatar } from './Avatar';
import { SettingGroup, SettingRow, SettingsHeader, SettingsPage } from './settings/SettingsShell';

interface Team {
  teamMode: boolean;
  members: Human[];
  invites: Invite[];
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const notify = useStore((s) => s.notify);
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  async function save() {
    if (form.next !== form.confirm) return notify('The new passwords are different', 'error');
    try {
      await api.post('/auth/password', { current: form.current, next: form.next });
      notify('Password changed. Other devices have to sign in again.');
      onDone();
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }
  return (
    <form
      className="row wrap"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input className="input" style={{ flex: '1 1 160px' }} type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} autoFocus />
      <input className="input" style={{ flex: '1 1 160px' }} type="password" autoComplete="new-password" placeholder="New password" aria-label="New password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
      <input className="input" style={{ flex: '1 1 160px' }} type="password" autoComplete="new-password" placeholder="New password again" aria-label="New password again" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
      <button className="btn primary" disabled={!form.current || form.next.length < 10}>
        Save
      </button>
      <button type="button" className="btn ghost" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

export function TeamSettings() {
  const notify = useStore((s) => s.notify);
  const me = useStore((s) => s.me);
  const version = useStore((s) => s.events.filter((e) => e.type.startsWith('team.') || e.type.startsWith('human.')).length);
  const [team, setTeam] = useState<Team | null>(null);
  const [password, setPassword] = useState({ value: '', confirm: '' });
  const [enabling, setEnabling] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
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
    const form = (
      <form
        className="col"
        onSubmit={(e) => {
          e.preventDefault();
          if (password.value.length >= 10) void enable();
        }}
      >
        <div className="row wrap">
          <input className="input" style={{ flex: '1 1 200px' }} type="password" autoComplete="new-password" placeholder="Your new password" aria-label="Your new password" value={password.value} onChange={(e) => setPassword({ ...password, value: e.target.value })} autoFocus />
          <input className="input" style={{ flex: '1 1 200px' }} type="password" autoComplete="new-password" placeholder="Password again" aria-label="Password again" value={password.confirm} onChange={(e) => setPassword({ ...password, confirm: e.target.value })} />
        </div>
        <div className="row wrap">
          <button className="btn primary" disabled={busy || password.value.length < 10}>
            <Users size={14} /> Turn on team sign-in
          </button>
          <button type="button" className="btn ghost" onClick={() => setEnabling(false)}>
            Cancel
          </button>
          <span className="small muted">
            At least 10 characters. You sign in as <strong>{me?.name}</strong> with this password.
          </span>
        </div>
      </form>
    );
    return (
      <SettingsPage>
        <SettingsHeader title="Team" />
        <SettingGroup title="Sign-in">
          <SettingRow
            title="Team sign-in"
            description={
              <>
                Off: this is a personal workspace, and whoever opens it acts as you. That's safe while TeamBot only listens on this computer. Before others reach it over a network, put
                it behind HTTPS and set <span className="mono">TEAMBOT_PUBLIC_URL</span>.
              </>
            }
            below={enabling ? form : undefined}
          >
            {!enabling && (
              <button className="btn" onClick={() => setEnabling(true)}>
                Turn on…
              </button>
            )}
          </SettingRow>
        </SettingGroup>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage>
      <SettingsHeader
        title="Team"
        intro={`Teammates share the agents and group chats; direct messages stay between their two members. ${owner ? 'As an owner you' : 'Owners'} manage the policy, secrets, apps and the team.`}
        actions={
          owner && (
            <button className="btn" disabled={busy} onClick={invite}>
              <UserPlus size={15} /> Invite
            </button>
          )
        }
      />
      {link && (
        <div className="invite-link">
          <input className="input mono grow" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <button className="btn sm" onClick={() => navigator.clipboard.writeText(link).then(() => notify('Link copied'), () => notify('Could not copy; select the link instead', 'error'))}>
            <Copy size={13} /> Copy
          </button>
          <span className="small muted">Send it to one person. It works once, for 7 days, and isn't shown again.</span>
        </div>
      )}
      <SettingGroup title="Members">
        {team.members.map((h) => (
          <SettingRow key={h.id} lead={<Avatar member={h} size={32} />} title={<>{h.name} {h.id === me?.id && <span className="muted">(you)</span>}</>}>
            <span className={`badge ${h.role === 'owner' ? 'accent' : ''}`}>{h.role}</span>
            {owner && h.id !== me?.id && (
              <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Remove ${h.name}? They are signed out and can't sign in again. Their messages stay.`) && act(() => api.del(`/team/members/${h.id}`), `${h.name} was removed`)}>
                Remove
              </button>
            )}
          </SettingRow>
        ))}
        {team.invites.map((i) => (
          <SettingRow
            key={i.id}
            lead={<span className="avatar human invite-avatar"><UserPlus size={14} /></span>}
            title="Invite link"
            description={`From ${memberName(i.createdBy)}, ${ago(i.createdAt)} · ${Date.parse(i.expiresAt) > Date.now() ? `works until ${new Date(i.expiresAt).toLocaleDateString()}` : 'expired'}`}
          >
            {owner && (
              <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.del(`/team/invites/${i.id}`), 'Invite revoked')}>
                Revoke
              </button>
            )}
          </SettingRow>
        ))}
      </SettingGroup>
      <SettingGroup title="Your account">
        <SettingRow title="Password" description="Other devices have to sign in again after you change it." below={changingPassword ? <PasswordForm onDone={() => setChangingPassword(false)} /> : undefined}>
          {!changingPassword && (
            <button className="btn" onClick={() => setChangingPassword(true)}>
              Change…
            </button>
          )}
        </SettingRow>
        <SettingRow title="Sign out" description="Of this browser.">
          <button className="btn" onClick={signOut}>
            <LogOut size={14} /> Sign out
          </button>
        </SettingRow>
      </SettingGroup>
      {owner && (
        <SettingGroup title="Sign-in">
          <SettingRow title="Team sign-in" description="On. Turning it off signs everyone out, and whoever opens TeamBot acts as the owner again.">
            <button
              className="btn ghost danger"
              disabled={busy}
              onClick={() => confirm('Turn off team sign-in? Everyone is signed out, and whoever opens TeamBot acts as the owner again.') && act(() => api.post('/team/disable'), 'Team sign-in is off')}
            >
              Turn off
            </button>
          </SettingRow>
        </SettingGroup>
      )}
    </SettingsPage>
  );
}
