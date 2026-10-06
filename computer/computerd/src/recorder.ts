// Recording a person's demonstration: while someone drives the agent's computer, the browser reports what they do
// (pages they open, what they click, what they type, keys like Enter) so TeamBot can draft a skill from it.
// The value of a password field, or of any field that looks like it holds a secret, is never read: the event says
// something was typed there, not what. Everything here comes from web pages, so the server treats it as untrusted.

import crypto from 'node:crypto';

/**
 * The function recorded frames call (exposed by Playwright, so it reaches computerd and not the page's server). Named
 * at random per process, so a page can't simply call it by a known name; it could still find it, which is why
 * everything it sends is checked.
 */
export const RECORD_BINDING = `__tb${crypto.randomBytes(6).toString('hex')}`;

export type RecordedKind = 'navigate' | 'click' | 'type' | 'select' | 'check' | 'upload' | 'press';

/** What an action touched, labelled the way browser_snapshot labels elements. */
export interface RecordedTarget {
  role: string;
  name: string;
  tag: string;
  type: string;
}

export interface RecordedEvent {
  /** Order within the recording, from 1. */
  seq: number;
  /** Milliseconds since the recording started. */
  t: number;
  kind: RecordedKind;
  url: string;
  title?: string;
  target?: RecordedTarget;
  /** What was typed or chosen; null when the field holds a secret. */
  value?: string | null;
  /** The field holds a password or another secret, so its value was not recorded. */
  sensitive?: boolean;
  checked?: boolean;
  key?: string;
}

const MAX_VALUE = 2000;
const MAX_NAME = 120;
const MAX_URL = 2000;
const IN_PAGE_KINDS = new Set<RecordedKind>(['click', 'type', 'select', 'check', 'upload', 'press']);

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : '');

function cleanTarget(v: unknown): RecordedTarget | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = v as Record<string, unknown>;
  return { role: str(t.role, 40), name: str(t.name, MAX_NAME), tag: str(t.tag, 20), type: str(t.type, 20) };
}

/**
 * Turn what a page sent into an event, or null when it isn't one. A page can call the binding itself, so nothing is
 * taken on trust: unknown kinds are dropped, strings are capped, and a password field's value never passes, even if
 * the page claims the field is not sensitive.
 */
export function eventFromPage(raw: unknown, url: string): Omit<RecordedEvent, 'seq' | 't'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const kind = e.kind as RecordedKind;
  if (!IN_PAGE_KINDS.has(kind)) return null;
  const target = cleanTarget(e.target);
  const out: Omit<RecordedEvent, 'seq' | 't'> = { kind, url: str(url, MAX_URL) };
  if (target) out.target = target;
  if (kind === 'type' || kind === 'select' || kind === 'upload') {
    const sensitive = e.sensitive === true || target?.type === 'password';
    out.sensitive = sensitive;
    out.value = sensitive ? null : str(e.value, MAX_VALUE);
  }
  if (kind === 'check') out.checked = e.checked === true;
  if (kind === 'press') {
    const key = str(e.key, 40);
    if (!key) return null;
    out.key = key;
  }
  return out;
}

/**
 * Runs inside every frame of every page while a recording is on. Calling it again on the same document switches it
 * back on (stop() only mutes it, since the listeners can't be told apart from the page's own once added).
 * It must stay self-contained: Playwright sends its source text to the page.
 */
