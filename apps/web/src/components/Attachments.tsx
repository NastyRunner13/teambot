// Files attached to a message. Images show a small preview; any file opens in the preview dialog.
import { FileText } from 'lucide-react';
import type { Attachment } from '@teambot/shared';
import { bytes } from '../lib/format';
import { useStore } from '../store';
import { IMAGE, fileUrl } from './FilePreview';

export function Attachments({ items }: { items: Attachment[] }) {
  const openFile = useStore((s) => s.openFile);
  if (!items.length) return null;
  return (
    <div className="attachments">
      {items.map((a) =>
        IMAGE.test(a.name) ? (
          <button key={a.path} className="attachment-image" onClick={() => openFile(a.path)} title={a.path} aria-label={`Open ${a.name}`}>
            <img src={fileUrl(a.path)} alt={a.name} loading="lazy" />
          </button>
        ) : (
          <button key={a.path} className="attachment" onClick={() => openFile(a.path)} title={a.path}>
            <FileText size={16} />
            <span className="attachment-copy">
              <strong className="ellipsis">{a.name}</strong>
              <span>{bytes(a.size)}</span>
            </span>
          </button>
        ),
      )}
    </div>
  );
}
