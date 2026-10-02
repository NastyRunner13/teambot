// A "⋯" button that opens a small menu of actions. It closes on a pick, a click outside, Escape or a resize.
import { MoreHorizontal } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const CloseMenu = createContext<() => void>(() => {});

/**
 * `trigger` replaces the "⋯" icon (its button then gets `className` alone, without the hover-only styling).
 * `align="start"` lines the menu up with the button's left edge instead of its right one.
 */
export function MenuButton({
  label,
  title,
  className = '',
  trigger: content,
  align = 'end',
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  trigger?: ReactNode;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAt(null), []);
  return (
    // Menus sit inside clickable rows and cards: a click in here is never also a click on them.
    <span className="menu-anchor" onClick={(e) => e.stopPropagation()}>
      <button
        ref={trigger}
        type="button"
        className={content ? className : `btn sm icon ghost menu-trigger ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title={title ?? label}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAt((open) => (open ? null : rect));
        }}
      >
        {content ?? <MoreHorizontal size={15} />}
      </button>
      {at && (
        <CloseMenu.Provider value={close}>
          <MenuPopup at={at} align={align} trigger={trigger} onClose={close}>
            {children}
          </MenuPopup>
        </CloseMenu.Provider>
      )}
    </span>
  );
}

function MenuPopup({
  at,
  align,
  trigger,
  onClose,
  children,
}: {
  at: DOMRect;
  align: 'start' | 'end';
  trigger: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(at.bottom + 4);

  // Open below the button, right-aligned with it, and above it when there's no room below.
  useLayoutEffect(() => {
    const height = menu.current?.offsetHeight ?? 0;
    if (at.bottom + 4 + height > window.innerHeight - 8) setTop(Math.max(8, at.top - 4 - height));
  }, [at]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, trigger]);

  return (
    <div ref={menu} className="menu" role="menu" style={align === 'start' ? { top, left: Math.max(8, at.left) } : { top, right: Math.max(8, window.innerWidth - at.right) }}>
      {children}
    </div>
  );
}

/** One action in a menu: a button, or a link when `href` is given. Picking it closes the menu. */
export function MenuItem({ onSelect, href, download, danger, disabled, children }: { onSelect?: () => void; href?: string; download?: boolean; danger?: boolean; disabled?: boolean; children: ReactNode }) {
  const close = useContext(CloseMenu);
  const className = `menu-item ${danger ? 'danger' : ''}`;
  const pick = () => {
    close();
    onSelect?.();
  };
  if (href) {
    return (
      <a role="menuitem" className={className} href={href} download={download || undefined} onClick={pick}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" role="menuitem" className={className} disabled={disabled} onClick={pick}>
      {children}
    </button>
  );
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>;
export const MenuSeparator = () => <div className="menu-sep" />;
