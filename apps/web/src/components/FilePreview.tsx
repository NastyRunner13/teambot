// A file in /shared with what you can do with it: copy, download, open larger, delete. The previews themselves are in
// FileView.tsx; beside a chat a file opens in the panel (panel/FilePanel.tsx), anywhere else in a dialog.
import { Copy, Download, Trash2 } from 'lucide-react';
import { api } from '../api';
import { fileName, fileType, fileUrl, isText } from '../lib/files';
import { useStore } from '../store';
import { FileModeToggle, FileView, useFileMode } from './FileView';
import { Modal } from './Modal';

export { fileUrl };
export const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/** A file with its Preview / Code switch, as the Files page shows it. */
export function FileBody({ path }: { path: string }) {
  const [mode, setMode] = useFileMode(path);
  return (
    <div className="file-body">
      <div className="file-body-bar">
        <FileModeToggle path={path} mode={mode} onChange={setMode} />
      </div>
      <div className="file-box">
        <FileView path={path} mode={mode} />
      </div>
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

/** Copy a text file's contents. */
export async function copyFile(path: string) {
  const { notify } = useStore.getState();
  try {
    const res = await fetch(fileUrl(path), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn't read ${fileName(path)}`);
    await navigator.clipboard.writeText(await res.text());
    notify('Copied');
  } catch (err) {
    notify((err as Error).message || 'Could not copy', 'error');
  }
}

export function CopyFileButton({ path, compact }: { path: string; compact?: boolean }) {
  if (!isText(fileType(path).kind)) return null;
  return compact ? (
    <button className="icon-btn sm" onClick={() => void copyFile(path)} aria-label="Copy the contents" title="Copy the contents">
      <Copy size={15} />
    </button>
  ) : (
    <button className="btn sm" onClick={() => void copyFile(path)}>
      <Copy size={13} /> Copy
    </button>
  );
}

export function FileActions({ path, onDeleted }: { path: string; onDeleted: () => void }) {
  return (
    <>
      <CopyFileButton path={path} />
      <a className="btn sm" href={`${fileUrl(path)}&download=1`}>
        <Download size={13} /> Download
      </a>
      <button className="btn sm ghost danger" onClick={() => void deleteSharedFile(path).then((gone) => gone && onDeleted())}>
        <Trash2 size={13} /> Delete
      </button>
    </>
  );
}

/** The file the store says is open in the dialog, over whatever you were doing. */
export function FilePreviewDialog() {
  const path = useStore((s) => s.preview);
  const showFileDialog = useStore((s) => s.showFileDialog);
  if (!path) return null;
  const close = () => showFileDialog(null);
  return <FileDialog key={path} path={path} onClose={close} />;
}

function FileDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [mode, setMode] = useFileMode(path);
  return (
    <Modal
      title={
        <span className="file-dialog-title">
          <span className="mono ellipsis">{path.replace('/shared/', '')}</span>
          <FileModeToggle path={path} mode={mode} onChange={setMode} />
        </span>
      }
      onClose={onClose}
      wide
      footer={<FileActions path={path} onDeleted={onClose} />}
    >
      <div className="file-box tall">
        <FileView path={path} mode={mode} />
      </div>
    </Modal>
  );
}
