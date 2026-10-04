// A file opened beside the chat, the way an artifact opens: its preview fills the panel, with Preview / Code, copy,
// download and a larger view.
import { ChevronLeft, Download, Maximize2, PanelRightClose } from 'lucide-react';
import { fileName, fileType, fileUrl } from '../../lib/files';
import { useStore } from '../../store';
import { CopyFileButton } from '../FilePreview';
import { FileModeToggle, FileTypeIcon, FileView, useFileMode } from '../FileView';

export function FilePanel({ path }: { path: string }) {
  const closeView = useStore((s) => s.closeView);
  const togglePanel = useStore((s) => s.togglePanel);
  const showFileDialog = useStore((s) => s.showFileDialog);
  const [mode, setMode] = useFileMode(path);
  const type = fileType(path);
  return (
    <div className="panel-page">
      <div className="panel-bar file-bar">
        <button className="icon-btn" onClick={closeView} aria-label="Back" title="Back">
          <ChevronLeft size={19} />
        </button>
        <span className="file-badge">
          <FileTypeIcon type={type} size={15} />
        </span>
        <div className="file-title" title={path}>
          <strong className="ellipsis">{fileName(path)}</strong>
          <small>
            {type.label} · {type.ext}
          </small>
        </div>
        <FileModeToggle path={path} mode={mode} onChange={setMode} />
        <CopyFileButton path={path} compact />
        <a className="icon-btn sm" href={`${fileUrl(path)}&download=1`} aria-label="Download" title="Download">
          <Download size={15} />
        </a>
        <button className="icon-btn sm" onClick={() => showFileDialog(path)} aria-label="Open larger" title="Open larger">
          <Maximize2 size={15} />
        </button>
        <button className="icon-btn" onClick={togglePanel} aria-label="Close the panel" title="Close the panel">
          <PanelRightClose size={18} />
        </button>
      </div>
      <div className="panel-body flush file-box">
        <FileView path={path} mode={mode} />
      </div>
    </div>
  );
}
