// Searchable OpenRouter model list (tool-capable models only).
import { useEffect, useMemo, useState } from 'react';
import type { ModelInfo } from '@teambot/shared';
import { api } from '../api';

let cache: Promise<ModelInfo[]> | null = null;
const loadModels = () => (cache ??= api.get<ModelInfo[]>('/models').catch((err) => ((cache = null), Promise.reject(err))));

const SUGGESTED = ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'x-ai/grok-4.7', 'deepseek/deepseek-v4.1-flash', 'openai/gpt-6-luna'];

export function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    loadModels().then(setModels, (err) => setError((err as Error).message));
  }, []);

  const shown = useMemo(() => {
    if (!models) return [];
    const query = q.trim().toLowerCase();
    if (!query) {
      const picked = SUGGESTED.map((id) => models.find((m) => m.id === id)).filter((m): m is ModelInfo => !!m);
      const current = models.find((m) => m.id === value);
      return current && !picked.includes(current) ? [current, ...picked] : picked;
    }
    return models.filter((m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)).slice(0, 60);
  }, [models, q, value]);

  return (
    <div>
      <input className="input" aria-label="Search models" placeholder="Search models, e.g. Claude, GPT, Gemini…" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="error-text">Could not load models: {error}. You can still type an id below.</div>}
      {!error && !models && <div className="small muted" style={{ marginTop: 6 }}>Loading models…</div>}
      {shown.length > 0 && (
        <div className="model-list">
          {shown.map((m) => (
            <button type="button" aria-pressed={m.id === value} key={m.id} className={`model-row ${m.id === value ? 'active' : ''}`} onClick={() => onChange(m.id)}>
              <span className="grow ellipsis">
                <strong>{m.name}</strong> <span className="faint mono small">{m.id}</span>
              </span>
              <span className="small muted">{Math.round(m.contextLength / 1000)}k ctx</span>
              <span className="small muted" style={{ width: 120, textAlign: 'right' }}>
                ${m.promptPricePerM.toFixed(2)} / ${m.completionPricePerM.toFixed(2)} per M
              </span>
            </button>
          ))}
        </div>
      )}
      <input className="input mono" aria-label="Model ID" style={{ marginTop: 8 }} value={value} onChange={(e) => onChange(e.target.value)} placeholder="provider/model" />
    </div>
  );
}
