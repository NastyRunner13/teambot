// The team task board. Agents and humans both create, claim and hand off tasks here.
import { Play, Plus, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Agent, Task, TaskStatus } from '@teambot/shared';
import { api } from '../api';
import { Avatar } from '../components/Avatar';
import { Markdown } from '../components/Markdown';
import { MenuButton, MenuItem, MenuLabel, MenuSeparator } from '../components/Menu';
import { Modal } from '../components/Modal';
import { ago } from '../lib/format';
import { memberName, useMember, useStore } from '../store';

const COLUMNS: { status: TaskStatus; label: string; badge: string }[] = [
  { status: 'todo', label: 'To do', badge: '' },
  { status: 'in_progress', label: 'In progress', badge: 'accent' },
  { status: 'blocked', label: 'Blocked', badge: 'warn' },
  { status: 'done', label: 'Done', badge: 'ok' },
];

function MemberSelect({ value, onChange, allowNone = true }: { value: string | null; onChange: (id: string | null) => void; allowNone?: boolean }) {
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">Unassigned</option>}
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.avatar} {a.name}
        </option>
      ))}
      {humans.map((h) => (
        <option key={h.id} value={h.id}>
          {h.name} (you)
        </option>
      ))}
    </select>
  );
}

const closed = (task: Task) => task.status === 'done' || task.status === 'cancelled';

/** Confirm, then delete the task for good. Resolves true if it was deleted. */
async function deleteTask(task: Task, notify: (text: string, kind?: 'error') => void): Promise<boolean> {
  if (!confirm(`Delete task #${task.number} "${task.title}"? It's removed for good, with its notes.`)) return false;
  try {
    await api.del(`/tasks/${task.number}`);
    notify(`Task #${task.number} deleted`);
    return true;
  } catch (err) {
    notify((err as Error).message, 'error');
    return false;
  }
}

