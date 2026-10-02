// A file in /shared: rendered Markdown, text or an image, with download and delete.
import { Download, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Markdown } from './Markdown';
import { Modal } from './Modal';

export const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT = /\.(md|txt|csv|json|log|ya?ml|py|js|ts|tsx|html|css|sh|sql|xml|svg)$/i;
export const fileUrl = (path: string) => `/api/shared/file?path=${encodeURIComponent(path)}`;

export function FileBody({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = fileUrl(path);

  useEffect(() => {
    setText(null);
    setError(null);
    if (!TEXT.test(path)) return;
    fetch(url)
      .then(async (r) => (r.ok ? setText(await r.text()) : setError((await r.json()).error)))
      .catch((err) => setError(String(err)));
  }, [path, url]);

  return (
    <div className="file-preview">
      {error && <div className="error-text">{error}</div>}
      {IMAGE.test(path) && <img src={url} alt={path} />}
      {text !== null && (/\.md$/i.test(path) ? <Markdown text={text} /> : <pre>{text}</pre>)}
      {!IMAGE.test(path) && !TEXT.test(path) && <div className="muted">No preview for this file type. Download it to open.</div>}
    </div>
  );
}

/** Ask, then delete a shared file. Resolves to whether it was deleted. */
export async function deleteSharedFile(path: string): Promise<boolean> {
  const { notify } = useStore.getState();
  if (!confirm(`Delete ${path}? Every agent loses it too, and it can't be undone.`)) return false;
  try {
    await api.del(`/shared/file?path=${encodeURIComponent(path)}`);
    notify(`Deleted ${path.replace('/shared/', '')}`);
    return true;
  } catch (err) {
    notify((err as Error).message, 'error');
    return false;
  }
}

export function FileActions({ path, onDeleted }: { path: string; onDeleted: () => void }) {
  return (
    <>
      <a className="btn sm" href={`${fileUrl(path)}&download=1`}>
        <Download size={13} /> Download
      </a>
      <button className="btn sm ghost danger" onClick={() => void deleteSharedFile(path).then((gone) => gone && onDeleted())}>
        <Trash2 size={13} /> Delete
      </button>
    </>
  );
}

/** The file the store says is open, in a dialog over whatever you were doing. */
export function FilePreviewDialog() {
  const path = useStore((s) => s.preview);
  const openFile = useStore((s) => s.openFile);
  if (!path) return null;
  const close = () => openFile(null);
  return (
    <Modal title={<span className="mono ellipsis">{path.replace('/shared/', '')}</span>} onClose={close} wide footer={<FileActions path={path} onDeleted={close} />}>
      <FileBody path={path} />
    </Modal>
  );
}
