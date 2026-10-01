// Settings → Slack: create the app from a manifest, paste its two tokens, pair your Slack user.
import { CheckCircle2, Copy, MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SlackStatus } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';

export function SlackSettings() {
  const notify = useStore((s) => s.notify);
  const version = useStore((s) => s.events.filter((e) => e.type.startsWith('bridge.')).length);
  const [status, setStatus] = useState<(SlackStatus & { manifest?: string }) | null>(null);
  const [tokens, setTokens] = useState({ botToken: '', appToken: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<SlackStatus & { manifest: string }>('/bridges/slack').then(setStatus, () => undefined);
  }, [version]);

  async function act(fn: () => Promise<SlackStatus>, done?: string) {
    setBusy(true);
    try {
      const next = await fn();
      setStatus((s) => ({ ...next, manifest: s?.manifest }));
      if (done) notify(done);
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <div className="section">
      <h2>Slack</h2>
      <p className="muted small">The same as Telegram, in your DMs with a TeamBot app in Slack: approvals with buttons, your agents' messages to you, and replies in threads.</p>
      {status.error && <div className="error-text" style={{ marginBottom: 10 }}>{status.error}</div>}

      {!status.configured ? (
        <>
          <ol className="steps small">
            <li>
              At{' '}
              <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer noopener">
                api.slack.com/apps
              </a>
              , choose <strong>From a manifest</strong>, pick your workspace and paste this:
            </li>
          </ol>
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
          <ol className="steps small" start={2}>
            <li>
              Install it to your workspace and copy the <strong>Bot User OAuth Token</strong> (<span className="mono">xoxb-…</span>).
            </li>
            <li>
              Under <strong>Basic Information → App-Level Tokens</strong>, create one with <span className="mono">connections:write</span> (<span className="mono">xapp-…</span>).
            </li>
          </ol>
          <div className="row">
            <input className="input mono grow" type="password" autoComplete="off" placeholder="xoxb-…" aria-label="Bot token" value={tokens.botToken} onChange={(e) => setTokens({ ...tokens, botToken: e.target.value })} />
            <input className="input mono grow" type="password" autoComplete="off" placeholder="xapp-…" aria-label="App-level token" value={tokens.appToken} onChange={(e) => setTokens({ ...tokens, appToken: e.target.value })} />
            <button
              className="btn primary"
              disabled={!tokens.botToken.trim() || !tokens.appToken.trim() || busy}
              onClick={async () => (await act(() => api.put<SlackStatus>('/bridges/slack', tokens), 'Slack connected')) && setTokens({ botToken: '', appToken: '' })}
            >
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </>
      ) : (
        <div className="list">
          <div className="list-row">
            <MessagesSquare size={15} className="faint" />
            <span className="grow">
              Connected as <strong>{status.botName ?? 'your app'}</strong>
              {status.team && <> in {status.team}</>}
              {!status.running && <span className="small muted"> · not connected right now</span>}
            </span>
            <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm('Disconnect Slack?') && act(() => api.del<SlackStatus>('/bridges/slack'), 'Slack disconnected')}>
              Disconnect
            </button>
          </div>
          <div className="list-row">
            {status.paired ? (
              <>
                <CheckCircle2 size={15} color="var(--ok)" />
                <span className="grow">You're paired. Approvals, DMs and mentions arrive in your DMs with the app.</span>
                <button className="btn sm" disabled={busy} onClick={() => act(() => api.del<SlackStatus>('/bridges/slack/pair'), 'Slack unpaired')}>
                  Unpair
                </button>
              </>
            ) : status.pairing ? (
              <span className="grow">
                In Slack, open the app's <strong>Messages</strong> tab and send <span className="mono">pair {status.pairing.code}</span>. The code works for 10 minutes.
              </span>
            ) : (
              <>
                <span className="grow muted">Nobody paired yet.</span>
                <button className="btn sm primary" disabled={busy} onClick={() => act(() => api.post<SlackStatus>('/bridges/slack/pair'))}>
                  Pair my Slack
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
