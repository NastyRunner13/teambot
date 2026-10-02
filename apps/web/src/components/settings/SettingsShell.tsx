// Settings and Connect apps share one frame: the sections listed on the left, the open one on the right, and inside
// it groups of rows with the label and its explanation on the left and the control on the right.
import { BookOpen, FolderOpen, KeyRound, Plug, Server, Settings2, ShieldCheck, Store, Users, Wallet } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useStore } from '../../store';

export type Section = 'general' | 'team' | 'spending' | 'secrets' | 'policy' | 'system' | 'apps' | 'installed' | 'skills' | 'files';

type Item = { key: Section; href: string; label: string; icon: typeof Plug };

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: 'Settings',
    items: [
      { key: 'general', href: '/settings', label: 'General', icon: Settings2 },
      { key: 'team', href: '/settings/team', label: 'Team', icon: Users },
      { key: 'spending', href: '/settings/spending', label: 'Spending', icon: Wallet },
      { key: 'secrets', href: '/settings/secrets', label: 'Secrets', icon: KeyRound },
      { key: 'policy', href: '/settings/policy', label: 'Action policy', icon: ShieldCheck },
      { key: 'system', href: '/settings/system', label: 'System', icon: Server },
    ],
  },
  {
    label: 'Connect apps',
    items: [
      { key: 'apps', href: '/apps', label: 'Marketplace', icon: Store },
      { key: 'installed', href: '/apps/installed', label: 'Installed', icon: Plug },
      { key: 'skills', href: '/skills', label: 'Skills', icon: BookOpen },
      { key: 'files', href: '/files', label: 'Files', icon: FolderOpen },
    ],
  },
];

/**
 * `fill` gives the section the whole height without scrolling the frame (Skills and Files have their own
 * list and detail panes that scroll separately).
 */
export function SettingsShell({ active, fill, children }: { active: Section; fill?: boolean; children: ReactNode }) {
  const health = useStore((s) => s.health);
  const installed = useStore((s) => s.health?.mcpServers.length ?? 0);
  const skills = useStore((s) => s.skills.length);
  const systemProblem = !!health && (!health.openrouterKey || !health.docker || !health.computerImage);
  const signInNeeded = useStore((s) => s.health?.mcpServers.some((m) => m.needsSignIn || (!m.connected && m.error)) ?? false);
  const counts: Partial<Record<Section, number>> = { installed, skills };
  const alerts: Partial<Record<Section, boolean>> = { system: systemProblem, installed: signInNeeded };
  // On narrow screens the sections are a sideways strip: keep the open one in view.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a promise from scrollIntoView, and an effect may only return a cleanup.
    nav.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <div className="settings">
      <div className="settings-frame">
      <nav ref={nav} className="settings-nav" aria-label="Settings and apps">
        {GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <span className="settings-nav-label">{group.label}</span>
            {group.items.map(({ key, href, label, icon: Icon }) => (
              <Link key={key} href={href} className={active === key ? 'active' : ''} aria-current={active === key ? 'page' : undefined}>
                <Icon size={16} aria-hidden="true" />
                <span className="grow ellipsis">{label}</span>
                {alerts[key] ? <span className="settings-nav-alert" aria-label="Needs attention" /> : counts[key] ? <span className="settings-nav-count">{counts[key]}</span> : null}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className={`settings-body ${fill ? 'fill' : ''}`}>{children}</div>
      </div>
    </div>
  );
}

/** A section's title, with optional actions on the right and an introduction below. */
export function SettingsHeader({ title, intro, actions, back }: { title: ReactNode; intro?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="settings-head">
      {back}
      <div className="settings-head-row">
        <h1 className="grow">{title}</h1>
        {actions}
      </div>
      {intro && <p className="settings-intro">{intro}</p>}
    </header>
  );
}

export function SettingsPage({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={`settings-page ${wide ? 'wide' : ''}`}>{children}</div>;
}

export function SettingGroup({ title, description, actions, children }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="setting-group">
      {(title || actions) && (
        <div className="setting-group-head">
          {title && <h2 className="grow">{title}</h2>}
          {actions}
        </div>
      )}
      {description && <p className="setting-group-desc">{description}</p>}
      <div className="setting-rows">{children}</div>
    </section>
  );
}

/** One setting: what it is on the left, the control on the right. `below` holds a form the row opened. */
export function SettingRow({ title, description, children, below, lead }: { title: ReactNode; description?: ReactNode; children?: ReactNode; below?: ReactNode; lead?: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-main">
        {lead}
        <div className="setting-text">
          <div className="setting-title">{title}</div>
          {description && <div className="setting-desc">{description}</div>}
        </div>
        {children !== undefined && <div className="setting-control">{children}</div>}
      </div>
      {below && <div className="setting-below">{below}</div>}
    </div>
  );
}
