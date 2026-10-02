// A page in the right panel: a back arrow to the profile, a title, a scrolling body and an optional footer.
import { ChevronLeft, PanelRightClose } from 'lucide-react';
import type { ReactNode } from 'react';
import { useStore } from '../../store';

export function PanelPage({
  title,
  onBack,
  footer,
  flush,
  children,
}: {
  title: ReactNode;
  onBack?: () => void;
  footer?: ReactNode;
  /** The body lays itself out (no padding or scrolling of its own). */
  flush?: boolean;
  children: ReactNode;
}) {
  const closeView = useStore((s) => s.closeView);
  const togglePanel = useStore((s) => s.togglePanel);
  return (
    <div className="panel-page">
      <div className="panel-bar">
        <button className="icon-btn" onClick={onBack ?? closeView} aria-label="Back" title="Back">
          <ChevronLeft size={19} />
        </button>
        <h2 className="panel-title ellipsis">{title}</h2>
        <button className="icon-btn" onClick={togglePanel} aria-label="Close the panel" title="Close the panel">
          <PanelRightClose size={18} />
        </button>
      </div>
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
      {footer && <div className="panel-foot">{footer}</div>}
    </div>
  );
}

/** An on/off switch. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}
