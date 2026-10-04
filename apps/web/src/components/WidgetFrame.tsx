// Generative UI: an interface an agent drew (or a component being previewed), in a sandboxed frame. The frame gets
// sandbox="allow-scripts" without allow-same-origin, so it runs in an opaque origin: it can't read the app, its
// cookies or its storage. Its Content-Security-Policy blocks network requests (fetch, images from elsewhere, forms),
// allowing only scripts and styles from three public CDNs. What crosses into it is the source, the arguments and the
// app's theme as CSS variables; what comes back is its height, script errors, and text for the message box
// (teambot.reply), which the person still has to send. The server also refuses changes from "Origin: null".
import { Maximize2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Widget } from '@teambot/shared';
import { useTheme } from '../lib/theme';
import { useStore } from '../store';
import { Modal } from './Modal';

export const CDNS = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com';
export const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS}`,
  `font-src data: ${CDNS}`,
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
].join('; ');

export type WidgetSource = Pick<Widget, 'title' | 'html' | 'css' | 'js' | 'args'>;

/** Light or dark as the app shows it now, following the system when the theme is Auto. */
export function useScheme(): string {
  const [theme] = useTheme();
  const dark = useSyncExternalStore(
    (fn) => {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', fn);
      return () => media.removeEventListener('change', fn);
    },
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  return theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}

/** The app's theme as variables the frame can use: it can't see the app's stylesheet. */
export function themeTokens(scheme: string): string {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return `:root{color-scheme:${scheme};--tb-bg:${v('--bg')};--tb-surface:${v('--panel-2')};--tb-raised:${v('--panel-3')};--tb-text:${v('--text')};--tb-muted:${v('--muted')};--tb-border:${v('--border-strong')};--tb-accent:${v('--accent')};--tb-on-accent:${v('--on-accent')};--tb-ok:${v('--ok')};--tb-warn:${v('--warn')};--tb-bad:${v('--danger')};--tb-info:${v('--info')};--tb-font:${v('--sans')};--tb-mono:${v('--mono')};--tb-radius:10px}`;
}

/** JSON that can sit inside a <script> element. */
export const scriptJson = (value: unknown) => JSON.stringify(value ?? {}).replace(/</g, '\\u003c');
/** Text that can't close the element it sits in. */
export const inside = (text: string, tag: 'script' | 'style') => text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');

/**
 * The frame's document. It reports its height so the frame grows with it; below `maxHeight` it shows no scrollbar of
 * its own, since one would narrow the layout, shorten what is drawn and leave the frame a few pixels off.
 */
export function widgetDocument(w: WidgetSource, scheme: string, maxHeight: number): string {
  const bridge = `(function(){
var args=${scriptJson(w.args)};
function post(m){try{m.teambot=true;parent.postMessage(m,'*')}catch(e){}}
window.teambot=Object.freeze({args:args,reply:function(text){post({type:'reply',text:String(text).slice(0,4000)})}});
window.__args=args;
var root=document.documentElement;
function size(){var h=Math.ceil(root.getBoundingClientRect().height);root.style.overflowY=h>${maxHeight}?'auto':'hidden';post({type:'size',height:h})}
new ResizeObserver(size).observe(root);
addEventListener('load',size);
addEventListener('error',function(e){post({type:'error',message:String(e.message||'error')})});
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${themeTokens(scheme)}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{padding:12px 14px;background:var(--tb-surface);color:var(--tb-text);font:14px/1.5 var(--tb-font);overflow-wrap:anywhere}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--tb-accent);outline-offset:2px}</style>
<style>${inside(w.css, 'style')}</style>
<script>${inside(bridge, 'script')}</script>
</head><body>${w.html}
<script>${inside(w.js, 'script')}</script></body></html>`;
}

/**
 * The frame itself. It grows with its content up to `maxHeight`, then scrolls inside. `onReply` receives text a button
 * in it offered for the message box.
 */
export function WidgetFrame({ widget, onReply, maxHeight = 720 }: { widget: WidgetSource; onReply?: (text: string) => void; maxHeight?: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const [error, setError] = useState<string | null>(null);
  const scheme = useScheme();
  const args = JSON.stringify(widget.args ?? {});
  // Rebuilt only when what it draws (or the theme) changes; a new document restarts its script.
  const doc = useMemo(() => widgetDocument(widget, scheme, maxHeight), [widget.html, widget.css, widget.js, args, scheme, maxHeight]); // eslint-disable-line react-hooks/exhaustive-deps
  const reply = useRef(onReply);
  reply.current = onReply;

  useEffect(() => {
    setError(null);
  }, [doc]);
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { teambot?: boolean; type?: string; height?: unknown; text?: unknown; message?: unknown } | null;
      if (!d || d.teambot !== true) return;
      if (d.type === 'size' && typeof d.height === 'number' && Number.isFinite(d.height)) setHeight(Math.max(24, Math.min(maxHeight, d.height)));
      else if (d.type === 'reply' && typeof d.text === 'string' && d.text.trim()) reply.current?.(d.text.trim());
      else if (d.type === 'error') setError(String(d.message).slice(0, 300));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [maxHeight]);

  return (
    <>
      <iframe ref={frame} className="widget-frame" title={widget.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} style={{ height }} />
      {error && <div className="widget-error">This view hit a script error: {error}</div>}
    </>
  );
}

/** In a message: the interface with its title, and a larger view on demand. */
export function WidgetCard({ widget, draftKey }: { widget: Widget; draftKey: string }) {
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const [expanded, setExpanded] = useState(false);
  const onReply = (text: string) => {
    setExpanded(false);
    setComposerDraft(draftKey, text);
  };
  const source = widget.kind === 'component' ? `ui_${widget.component}` : 'Drawn by the agent';
  return (
    <div className="widget-card">
      <div className="widget-head">
        <strong className="ellipsis">{widget.title}</strong>
        <span className="faint small ellipsis" title={widget.kind === 'component' ? `Component ${widget.component}, revision ${widget.revision}` : 'An interface the agent wrote'}>
          {source}
        </span>
        <span className="spacer" />
        <button type="button" className="icon-btn sm" onClick={() => setExpanded(true)} aria-label="Open larger" title="Open larger">
          <Maximize2 size={14} />
        </button>
      </div>
      <WidgetFrame widget={widget} onReply={onReply} />
      {expanded && (
        <Modal title={widget.title} onClose={() => setExpanded(false)} wide>
          <div className="widget-card large">
            <WidgetFrame widget={widget} onReply={onReply} maxHeight={Math.round(window.innerHeight * 0.75)} />
          </div>
        </Modal>
      )}
    </div>
  );
}
