// Drives the Chromium window that is visible on the agent's desktop (and in the live view),
// so a human can watch every step and take over at any time.
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';

const CDP_URL = 'http://127.0.0.1:9222';
const MAX_ELEMENTS = 200;
const MAX_TEXT = 6000;

interface PageData {
  title: string;
  url: string;
  text: string;
  elements: string[];
  scrollY: number;
  scrollHeight: number;
  viewport: number;
}

export interface Snapshot {
  url: string;
  title: string;
  snapshot: string;
}

/** Runs inside the page. Tags interactive elements with data-tb-ref so tools can address them by number. */
function collectPage(args: { maxElements: number; maxText: number }): PageData {
  document.querySelectorAll('[data-tb-ref]').forEach((e) => e.removeAttribute('data-tb-ref'));
  const selector = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=option]', '[role=switch]', '[role=textbox]', '[role=combobox]', '[role=searchbox]',
    '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if ((el as HTMLInputElement).disabled) continue;
    n += 1;
    el.setAttribute('data-tb-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const type = tag === 'input' ? input.type || 'text' : '';
    const role = el.getAttribute('role') ?? (tag === 'a' ? 'link' : tag === 'input' ? `input[${type}]` : tag);
    const labelEl = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null) : null;
    const name = clean(
      el.getAttribute('aria-label') ||
        labelEl?.innerText ||
        el.innerText ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('name') ||
        (tag === 'a' ? el.getAttribute('href') : ''),
    ).slice(0, 100);
    let extra = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (type === 'password') extra = input.value ? ' value=<hidden>' : '';
      else if (type === 'checkbox' || type === 'radio') extra = input.checked ? ' [checked]' : ' [unchecked]';
      else if (input.value) extra = ` value="${clean(input.value).slice(0, 60)}"`;
    }
    const inView = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    lines.push(`[${n}] ${role} "${name}"${extra}${inView ? '' : ' (offscreen)'}`);
    if (n >= args.maxElements) {
      lines.push('... more elements omitted; scroll or navigate to see others');
      break;
    }
  }
  const text = (document.body?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: document.title,
    url: location.href,
    text: text.length > args.maxText ? text.slice(0, args.maxText) + '\n... (page text truncated)' : text,
    elements: lines,
    scrollY: Math.round(scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    viewport: innerHeight,
  };
}

/** Describe an element by snapshot ref, the focused element (ref null), or the element at a point on the screen. */
function describeElement(at: number | null | { x: number; y: number }) {
  let el: HTMLElement | null;
  if (at !== null && typeof at === 'object') {
    // Screen → page coordinates: the window's position plus the browser chrome around the page.
    const left = window.screenX + (window.outerWidth - window.innerWidth) / 2;
    const top = window.screenY + (window.outerHeight - window.innerHeight);
    const hit = document.elementFromPoint(at.x - left, at.y - top) as HTMLElement | null;
    const interactive =
      'a[href],button,input,textarea,select,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable="true"]';
    el = (hit?.closest(interactive) as HTMLElement | null) ?? hit;
  } else {
    el = (at === null ? document.activeElement : document.querySelector(`[data-tb-ref="${at}"]`)) as HTMLElement | null;
  }
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const labelEl = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null) : null;
  const type = tag === 'input' ? (el as HTMLInputElement).type : '';
  const isButtonInput = ['submit', 'button', 'reset'].includes(type);
  const isField = (tag === 'input' && !isButtonInput) || tag === 'textarea' || tag === 'select';
  return {
    tag,
    role: el.getAttribute('role') ?? tag,
    type,
    name: clean(
      el.getAttribute('aria-label') || labelEl?.innerText || el.getAttribute('placeholder') ||
        (isField ? '' : el.innerText || (el as HTMLInputElement).value) ||
        el.getAttribute('title') || el.getAttribute('name') || el.id,
    ).slice(0, 120),
    autocomplete: el.getAttribute('autocomplete') ?? '',
  };
}

