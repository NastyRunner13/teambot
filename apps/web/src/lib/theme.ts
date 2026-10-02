// The appearance preference, shared by the profile menu and Settings → General. Stored per browser and applied in
// index.html before React renders, so there is no flash.
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light' | 'system';

const listeners = new Set<() => void>();
const current = (): Theme => (document.documentElement.dataset.theme as Theme) || 'dark';

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('teambot-theme', theme);
  } catch {
    /* Theme still works when storage is disabled. */
  }
  for (const fn of listeners) fn();
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, current);
  return [theme, setTheme];
}
