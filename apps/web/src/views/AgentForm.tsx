// Create or edit an agent: identity, role, instructions, model and MCP servers.
import { useId, useState } from 'react';
import { useLocation } from 'wouter';
import type { Agent } from '@teambot/shared';
import { api } from '../api';
import { Blob, SHAPE_EMOJI, shapeOf } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { ModelPicker } from '../components/ModelPicker';
import { TEMPLATES, type AgentTemplate } from '../lib/templates';
import { useStore } from '../store';

interface Draft {
  name: string;
  avatar: string;
  color: string;
  role: string;
  instructions: string;
  model: string;
  mcpServers: string[];
  skills: string[];
}

function SkillAccess({ value, set }: { value: string[]; set: (skills: string[]) => void }) {
  const skills = useStore((s) => s.skills);
  const all = value.includes('*');
  return (
    <div className="field">
      <span className="field-label">Skills</span>
      <div className="col" role="radiogroup" aria-label="Skill access" style={{ gap: 6 }}>
        <label className="row small">
          <input type="radio" checked={all} onChange={() => set(['*'])} /> All team skills, including new ones
        </label>
        <label className="row small">
          <input type="radio" checked={!all} onChange={() => set(skills.map((s) => s.name))} /> Only the ones I pick
        </label>
      </div>
      {!all && (
        <div className="row wrap skill-picks">
          {skills.map((s) => (
            <label key={s.name} className="row small" title={s.description}>
              <input type="checkbox" checked={value.includes(s.name)} onChange={(e) => set(e.target.checked ? [...value, s.name] : value.filter((x) => x !== s.name))} />
              <span className="mono">{s.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentFields({ draft, set }: { draft: Draft; set: (d: Partial<Draft>) => void }) {
  const mcp = useStore((s) => s.health?.mcpServers ?? []);
  const hasSkills = useStore((s) => s.skills.length > 0);
  const id = useId();
  return (
    <div className="agent-editor">
      <aside className="identity-preview">
        <div className="identity-avatar">
          <Blob color={draft.color} shape={shapeOf(draft.avatar)} size={88} />
        </div>
        <h2>{draft.name || 'Your agent'}</h2>
        <p>{draft.role || 'Give your teammate a role.'}</p>
        <span className="badge">Your AI teammate</span>
        <div className="identity-detail"><span>Model</span><strong>{draft.model.split('/').pop() || 'Choose a model'}</strong></div>
        <p className="small">A name, a personality, and a computer of their own.</p>
      </aside>
      <div className="agent-fields">
        <h3 className="form-section-title">Make it yours</h3>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="input" value={draft.name} placeholder="e.g. Researcher" onChange={(e) => set({ name: e.target.value.replace(/\s/g, '') })} />
          <span className="hint">One word. Teammates mention it as @{draft.name || 'Name'}.</span>
        </div>
        <div className="field">
          <span className="field-label">Look</span>
          <div className="avatar-options" role="group" aria-label="Choose a look">
            {SHAPE_EMOJI.map((avatar, i) => (
              <button type="button" key={avatar} aria-label={`Look ${i + 1}`} aria-pressed={shapeOf(draft.avatar) === i} onClick={() => set({ avatar })}>
                <Blob color={draft.color} shape={i} size={30} />
              </button>
            ))}
          </div>
          <span className="hint">Telegram and Slack show it as {draft.avatar}.</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-color`}>Color</label>
          <div className="row wrap" role="group" aria-label="Avatar colors">
            {([['#64748b', 'Slate'], ['#7c5cff', 'Violet'], ['#f59e0b', 'Amber'], ['#10b981', 'Green'], ['#ec4899', 'Rose']] as const).map(([color, name]) => <button type="button" className="color-swatch" key={color} style={{ background: color }} aria-label={`${name} avatar color`} aria-pressed={draft.color === color} onClick={() => set({ color })} />)}
            <input id={`${id}-color`} className="color-input" type="color" title="Custom avatar color" value={draft.color} onInput={(e) => set({ color: e.currentTarget.value })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-role`}>Role</label>
          <input id={`${id}-role`} className="input" value={draft.role} placeholder="What this agent is responsible for" onChange={(e) => set({ role: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-instructions`}>How should they work?</label>
          <textarea id={`${id}-instructions`} className="textarea" rows={6} value={draft.instructions} placeholder="Describe their approach, standards, and where to save results…" onChange={(e) => set({ instructions: e.target.value })} />
        </div>
        <div className="field">
          <label>Model</label>
          <ModelPicker value={draft.model} onChange={(model) => set({ model })} />
          <span className="hint">Any OpenRouter model that supports tool calling. Each agent can use a different one.</span>
        </div>
        {mcp.length > 0 && (
          <div className="field">
            <label>Connectors &amp; MCP servers</label>
            <div className="row wrap">
              {mcp.map((s) => (
                <label key={s.name} className="row small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={draft.mcpServers.includes(s.name)}
                    onChange={(e) => set({ mcpServers: e.target.checked ? [...draft.mcpServers, s.name] : draft.mcpServers.filter((x) => x !== s.name) })}
                  />
                  {s.name} <span className="faint">({s.connected ? `${s.tools} tools` : s.needsSignIn ? 'needs sign-in' : 'not connected'})</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {hasSkills && <SkillAccess value={draft.skills} set={(skills) => set({ skills })} />}
      </div>
    </div>
  );
}

export function draftFrom(t: AgentTemplate | Agent, model: string): Draft {
  return {
    name: t.name,
    avatar: t.avatar,
    color: t.color,
    role: t.role,
    instructions: t.instructions,
    model: 'model' in t ? t.model : model,
    mcpServers: 'mcpServers' in t ? t.mcpServers : [],
    skills: 'skills' in t ? t.skills : ['*'],
  };
}

export function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const defaultModel = useStore((s) => s.health?.defaultModel ?? 'anthropic/claude-sonnet-5.5');
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [template, setTemplate] = useState(() => TEMPLATES.find((t) => !agents.some((a) => a.name === t.name)) ?? TEMPLATES[TEMPLATES.length - 1]);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(template, defaultModel));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const agent = await api.post<Agent>('/agents', draft);
      notify(`${agent.name} joined the team`);
      onClose();
      navigate(`/agents/${agent.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add an agent"
      onClose={onClose}
      wide
      footer={
        <>
          {error && <span className="error-text grow">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !draft.name || !draft.model} onClick={create}>
            {busy ? 'Adding…' : 'Add agent'}
          </button>
        </>
      }
    >
      <p className="dialog-intro">Start with a role. Make the rest your own.</p>
      <div className="templates">
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            className={`template ${template.key === t.key ? 'active' : ''}`}
            aria-pressed={template.key === t.key}
            onClick={() => {
              setTemplate(t);
              setDraft(draftFrom(t, draft.model || defaultModel));
            }}
          >
            <Blob color={t.color} shape={shapeOf(t.avatar)} size={30} />
            <div className="t-name">{t.name || 'Custom'}</div>
            <div className="t-role">{t.role ? t.role.split(':')[0] : 'Start from scratch'}</div>
          </button>
        ))}
      </div>
      <AgentFields draft={draft} set={(d) => setDraft((x) => ({ ...x, ...d }))} />
    </Modal>
  );
}
