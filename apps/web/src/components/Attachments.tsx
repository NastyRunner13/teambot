// Files attached to a message. Images show a small preview; everything opens in Shared files.
import { FileText } from 'lucide-react';
import { useLocation } from 'wouter';
import type { Attachment } from '@teambot/shared';
import { bytes } from '../lib/format';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
export const fileUrl = (path: string) => `/api/shared/file?path=${encodeURIComponent(path)}`;

export function Attachments({ items }: { items: Attachment[] }) {
  const [, navigate] = useLocation();
  if (!items.length) return null;
  const open = (path: string) => navigate(`/files?path=${encodeURIComponent(path)}`);
  return (
    <div className="attachments">
      {items.map((a) =>
        IMAGE.test(a.name) ? (
          <button key={a.path} className="attachment-image" onClick={() => open(a.path)} title={a.path} aria-label={`Open ${a.name}`}>
            <img src={fileUrl(a.path)} alt={a.name} loading="lazy" />
          </button>
        ) : (
          <button key={a.path} className="attachment" onClick={() => open(a.path)} title={a.path}>
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
