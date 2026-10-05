// Message box with @mention autocomplete and file attachments. Enter sends, Shift+Enter adds a line.
import { ArrowUp, LoaderCircle, Paperclip, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { bytes } from '../lib/format';
import { useStore } from '../store';
import { Avatar } from './Avatar';

interface Pending {
  key: string;
  name: string;
  size: number;
  path: string | null;
}

let pendingKey = 0;

/**
 * `draftKey`: the conversation (channel id) or thread (root id) this box writes in. Text an interface in it offers
 * (teambot.reply) lands here for the person to read, change and send. `attach={false}` leaves out file attachments
 * (page comments are text).
 */
export function Composer({
  placeholder,
  onSend,
  autoFocus,
  draftKey,
  attach: canAttach = true,
}: {
  placeholder: string;
  onSend: (text: string, attachments: string[]) => Promise<void>;
  autoFocus?: boolean;
  draftKey?: string;
  attach?: boolean;
}) {
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const notify = useStore((s) => s.notify);
  const offered = useStore((s) => (draftKey && s.composerDraft?.key === draftKey ? s.composerDraft : null));
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return [...agents, ...humans].filter((m) => m.name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [query, agents, humans]);

  useEffect(() => {
    if (!offered) return;
    // Taken once: a box opened later for the same conversation starts empty.
    useStore.setState({ composerDraft: null });
    setText(offered.text);
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [offered]);

  const uploading = files.some((f) => !f.path);
  const ready = (text.trim() || files.length > 0) && !uploading && !sending;

  function detect(value: string, caret: number) {
    const m = value.slice(0, caret).match(/(^|\s)@([A-Za-z0-9_-]*)$/);
    setQuery(m ? m[2] : null);
    setActive(0);
  }

  function insert(name: string) {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([A-Za-z0-9_-]*)$/, `@${name} `);
    const next = before + text.slice(caret);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  function attach(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const key = `f${++pendingKey}`;
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size, path: null }]);
      api
        .upload(file)
        .then((saved) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, path: saved.path } : f))))
        .catch((err) => {
          setFiles((fs) => fs.filter((f) => f.key !== key));
          notify((err as Error).message, 'error');
        });
    }
  }

  async function send() {
    if (!ready) return;
    setSending(true);
    try {
      await onSend(text.trim(), files.map((f) => f.path!));
      setText('');
      setFiles([]);
      if (ref.current) ref.current.style.height = 'auto';
      setQuery(null);
    } catch {
      // The conversation reports the error. Keep the draft for another attempt.
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  return (
    <div
      className="composer"
      onDragOver={(e) => {
        if (!canAttach || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        if (!canAttach || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files);
      }}
    >
      {options.length > 0 && (
        <div className="mention-menu">
          {options.map((m, i) => (
            <div key={m.id} className={`mention-item ${i === active ? 'active' : ''}`} onMouseDown={(e) => (e.preventDefault(), insert(m.name))}>
              <Avatar member={m} size={22} />
              <strong>{m.name}</strong>
              <span className="small muted ellipsis">{m.kind === 'agent' ? m.role : 'human'}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`composer-box ${dragging ? 'dragging' : ''}`}>
        {files.length > 0 && (
          <div className="composer-files">
            {files.map((f) => (
              <span key={f.key} className="file-chip">
                {f.path ? <Paperclip size={12} /> : <LoaderCircle size={12} className="spin" />}
                <span className="ellipsis">{f.name}</span>
                <span className="faint">{bytes(f.size)}</span>
                <button aria-label={`Remove ${f.name}`} title="Remove" onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className={`composer-row ${canAttach ? '' : 'no-attach'}`}>
          {canAttach && (
            <button type="button" className="composer-attach" title="Attach files" aria-label="Attach files" onClick={() => picker.current?.click()}>
              <Plus size={20} />
            </button>
          )}
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) attach(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            ref={ref}
            rows={1}
            value={text}
            autoFocus={autoFocus}
            placeholder={dragging ? 'Drop files to attach them' : placeholder}
            aria-label={canAttach ? 'Message' : placeholder}
            onChange={(e) => {
              setText(e.target.value);
              detect(e.target.value, e.target.selectionStart);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
            }}
            onPaste={(e) => {
              if (canAttach && e.clipboardData.files.length) {
                e.preventDefault();
                attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (options.length) {
                if (e.key === 'ArrowDown') return (e.preventDefault(), setActive((a) => (a + 1) % options.length));
                if (e.key === 'ArrowUp') return (e.preventDefault(), setActive((a) => (a - 1 + options.length) % options.length));
                if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), insert(options[active].name));
                if (e.key === 'Escape') return setQuery(null);
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" className="send-button" title="Send (Enter) · new line: Shift+Enter" aria-label={sending ? 'Sending message' : 'Send message'} disabled={!ready} onClick={send}>
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  );
}