export function recordInPage(binding: string) {
  type Recorder = { on: boolean };
  const w = window as unknown as { __tbRecorder?: Recorder } & Record<string, unknown>;
  if (w.__tbRecorder) {
    w.__tbRecorder.on = true;
    return;
  }
  const state: Recorder = { on: true };
  w.__tbRecorder = state;

  const send = (event: Record<string, unknown>) => {
    const fn = w[binding];
    if (!state.on || typeof fn !== 'function') return;
    try {
      Promise.resolve((fn as (e: unknown) => unknown)(event)).catch(() => undefined);
    } catch {
      // The page replaced or broke the binding; nothing to record.
    }
  };

  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const FIELDS = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
  const INTERACTIVE =
    'a[href],button,input,textarea,select,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable="true"]';
  const BUTTONS = ['submit', 'button', 'reset', 'image'];
  const NOT_TEXT = [...BUTTONS, 'checkbox', 'radio', 'file', 'range', 'color', 'hidden'];
  const SECRET_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?)\b/i;
  const SECRET_WORDS =
    /password|passwd|passcode|passphrase|secret|token|api[\s_-]?key|(access|private)[\s_-]?key|one[\s_-]?time|verification[\s_-]?code|security[\s_-]?code|card[\s_-]?(number|no\b)|(^|[^a-z])(pwd|otp|totp|pin|cvv|cvc|csc|ssn|2fa|mfa)([^a-z]|$)/i;

  /** A label's text without the fields inside it (a wrapping label would otherwise include a textarea's content). */
  const textOf = (node: Element) => {
    const copy = node.cloneNode(true) as Element;
    copy.querySelectorAll(FIELDS).forEach((f) => f.remove());
    return clean(copy.textContent);
  };
  const labelOf = (el: HTMLElement): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => !!n)
        .map(textOf)
        .join(' ');
      if (text) return text;
    }
    const labels = (el as HTMLInputElement).labels;
    return labels?.length ? textOf(labels[0]) : '';
  };
  const isTextField = (el: HTMLElement) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || el.isContentEditable) return true;
    return tag === 'input' && !NOT_TEXT.includes((el as HTMLInputElement).type);
  };
  const describe = (el: HTMLElement) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el as HTMLInputElement).type || 'text' : '';
    const field = (tag === 'input' && !BUTTONS.includes(type)) || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    const role = el.getAttribute('role') ?? (tag === 'a' ? 'link' : tag === 'input' ? `input[${type}]` : el.isContentEditable ? 'textbox' : tag);
    // A field is named by its label, never by what is in it.
    const name = clean(
      labelOf(el) ||
        el.getAttribute('placeholder') ||
        (field ? '' : el.innerText || (el as HTMLInputElement).value) ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('name') ||
        (tag === 'a' ? el.getAttribute('href') : ''),
    ).slice(0, 120);
    return { role, name, tag, type };
  };

  /** Fields that were password fields when focused: a "show password" button turns them into text fields. */
  const wasPassword = new WeakSet<HTMLElement>();
  const sensitive = (el: HTMLElement) => {
    if ((el as HTMLInputElement).type === 'password' || wasPassword.has(el)) return true;
    if (SECRET_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) return true;
    const hints = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelOf(el)].join(' ');
    return SECRET_WORDS.test(hints);
  };

  const valueOf = (el: HTMLElement) => (el.isContentEditable ? el.innerText : (el as HTMLInputElement).value) ?? '';
  /** The value last reported (or found on focus) per field, so a field is reported once per change. */
  const last = new WeakMap<HTMLElement, string>();
  const report = (el: HTMLElement) => {
    const value = valueOf(el);
    if (last.get(el) === value) return;
    last.set(el, value);
    const secret = sensitive(el);
    send({ kind: 'type', target: describe(el), value: secret ? null : value, sensitive: secret });
  };
  const editingHost = (el: HTMLElement) => {
    let host = el;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    return host;
  };
  /** When Enter was last recorded: the click the browser makes for it (submitting a form, pressing a button) follows. */
  let enterAt = 0;

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !isTextField(el)) return;
      const field = el.isContentEditable ? editingHost(el) : el;
      if ((field as HTMLInputElement).type === 'password') wasPassword.add(field);
      if (!last.has(field)) last.set(field, valueOf(field));
    },
    true,
  );

  document.addEventListener(
    'focusout',
    (e) => {
      const el = e.target;
      if (e.isTrusted && el instanceof HTMLElement && el.isContentEditable) report(editingHost(el));
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!e.isTrusted || !(el instanceof HTMLElement)) return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const secret = sensitive(el);
        const chosen = Array.from((el as HTMLSelectElement).selectedOptions)
          .map((o) => clean(o.text))
          .join(', ');
        send({ kind: 'select', target: describe(el), value: secret ? null : chosen, sensitive: secret });
        return;
      }
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        if (input.type === 'checkbox' || input.type === 'radio') return send({ kind: 'check', target: describe(el), checked: input.checked });
        if (input.type === 'file') {
          const names = Array.from(input.files ?? [])
            .map((f) => f.name)
            .join(', ');
          return send({ kind: 'upload', target: describe(el), value: names, sensitive: false });
        }
      }
      if (tag === 'input' || tag === 'textarea') report(el);
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.repeat) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const modified = e.ctrlKey || e.metaKey;
      const combo = `${e.ctrlKey ? 'Control+' : ''}${e.metaKey ? 'Meta+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && e.key.length > 1 ? 'Shift+' : ''}${e.key}`;
      if (e.key === 'Enter' || e.key === 'Escape') {
        // Enter in a text area or an editor is a new line, not an action.
        const multiline = !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (e.key === 'Enter' && multiline && !modified) return;
        // The field's value goes first, so the log reads "typed …, then pressed Enter".
        if (el && isTextField(el)) report(el.isContentEditable ? editingHost(el) : el);
        if (e.key === 'Enter') enterAt = Date.now();
        send({ kind: 'press', key: combo, target: el && el !== document.body ? describe(el) : undefined });
        return;
      }
      // Shortcuts only (Ctrl or Cmd plus a key). Plain typing is recorded as the field's value, AltGr combinations are
      // characters, and nothing typed into a secret field is recorded key by key.
      if (!modified || e.altKey || ['Control', 'Meta', 'Alt', 'Shift'].includes(e.key) || /^[acvxyz]$/i.test(e.key)) return;
      if (el && isTextField(el) && sensitive(el)) return;
      send({ kind: 'press', key: combo, target: el && el !== document.body ? describe(el) : undefined });
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || !(e.target instanceof Element)) return;
      // A click with no mouse behind it (detail 0) right after Enter is the browser acting on that Enter.
      if ((e as MouseEvent).detail === 0 && Date.now() - enterAt < 250) return;
      const el = (e.target.closest(INTERACTIVE) as HTMLElement | null) ?? (e.target as HTMLElement);
      if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return;
      const tag = el.tagName.toLowerCase();
      // Clicking into a field only focuses it (what is typed there is recorded), and boxes, lists and file pickers
      // are recorded by the change they make.
      if (isTextField(el) || tag === 'select' || tag === 'option') return;
      if (tag === 'input' && ['checkbox', 'radio', 'file'].includes((el as HTMLInputElement).type)) return;
      if (tag === 'label' && (el as HTMLLabelElement).control) return;
      send({ kind: 'click', target: describe(el) });
    },
    true,
  );
}

/** Mutes the recorder in a frame (its listeners stay, silent, until a recording switches it back on). */
export function muteInPage() {
  const w = window as unknown as { __tbRecorder?: { on: boolean } };
  if (w.__tbRecorder) w.__tbRecorder.on = false;
}