/** Quick actions for one card: hand it to an agent (who starts right away) or delete it. */
function TaskMenu({ task, onOpen }: { task: Task; onOpen: () => void }) {
  // Helpers belong to the agent that started them; they aren't handed new work.
  const agents = useStore(useShallow((s) => s.agents.filter((a) => !a.parentId)));
  const notify = useStore((s) => s.notify);

  async function assign(agent: Agent) {
    try {
      if (agent.id === task.assigneeId) {
        await api.post(`/tasks/${task.number}/start`);
        notify(`Asked ${agent.name} to work on #${task.number}`);
      } else {
        // A finished or cancelled task handed to someone is open again.
        await api.patch(`/tasks/${task.number}`, { assigneeId: agent.id, ...(closed(task) ? { status: 'todo' } : {}) });
        notify(`#${task.number} assigned to ${agent.name}, who starts on it now`);
      }
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <MenuButton label={`Actions for task #${task.number}`} title="Assign or delete" className="task-card-menu">
      <MenuLabel>{agents.length ? 'Assign to an agent' : 'No agents yet'}</MenuLabel>
      {agents.map((a) => {
        const current = a.id === task.assigneeId;
        return (
          <MenuItem key={a.id} disabled={current && closed(task)} onSelect={() => void assign(a)}>
            <Avatar member={a} size={20} />
            <span className="grow ellipsis">{a.name}</span>
            {current ? (
              <span className="small row" style={{ gap: 4, color: 'var(--accent-text)', fontWeight: 600 }}>
                <Play size={12} /> Start now
              </span>
            ) : (
              <span className="small faint ellipsis" style={{ maxWidth: 110 }}>
                {a.role}
              </span>
            )}
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem onSelect={onOpen}>
        <SquareArrowOutUpRight size={14} className="faint" /> Open
      </MenuItem>
      <MenuItem danger onSelect={() => void deleteTask(task, notify)}>
        <Trash2 size={14} /> Delete task
      </MenuItem>
    </MenuButton>
  );
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const assignee = useMember(task.assigneeId);
  const tasks = useStore((s) => s.tasks);
  const waiting = task.dependsOn.filter((n) => tasks.find((t) => t.number === n)?.status !== 'done');
  return (
    <div className="task-card-wrap hover-actions">
      <button type="button" className="task-card" onClick={onOpen}>
        <div className="row task-card-top">
          <span className="num">#{task.number}</span>
          <span className="spacer" />
          {waiting.length > 0 && <span className="badge warn">waits on {waiting.map((n) => `#${n}`).join(', ')}</span>}
        </div>
        <div className="title">{task.title}</div>
        <div className="row small muted">
          <Avatar member={assignee} size={18} />
          <span className="grow ellipsis">{assignee?.name ?? 'Unassigned'}</span>
          <span className="faint">{ago(task.updatedAt)}</span>
        </div>
      </button>
      <TaskMenu task={task} onOpen={onOpen} />
    </div>
  );
}

function NewTaskDialog({ onClose }: { onClose: () => void }) {
  // useShallow: a freshly filtered array on every read would re-render forever.
  const channels = useStore(useShallow((s) => s.channels.filter((c) => c.kind === 'channel')));
  const notify = useStore((s) => s.notify);
  const [form, setForm] = useState({ title: '', description: '', assigneeId: null as string | null, deps: '', channelId: channels[0]?.id ?? '' });
  const [error, setError] = useState<string | null>(null);

  async function create() {
    try {
      const dependsOn = form.deps
        .split(/[\s,#]+/)
        .filter(Boolean)
        .map(Number);
      await api.post('/tasks', { title: form.title, description: form.description, assigneeId: form.assigneeId, dependsOn, channelId: form.channelId || null });
      notify('Task created');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title="New task"
      onClose={onClose}
      footer={
        <>
          {error && <span className="error-text grow">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!form.title.trim()} onClick={create}>
            Create task
          </button>
        </>
      }
    >
      <div className="field">
        <label>Title</label>
        <input className="input" data-autofocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="textarea" value={form.description} placeholder="What does done look like? Where should the result go?" onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field grow">
          <label>Assignee</label>
          <MemberSelect value={form.assigneeId} onChange={(assigneeId) => setForm({ ...form, assigneeId })} />
          <span className="hint">Agents start as soon as it's assigned.</span>
        </div>
        <div className="field grow">
          <label>Depends on</label>
          <input className="input" placeholder="e.g. 1, 2" value={form.deps} onChange={(e) => setForm({ ...form, deps: e.target.value })} />
        </div>
        <div className="field grow">
          <label>Channel</label>
          <select className="select" value={form.channelId} onChange={(e) => setForm({ ...form, channelId: e.target.value })}>
            <option value="">None</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function TaskDialog({ number, onClose }: { number: number; onClose: () => void }) {
  const task = useStore((s) => s.tasks.find((t) => t.number === number));
  const notify = useStore((s) => s.notify);
  const [note, setNote] = useState('');
  if (!task) return null;

  async function update(patch: Record<string, unknown>) {
    try {
      await api.patch(`/tasks/${task!.number}`, patch);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  async function remove() {
    if (await deleteTask(task!, notify)) onClose();
  }

  return (
    <Modal
      title={`#${task.number} ${task.title}`}
      onClose={onClose}
      wide
      footer={
        <button className="btn ghost danger" onClick={remove}>
          <Trash2 size={14} /> Delete task
        </button>
      }
    >
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <select className="select" style={{ width: 170 }} value={task.status} onChange={(e) => update({ status: e.target.value })}>
          {[...COLUMNS.map((c) => c.status), 'cancelled'].map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <div style={{ width: 220 }}>
          <MemberSelect value={task.assigneeId} onChange={(assigneeId) => update({ assigneeId })} />
        </div>
        <span className="small muted">
          created by {memberName(task.creatorId)} {ago(task.createdAt)}
          {task.dependsOn.length > 0 && ` · depends on ${task.dependsOn.map((n) => `#${n}`).join(', ')}`}
        </span>
      </div>
      {task.description ? <Markdown text={task.description} /> : <p className="muted">No description.</p>}
      <div className="section">
        <h3 style={{ marginBottom: 8 }}>Notes</h3>
        {task.notes.length === 0 && <div className="small muted">No notes yet.</div>}
        {task.notes.map((n, i) => (
          <div key={i} className="card">
            <div className="small muted">
              <strong>{memberName(n.authorId)}</strong> · {ago(n.at)}
            </div>
            <Markdown text={n.text} />
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <input className="input grow" placeholder="Add a note (the assignee is notified)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            className="btn"
            disabled={!note.trim()}
            onClick={async () => {
              await update({ note });
              setNote('');
            }}
          >
            Add note
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function TasksView() {
  const tasks = useStore((s) => s.tasks);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  return (
    <>
      <div className="page-header">
        <h1 className="grow">Tasks</h1>
        <label className="row small muted">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> show cancelled
        </label>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> New task
        </button>
      </div>
      <div className="board" style={{ gridTemplateColumns: `repeat(${showCancelled ? 5 : 4}, minmax(220px, 1fr))` }}>
        {[...COLUMNS, ...(showCancelled ? [{ status: 'cancelled' as TaskStatus, label: 'Cancelled', badge: '' }] : [])].map((col) => {
          const list = tasks.filter((t) => t.status === col.status);
          return (
            <div key={col.status} className="column">
              <div className="column-head">
                {col.label} <span className={`badge ${col.badge}`}>{list.length}</span>
              </div>
              {list.map((t) => (
                <TaskCard key={t.id} task={t} onOpen={() => setOpen(t.number)} />
              ))}
              {list.length === 0 && <div className="small faint" style={{ padding: '4px 4px 8px' }}>Nothing here</div>}
            </div>
          );
        })}
      </div>
      {creating && <NewTaskDialog onClose={() => setCreating(false)} />}
      {open !== null && <TaskDialog number={open} onClose={() => setOpen(null)} />}
    </>
  );
}
