// Connect apps → Telegram: connect a bot, pair your chat, and talk to agents or approve from your phone.
import { useState } from 'react';
import type { TelegramStatus } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';
import { SettingGroup, SettingRow } from './settings/SettingsShell';

export function TelegramSettings({ status, onChange }: { status: TelegramStatus; onChange: (s: TelegramStatus) => void }) {
  const notify = useStore((s) => s.notify);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<TelegramStatus>, done?: string) {
    setBusy(true);
    try {
      onChange(await fn());
      if (done) notify(done);
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const bot = status.botUsername ? `@${status.botUsername}` : 'your bot';
  if (!status.configured) {
    return (
      <SettingGroup title="Set up" description="You do this once. The bot is yours, and TeamBot talks to it from this computer.">
        <SettingRow
          title="1. Create a bot"
          description={
            <>
              In Telegram, message <span className="mono">@BotFather</span>, send <span className="mono">/newbot</span> and pick a name.
            </>
          }
        />
        <SettingRow
          title="2. Paste its token"
          description="It is stored encrypted, and agents can't see it."
          below={
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (token.trim() && (await act(() => api.put<TelegramStatus>('/bridges/telegram', { token }), 'Telegram bot connected'))) setToken('');
              }}
            >
              <input className="input mono grow" type="password" autoComplete="off" placeholder="123456789:AA…" aria-label="Bot token" value={token} onChange={(e) => setToken(e.target.value)} />
              <button className="btn primary" disabled={!token.trim() || busy}>
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </form>
          }
        />
      </SettingGroup>
    );
  }

  return (
    <SettingGroup title="Connection">
      <SettingRow title="Bot" description={status.running ? <>Connected as {bot}.</> : <>Connected as {bot}, but not listening right now.</>}>
        <button className="btn ghost danger" disabled={busy} onClick={() => confirm('Disconnect the Telegram bot?') && act(() => api.del<TelegramStatus>('/bridges/telegram'), 'Telegram disconnected')}>
          Disconnect
        </button>
      </SettingRow>
      <SettingRow
        title="Your phone"
        description={
          status.paired ? (
            'Paired. Approvals, DMs and mentions go to Telegram.'
          ) : status.pairing ? (
            <>
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
            </>
          ) : (
            'Not paired yet. Pair the chat that should act as you.'
          )
        }
      >
        {status.paired ? (
          <button className="btn" disabled={busy} onClick={() => act(() => api.del<TelegramStatus>('/bridges/telegram/pair'), 'Chat unpaired')}>
            Unpair
          </button>
        ) : (
          !status.pairing && (
            <button className="btn primary" disabled={busy} onClick={() => act(() => api.post<TelegramStatus>('/bridges/telegram/pair'))}>
              Pair my phone
            </button>
          )
        )}
      </SettingRow>
    </SettingGroup>
  );
}
