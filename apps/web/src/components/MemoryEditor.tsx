// One memory file (team or agent), editable in place. Reloads when an agent changes it, unless you have unsaved edits.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

export function MemoryEditor({ url, title, hint, scope, agentId }: { url: string; title: string; hint: React.ReactNode; scope: 'team' | 'agent'; agentId?: string }) {
  const notify = useStore((s) => s.notify);
  // Count of memory events for this file, so an agent's remember/forget refreshes the editor.
  const version = useStore((s) => s.events.filter((e) => e.type === 'memory.updated' && e.data.scope === scope && (scope === 'team' || e.data.agentId === agentId)).length);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = saved !== null && text !== saved;

  useEffect(() => {
    if (dirty) return;
    api.get<{ content: string }>(url).then((r) => {
      setSaved(r.content);
      setText(r.content);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, version]);

  async function save() {
    setBusy(true);
    try {
      const r = await api.put<{ content: string }>(url, { content: text });
      setSaved(r.content);
      setText(r.content);
      notify('Memory saved');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section memory-editor">
      <h2>{title}</h2>
      <p className="muted small">{hint}</p>
      <textarea
        className="textarea code memory-text"
        spellCheck={false}
        aria-label={title}
        placeholder="Nothing yet. Notes look like: - The owner prefers short summaries with links"
        value={text}
        disabled={saved === null}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save memory'}
        </button>
        <button className="btn" disabled={!dirty} onClick={() => setText(saved ?? '')}>
          Discard changes
        </button>
        <span className="spacer" />
        <button className="btn ghost danger" disabled={!text.trim()} onClick={() => confirm(`Clear ${title.toLowerCase()}?`) && setText('')}>
          Clear
        </button>
      </div>
    </div>
  );
}
