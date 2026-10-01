// Settings → Telegram: connect a bot, pair your chat, and talk to agents or approve from your phone.
import { CheckCircle2, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TelegramStatus } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';

export function TelegramSettings() {
  const notify = useStore((s) => s.notify);
  const version = useStore((s) => s.events.filter((e) => e.type.startsWith('bridge.')).length);
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<TelegramStatus>('/bridges/telegram').then(setStatus, () => undefined);
  }, [version]);

  async function act(fn: () => Promise<TelegramStatus>, done?: string) {
    setBusy(true);
    try {
      setStatus(await fn());
      if (done) notify(done);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const bot = status.botUsername ? `@${status.botUsername}` : 'your bot';

  return (
    <div className="section">
      <h2>Telegram</h2>
      <p className="muted small">
        Get approval requests with Approve and Deny buttons, and your agents' messages to you, on your phone. Reply to continue a conversation, or start a message with
        @Name to talk to an agent.
      </p>
      {status.error && <div className="error-text" style={{ marginBottom: 10 }}>{status.error}</div>}

      {!status.configured ? (
        <>
          <ol className="steps small">
            <li>
              In Telegram, message <span className="mono">@BotFather</span>, send <span className="mono">/newbot</span> and pick a name.
            </li>
            <li>Paste the token it gives you. It is stored encrypted, and agents can't see it.</li>
          </ol>
          <div className="row">
            <input className="input mono grow" type="password" autoComplete="off" placeholder="123456789:AA…" aria-label="Bot token" value={token} onChange={(e) => setToken(e.target.value)} />
            <button
              className="btn primary"
              disabled={!token.trim() || busy}
              onClick={() => act(() => api.put<TelegramStatus>('/bridges/telegram', { token }), 'Telegram bot connected').then(() => setToken(''))}
            >
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </>
      ) : (
        <div className="list">
          <div className="list-row">
            <Send size={15} className="faint" />
            <span className="grow">
              Connected as <strong>{bot}</strong>
              {!status.running && <span className="small muted"> · not listening right now</span>}
            </span>
            <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm('Disconnect the Telegram bot?') && act(() => api.del<TelegramStatus>('/bridges/telegram'), 'Telegram disconnected')}>
              Disconnect
            </button>
          </div>
          <div className="list-row">
            {status.paired ? (
              <>
                <CheckCircle2 size={15} color="var(--ok)" />
                <span className="grow">Your chat is paired. Approvals, DMs and mentions go to Telegram.</span>
                <button className="btn sm" disabled={busy} onClick={() => act(() => api.del<TelegramStatus>('/bridges/telegram/pair'), 'Chat unpaired')}>
                  Unpair
                </button>
              </>
            ) : status.pairing ? (
              <span className="grow">
                Send <span className="mono">/start {status.pairing.code}</span> to {bot}
                {status.botUsername && (
                  <>
                    {' '}
                    or{' '}
                    <a href={`https://t.me/${status.botUsername}?start=${status.pairing.code}`} target="_blank" rel="noreferrer noopener">
                      open it in Telegram
                    </a>
                  </>
                )}
                . The code works for 10 minutes.
              </span>
            ) : (
              <>
                <span className="grow muted">No chat paired yet.</span>
                <button className="btn sm primary" disabled={busy} onClick={() => act(() => api.post<TelegramStatus>('/bridges/telegram/pair'))}>
                  Pair my phone
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
