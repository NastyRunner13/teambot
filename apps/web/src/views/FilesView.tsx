// The /shared folder: deliverables every agent and human can see.
import { Download, Eye, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { SharedFile } from '@teambot/shared';
import { api } from '../api';
import { FileActions, FileBody, deleteSharedFile, fileUrl } from '../components/FilePreview';
import { FileTypeIcon } from '../components/FileView';
import { MenuButton, MenuItem, MenuSeparator } from '../components/Menu';
import { fileType } from '../lib/files';
import { ago, bytes } from '../lib/format';
import { useFilesVersion, useStore } from '../store';

export function FilesView() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const selected = new URLSearchParams(search).get('path');
  // Re-list when a tool finishes or a file is uploaded or deleted (that's when files can change), not on every event.
  const events = useFilesVersion();
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

  async function remove(path: string) {
    if ((await deleteSharedFile(path)) && path === selected) navigate('/files');
  }

  return (
    <>
      <header className="fill-head">
        <div className="grow">
          <h1>Files</h1>
          <p>
            The shared folder. Every agent sees it at <span className="mono">/shared</span>, and so do you.
          </p>
        </div>
        <button className="btn icon" onClick={load} title="Refresh" aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
        <button className="btn" onClick={() => picker.current?.click()} disabled={uploading > 0}>
          <Upload size={14} /> {uploading > 0 ? 'Uploading…' : 'Upload'}
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
      </header>
      <div className="split-view">
        <div className="split-list">
          {files?.length === 0 && <div className="empty" style={{ margin: 16 }}>Nothing shared yet. Agents put deliverables here, and you can upload files for them.</div>}
          {files?.map((f) => {
            const name = f.path.replace('/shared/', '');
            const open = () => navigate(`/files?path=${encodeURIComponent(f.path)}`);
            return (
              <div key={f.path} className={`list-row clickable hover-actions ${f.path === selected ? 'selected' : ''}`} onClick={open}>
                <FileTypeIcon type={fileType(f.path)} size={15} className="faint" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis mono small">{name}</div>
                  <div className="small faint">
                    {bytes(f.size)} · {ago(f.modifiedAt)}
                  </div>
                </div>
                <MenuButton label={`Actions for ${name}`} title="Open, download or delete">
                  <MenuItem onSelect={open}>
                    <Eye size={14} className="faint" /> Open
                  </MenuItem>
                  <MenuItem href={`${fileUrl(f.path)}&download=1`} download>
                    <Download size={14} className="faint" /> Download
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem danger onSelect={() => void remove(f.path)}>
                    <Trash2 size={14} /> Delete file
                  </MenuItem>
                </MenuButton>
              </div>
            );
          })}
        </div>
        <div className="split-detail">
          {selected ? (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <h2 className="grow mono ellipsis" style={{ fontSize: 14 }}>
                  {selected}
                </h2>
                <FileActions path={selected} onDeleted={() => navigate('/files')} />
              </div>
              <FileBody path={selected} />
            </>
          ) : (
            <div className="muted">Pick a file to preview it.</div>
          )}
        </div>
      </div>
    </>
  );
}
