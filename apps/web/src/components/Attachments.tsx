// Files attached to a message, as cards. Images show a small preview; any file opens in the preview (beside the chat,
// or in a dialog elsewhere), and a card's download button saves it.
import { Download } from 'lucide-react';
import type { Attachment } from '@teambot/shared';
import { fileType, fileUrl } from '../lib/files';
import { bytes } from '../lib/format';
import { useStore } from '../store';
import { IMAGE } from './FilePreview';
import { FileTypeIcon } from './FileView';

export function Attachments({ items }: { items: Attachment[] }) {
  const openFile = useStore((s) => s.openFile);
  if (!items.length) return null;
  return (
    <div className="attachments">
      {items.map((a) => {
        if (IMAGE.test(a.name)) {
          return (
            <button key={a.path} className="attachment-image" onClick={() => openFile(a.path)} title={a.path} aria-label={`Open ${a.name}`}>
              <img src={fileUrl(a.path)} alt={a.name} loading="lazy" />
            </button>
          );
        }
        const type = fileType(a.name);
        return (
          <div key={a.path} className="attachment">
            <button className="attachment-open" onClick={() => openFile(a.path)} title={`Open ${a.path}`}>
              <span className={`attachment-icon kind-${type.kind}`}>
                <FileTypeIcon type={type} size={18} />
              </span>
              <span className="attachment-copy">
                <strong className="ellipsis">{a.name}</strong>
                <span>
                  {type.label} · {type.ext} · {bytes(a.size)}
                </span>
              </span>
            </button>
            <a className="icon-btn sm attachment-download" href={`${fileUrl(a.path)}&download=1`} aria-label={`Download ${a.name}`} title="Download">
              <Download size={15} />
            </a>
          </div>
        );
      })}
    </div>
  );
}
