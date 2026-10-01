// The /shared folder: deliverables every agent and human can see.
import { Download, FileText, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { SharedFile } from '@teambot/shared';
import { api } from '../api';
import { Markdown } from '../components/Markdown';
import { ago, bytes } from '../lib/format';
import { useStore } from '../store';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT = /\.(md|txt|csv|json|log|ya?ml|py|js|ts|tsx|html|css|sh|sql|xml|svg)$/i;

function Preview({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/shared/file?path=${encodeURIComponent(path)}`;

  useEffect(() => {
    setText(null);
    setError(null);
    if (!TEXT.test(path)) return;
    fetch(url)
      .then(async (r) => (r.ok ? setText(await r.text()) : setError((await r.json()).error)))
      .catch((err) => setError(String(err)));
  }, [path, url]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 className="grow mono ellipsis" style={{ fontSize: 14 }}>
          {path}
        </h2>
        <a className="btn sm" href={`${url}&download=1`}>
          <Download size={13} /> Download
        </a>
      </div>
      <div className="file-preview">
        {error && <div className="error-text">{error}</div>}
        {IMAGE.test(path) && <img src={url} alt={path} />}
        {text !== null && (/\.md$/i.test(path) ? <Markdown text={text} /> : <pre>{text}</pre>)}
        {!IMAGE.test(path) && !TEXT.test(path) && <div className="muted">No preview for this file type. Download it to open.</div>}
      </div>
    </div>
  );
}

export function FilesView() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const selected = new URLSearchParams(search).get('path');
  // Re-list when a tool finishes or a file is uploaded (that's when files can appear), not on every event.
  const events = useStore((s) => s.events.reduce((n, e) => (e.type === 'tool.finished' || e.type === 'file.uploaded' ? n + 1 : n), 0));
  const notify = useStore((s) => s.notify);
  const [files, setFiles] = useState<SharedFile[] | null>(null);
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);

  const load = () => api.get<SharedFile[]>('/shared').then(setFiles);
  useEffect(() => {
    void load();
  }, [events]);

  async function upload(list: FileList) {
    const chosen = Array.from(list);
    setUploading((n) => n + chosen.length);
    for (const file of chosen) {
      try {
        const saved = await api.upload(file, 'uploads');
        if (chosen.length === 1) navigate(`/files?path=${encodeURIComponent(saved.path)}`);
      } catch (err) {
        notify((err as Error).message, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (chosen.length > 1) notify(`Uploaded ${chosen.length} files to /shared/uploads`);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="grow">Shared files</h1>
        <span className="small muted">
          Every agent sees this folder at <span className="mono">/shared</span>
        </span>
        <button className="btn sm icon" onClick={load} title="Refresh" aria-label="Refresh">
          <RefreshCw size={13} />
        </button>
        <button className="btn sm" onClick={() => picker.current?.click()} disabled={uploading > 0}>
          <Upload size={13} /> {uploading > 0 ? 'Uploading…' : 'Upload'}
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      <div className="split-view">
        <div className="split-list">
          {files?.length === 0 && <div className="empty" style={{ margin: 16 }}>Nothing shared yet. Agents put deliverables here, and you can upload files for them.</div>}
          {files?.map((f) => (
            <div
              key={f.path}
              className="list-row clickable"
              style={{ background: f.path === selected ? 'var(--accent-weak)' : undefined }}
              onClick={() => navigate(`/files?path=${encodeURIComponent(f.path)}`)}
            >
              <FileText size={15} className="faint" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis mono small">{f.path.replace('/shared/', '')}</div>
                <div className="small faint">
                  {bytes(f.size)} · {ago(f.modifiedAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="grow" style={{ overflowY: 'auto', padding: '16px 20px' }}>
          {selected ? <Preview path={selected} /> : <div className="muted">Pick a file to preview it.</div>}
        </div>
      </div>
    </>
  );
}