export class BrowserController {
  private browser?: Browser;
  private active?: Page;

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async context(): Promise<BrowserContext> {
    if (this.browser?.isConnected()) return this.browser.contexts()[0];
    let lastErr: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        this.browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10_000 });
        this.browser.on('disconnected', () => {
          this.browser = undefined;
          this.active = undefined;
        });
        const ctx = this.browser.contexts()[0] ?? (await this.browser.newContext());
        ctx.on('page', (p) => {
          this.active = p;
        });
        return ctx;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`browser is not available: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  }

  private async page(): Promise<Page> {
    const ctx = await this.context();
    if (this.active && !this.active.isClosed()) return this.active;
    const pages = ctx.pages().filter((p) => !p.isClosed());
    this.active = pages[pages.length - 1] ?? (await ctx.newPage());
    return this.active;
  }

  private async settle(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(700);
  }

  private async locate(ref: number): Promise<Locator> {
    if (!Number.isInteger(ref) || ref < 1) throw new Error('ref must be a positive element number from browser_snapshot');
    const page = await this.page();
    const loc = page.locator(`[data-tb-ref="${ref}"]`).first();
    if ((await loc.count()) === 0) {
      throw new Error(`Element [${ref}] not found. The page may have changed; call browser_snapshot for fresh refs.`);
    }
    return loc;
  }

  async snapshot(): Promise<Snapshot> {
    const page = await this.page();
    let data: PageData;
    try {
      data = await page.evaluate(collectPage, { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT });
    } catch {
      // Navigation in flight destroyed the context; wait and retry once.
      await this.settle(page);
      data = await page.evaluate(collectPage, { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT });
    }
    const pages = (await this.context()).pages().filter((p) => !p.isClosed()).length;
    const header = [
      `URL: ${data.url}`,
      `Title: ${data.title || '(none)'}`,
      `Scroll: ${data.scrollY}px of ${data.scrollHeight}px (viewport ${data.viewport}px)` + (pages > 1 ? ` · ${pages} tabs open` : ''),
    ].join('\n');
    const snapshot = `${header}\n\n## Page text\n${data.text || '(empty)'}\n\n## Interactive elements (use the number as ref)\n${
      data.elements.join('\n') || '(none)'
    }`;
    return { url: data.url, title: data.title, snapshot };
  }

  async describe(ref?: number) {
    const page = await this.page();
    const el = await page.evaluate(describeElement, ref ?? null).catch(() => null);
    return { url: page.url(), element: el };
  }

  /** The element under a point on the screen, for clicks made with the mouse rather than by ref. */
  async describeAt(x: number, y: number) {
    const page = await this.page();
    const el = await page.evaluate(describeElement, { x, y }).catch(() => null);
    return { url: page.url(), element: el };
  }

  async navigate(url: string): Promise<Snapshot> {
    if (!url.trim()) throw new Error('url is required');
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    const page = await this.page();
    await page.bringToFront().catch(() => undefined);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.settle(page);
    return this.snapshot();
  }

  async click(ref: number): Promise<Snapshot> {
    const loc = await this.locate(ref);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
    await loc.click({ timeout: 10_000 });
    await this.settle(await this.page());
    return this.snapshot();
  }

  async type(ref: number, text: string, submit: boolean, clear: boolean): Promise<Snapshot> {
    const loc = await this.locate(ref);
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await loc.selectOption({ label: text }).catch(() => loc.selectOption(text));
    } else if (tag === 'input' || tag === 'textarea') {
      if (clear) await loc.fill(text, { timeout: 10_000 });
      else await loc.pressSequentially(text, { delay: 10 });
    } else {
      await loc.click({ timeout: 10_000 });
      if (clear) await (await this.page()).keyboard.press('ControlOrMeta+A');
      await (await this.page()).keyboard.type(text, { delay: 10 });
    }
    if (submit) await loc.press('Enter');
    await this.settle(await this.page());
    return this.snapshot();
  }

  async press(key: string): Promise<Snapshot> {
    if (!key) throw new Error('key is required');
    const page = await this.page();
    await page.keyboard.press(key);
    await this.settle(page);
    return this.snapshot();
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<Snapshot> {
    const page = await this.page();
    const screens = Math.min(Math.max(amount || 1, 0.25), 10);
    await page.mouse.wheel(0, (direction === 'down' ? 1 : -1) * screens * 650);
    await page.waitForTimeout(400);
    return this.snapshot();
  }

  async back(): Promise<Snapshot> {
    const page = await this.page();
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
    await this.settle(page);
    return this.snapshot();
  }

  async tabs() {
    const ctx = await this.context();
    const current = await this.page();
    const pages = ctx.pages().filter((p) => !p.isClosed());
    return Promise.all(
      pages.map(async (p, index) => ({ index, url: p.url(), title: await p.title().catch(() => ''), active: p === current })),
    );
  }

  async switchTab(index: number): Promise<Snapshot> {
    const pages = (await this.context()).pages().filter((p) => !p.isClosed());
    const page = pages[index];
    if (!page) throw new Error(`no tab at index ${index}`);
    this.active = page;
    await page.bringToFront();
    return this.snapshot();
  }
}
