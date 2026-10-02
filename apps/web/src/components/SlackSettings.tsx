// Connect apps → Slack: create the app from a manifest, paste its two tokens, pair your Slack user.
import { Copy } from 'lucide-react';
import { useState } from 'react';
import type { SlackStatus } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';
import { SettingGroup, SettingRow } from './settings/SettingsShell';

export function SlackSettings({ status, onChange }: { status: SlackStatus & { manifest?: string }; onChange: (s: SlackStatus & { manifest?: string }) => void }) {
  const notify = useStore((s) => s.notify);
  const [tokens, setTokens] = useState({ botToken: '', appToken: '' });
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<SlackStatus>, done?: string) {
    setBusy(true);
    try {
      onChange({ ...(await fn()), manifest: status.manifest });
      if (done) notify(done);
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!status.configured) {
    return (
      <SettingGroup title="Set up" description="You do this once. The Slack app is yours and connects out from this computer (Socket Mode), so nothing has to reach TeamBot.">
        <SettingRow
          title="1. Create the app"
          description={
            <>
              At{' '}
              <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer noopener">
                api.slack.com/apps
              </a>
              , choose <strong>From a manifest</strong>, pick your workspace and paste this.
            </>
          }
          below={
            <div className="manifest">
              <pre className="json">{status.manifest}</pre>
              <button
                className="btn sm"
                onClick={() =>
                  navigator.clipboard.writeText(status.manifest ?? '').then(
                    () => notify('Manifest copied'),
                    () => notify('Could not copy; select the text instead', 'error'),
                  )
                }
              >
                <Copy size={13} /> Copy
              </button>
            </div>
          }
        />
        <SettingRow
          title="2. Install it and copy two tokens"
          description={
            <>
              The <strong>Bot User OAuth Token</strong> (<span className="mono">xoxb-…</span>), and under <strong>Basic Information → App-Level Tokens</strong> one with{' '}
              <span className="mono">connections:write</span> (<span className="mono">xapp-…</span>). They are stored encrypted; agents can't see them.
            </>
          }
          below={
            <form
              className="row wrap"
              onSubmit={async (e) => {
                e.preventDefault();
                if (tokens.botToken.trim() && tokens.appToken.trim() && (await act(() => api.put<SlackStatus>('/bridges/slack', tokens), 'Slack connected'))) setTokens({ botToken: '', appToken: '' });
              }}
            >
              <input className="input mono" style={{ flex: '1 1 180px' }} type="password" autoComplete="off" placeholder="xoxb-…" aria-label="Bot token" value={tokens.botToken} onChange={(e) => setTokens({ ...tokens, botToken: e.target.value })} />
              <input className="input mono" style={{ flex: '1 1 180px' }} type="password" autoComplete="off" placeholder="xapp-…" aria-label="App-level token" value={tokens.appToken} onChange={(e) => setTokens({ ...tokens, appToken: e.target.value })} />
              <button className="btn primary" disabled={!tokens.botToken.trim() || !tokens.appToken.trim() || busy}>
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </form>
          }
        />
      </SettingGroup>
    );
  }

  const name = status.botName ?? 'your app';
  return (
    <SettingGroup title="Connection">
      <SettingRow
        title="App"
        description={
          <>
            Connected as {name}
            {status.team && <> in {status.team}</>}
            {status.running ? '.' : ', but not connected right now.'}
          </>
        }
      >
        <button className="btn ghost danger" disabled={busy} onClick={() => confirm('Disconnect Slack?') && act(() => api.del<SlackStatus>('/bridges/slack'), 'Slack disconnected')}>
          Disconnect
        </button>
      </SettingRow>
      <SettingRow
        title="You"
        description={
          status.paired ? (
            "Paired. Approvals, DMs and mentions arrive in your DMs with the app."
          ) : status.pairing ? (
            <>
              In Slack, open the app's <strong>Messages</strong> tab and send <span className="mono">pair {status.pairing.code}</span>. The code works for 10 minutes.
            </>
          ) : (
            'Nobody paired yet. Pair the Slack user that should act as you.'
          )
        }
      >
        {status.paired ? (
          <button className="btn" disabled={busy} onClick={() => act(() => api.del<SlackStatus>('/bridges/slack/pair'), 'Slack unpaired')}>
            Unpair
          </button>
        ) : (
          !status.pairing && (
            <button className="btn primary" disabled={busy} onClick={() => act(() => api.post<SlackStatus>('/bridges/slack/pair'))}>
              Pair my Slack
            </button>
          )
        )}
      </SettingRow>
    </SettingGroup>
  );
}
