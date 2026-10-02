// An app's square tile: its initial on the app's color (no vendor artwork), or an icon for things TeamBot made.
import type { ReactNode } from 'react';
import { inkOn } from '../lib/catalog';

export function AppTile({ name, color, icon, size = 40 }: { name: string; color?: string; icon?: ReactNode; size?: number }) {
  const style = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.27),
    fontSize: Math.round(size * 0.44),
    ...(color ? { background: color, color: inkOn(color) } : {}),
  };
  return (
    <span className={`app-tile ${color ? '' : 'plain'}`} style={style} aria-hidden="true">
      {icon ?? name.charAt(0).toUpperCase()}
    </span>
  );
}
