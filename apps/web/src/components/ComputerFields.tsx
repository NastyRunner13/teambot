// How an agent's computer is built: a setup script and, optionally, its own Docker image.
import { useId } from 'react';
import type { AgentNetwork } from '@teambot/shared';
import { useStore } from '../store';

export function ComputerFields({
  setupScript,
  computerImage,
  desktop,
  network,
  set,
}: {
  setupScript: string;
  computerImage: string;
  desktop: boolean;
  network: AgentNetwork;
  set: (v: { setupScript?: string; computerImage?: string; desktop?: boolean; network?: AgentNetwork }) => void;
}) {
  const id = useId();
  const secrets = useStore((s) => s.secrets);
  const coding = [
    ['Claude Code', ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']],
    ['Codex', ['OPENAI_API_KEY']],
    ['Gemini CLI', ['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
  ].filter(([, keys]) => (keys as string[]).some((k) => secrets.includes(k))).map(([label]) => label as string);
  return (
    <div className="section budget-fields">
      <h3 className="form-section-title">Computer</h3>
      <label className="row small" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={desktop} onChange={(e) => set({ desktop: e.target.checked })} style={{ marginTop: 3 }} />
        <span>
          <strong>Full desktop control</strong>{' '}
          <span className="muted">
            — screenshots plus mouse and keyboard, for desktop apps and pages the browser tools can't handle. Needs a model that can see images. Your policy still checks
            what each click and keystroke lands on.
          </span>
        </span>
      </label>
      <p className="muted small" style={{ marginBottom: 16 }}>
        Coding agents:{' '}
        {coding.length ? (
          <>
            <strong>{coding.join(', ')}</strong> available. Agents can hand programming tasks to them with <span className="mono">run_coding_agent</span>.
          </>
        ) : (
          <>
            add <span className="mono">ANTHROPIC_API_KEY</span>, <span className="mono">OPENAI_API_KEY</span> or <span className="mono">GEMINI_API_KEY</span> as a secret in Settings and
            agents can hand programming tasks to Claude Code, Codex or Gemini CLI on their computer.
          </>
        )}
      </p>
      <p className="muted small">
        The setup script runs once on this agent's computer before its first task, and again whenever you change it. Use it to install tools or configure accounts.
        It runs as the agent (with sudo) and can use <span className="mono">{'{{secret:NAME}}'}</span>.
      </p>
      <div className="field">
        <span className="field-label">Internet access</span>
        <div className="col" role="radiogroup" aria-label="Internet access" style={{ gap: 6 }}>
          <label className="row small">
            <input type="radio" checked={network.mode === 'open'} onChange={() => set({ network: { ...network, mode: 'open' } })} /> Open: any site
          </label>
          <label className="row small">
            <input type="radio" checked={network.mode === 'allowlist'} onChange={() => set({ network: { ...network, mode: 'allowlist' } })} /> Only these sites (everything else is blocked
            at the network level)
          </label>
        </div>
        {network.mode === 'allowlist' && (
          <>
            <textarea
              className="textarea code allow-text"
              spellCheck={false}
              aria-label="Allowed sites"
              placeholder={'github.com\nnpmjs.org\n*.googleapis.com'}
              value={network.allow.join('\n')}
              onChange={(e) => set({ network: { ...network, allow: e.target.value.split(/[\n,\s]+/).filter(Boolean) } })}
            />
            <span className="hint">One domain per line. example.com includes its subdomains. Package installs need their registries listed (e.g. pypi.org, files.pythonhosted.org).</span>
          </>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${id}-setup`}>Setup script (bash)</label>
        <textarea
          id={`${id}-setup`}
          className="textarea code setup-text"
          spellCheck={false}
          placeholder={'sudo apt-get update && sudo apt-get install -y ffmpeg\npip install --user pandas'}
          value={setupScript}
          onChange={(e) => set({ setupScript: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-image`}>Base image</label>
        <input
          id={`${id}-image`}
          className="input mono"
          placeholder="teambot/computer:latest (default)"
          value={computerImage}
          onChange={(e) => set({ computerImage: e.target.value.trim() })}
        />
        <span className="hint">
          Leave empty for the default. A custom image should be built <span className="mono">FROM teambot/computer:latest</span>. It takes effect the next time the computer
          starts; its files in /home/agent are kept.
        </span>
      </div>
    </div>
  );
}
