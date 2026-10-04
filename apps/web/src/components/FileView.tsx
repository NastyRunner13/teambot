// Previews of files in /shared, by type. Markdown renders, code is highlighted, tables and notebooks are laid out, and
// images, audio and video use the browser's own players. Anything that runs (an agent's web page, a diagram) or parses
// an untrusted document (Word, Excel, PowerPoint, PDF) does it in the sandboxed frame generative UI uses
// (WidgetFrame.tsx): an opaque origin with no network but three CDNs. The server never serves HTML or SVG as a page.
import {
  AppWindow,
  Download,
  File as FileIcon,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  NotebookText,
  Presentation,
  Workflow,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fileName, fileType, fileUrl, modesFor, readAs, type FileKind, type FileMode, type FileType } from '../lib/files';
import { bytes as formatBytes } from '../lib/format';
import { useFilesVersion } from '../store';
import { Markdown } from './Markdown';
import { CSP, inside, scriptJson, themeTokens, useScheme } from './WidgetFrame';

const MAX_TEXT = 5 * 1024 * 1024;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_HIGHLIGHT = 400_000;
const MAX_ROWS = 2000;
const MAX_PAGES = 60;

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'too-big'; size: number }
  | { state: 'binary' }
  | { state: 'ready'; version: string; text?: string; bytes?: ArrayBuffer };

/** Text if the bytes are text: no null bytes up front, and UTF-8 (or else Windows-1252, the usual other). */
function decodeText(buf: ArrayBuffer): string | null {
  const data = new Uint8Array(buf);
  if (data.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

const problem = (status: number) => new Error(status === 404 ? 'This file is gone: it was deleted or moved.' : `Couldn't open this file (HTTP ${status}).`);

/**
 * A file's contents, read again whenever an agent may have changed it. A HEAD request asks first: while the file is
 * unchanged (same etag) nothing is downloaded and the view keeps its state, so a page someone is using never restarts.
 */
function useSharedFile(path: string, as: 'text' | 'bytes' | 'url'): Loaded {
  const changed = useFilesVersion();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const version = useRef<string | null>(null);

  useEffect(() => {
    version.current = null;
    setLoaded({ state: 'loading' });
  }, [path, as]);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      const head = await fetch(fileUrl(path), { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
      if (!head.ok) throw problem(head.status);
      const tag = head.headers.get('etag') ?? String(Date.now());
      if (tag === version.current) return;
      const size = Number(head.headers.get('content-length') ?? 0);
      if (as === 'url') {
        version.current = tag;
        return setLoaded({ state: 'ready', version: tag });
      }
      if (size > (as === 'text' ? MAX_TEXT : MAX_BYTES)) {
        version.current = tag;
        return setLoaded({ state: 'too-big', size });
      }
      const res = await fetch(fileUrl(path), { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw problem(res.status);
      const buf = await res.arrayBuffer();
      const read = res.headers.get('etag') ?? tag;
      version.current = read;
      if (as === 'bytes') return setLoaded({ state: 'ready', version: read, bytes: buf });
      const text = decodeText(buf);
      setLoaded(text === null ? { state: 'binary' } : { state: 'ready', version: read, text });
    })().catch((err: Error) => {
      if (!ctrl.signal.aborted) setLoaded({ state: 'error', message: err.message });
    });
    return () => ctrl.abort();
  }, [path, as, changed]);

  return loaded;
}

/** The file at `path`, as `mode` shows it. Fills the box it is put in. */
export function FileView({ path, mode }: { path: string; mode: FileMode }) {
  const type = fileType(path);
  const name = fileName(path);
  const loaded = useSharedFile(path, readAs(type.kind, mode));

  if (loaded.state === 'loading') return <div className="file-status muted">Opening {name}…</div>;
  if (loaded.state === 'error') return <div className="file-status error-text">{loaded.message}</div>;
  if (loaded.state === 'too-big') return <NoPreview path={path} why={`It's ${formatBytes(loaded.size)}, too big to preview here.`} />;
  if (loaded.state === 'binary') return <NoPreview path={path} why="There's no preview for this kind of file." />;

  const url = `${fileUrl(path)}&v=${encodeURIComponent(loaded.version)}`;
  const text = loaded.text ?? '';
  if (mode === 'code') return <CodeView text={text} language={type.language} />;
  switch (type.kind) {
    case 'html':
      return <iframe key={loaded.version} className="file-frame" title={name} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={pageDocument(text)} />;
    case 'markdown':
      return (
        <div className="file-doc">
          <Markdown text={text} />
        </div>
      );
    case 'csv':
      return <CsvTable text={text} separator={/\.tsv$/i.test(path) ? '\t' : ','} />;
    case 'notebook':
      return <NotebookView text={text} />;
    case 'svg':
      return <SvgImage text={text} name={name} />;
    case 'mermaid':
      return <ViewerFrame key={loaded.version} kind="mermaid" data={text} title={name} />;
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'pdf':
      return <ViewerFrame key={loaded.version} kind={type.kind} data={loaded.bytes!} title={name} />;
    case 'image':
      return (
        <div className="file-media">
          <img src={url} alt={name} />
        </div>
      );
    case 'audio':
      return (
        <div className="file-media">
          <audio src={url} controls />
        </div>
      );
    case 'video':
      return (
        <div className="file-media">
          <video src={url} controls />
        </div>
      );
    default:
      return <CodeView text={text} language={type.language} />;
  }
}

function NoPreview({ path, why }: { path: string; why: string }) {
  return (
    <div className="file-status">
      <FileIcon size={28} className="faint" />
      <p className="muted">{why}</p>
      <a className="btn sm" href={`${fileUrl(path)}&download=1`}>
        <Download size={13} /> Download
      </a>
    </div>
  );
}

/** Source code with line numbers, highlighted once highlight.js has loaded (it is split out of the main bundle). */
export function CodeView({ text, language, numbers = true }: { text: string; language?: string; numbers?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    setHtml(null);
    if (!language || text.length > MAX_HIGHLIGHT) return;
    let live = true;
    void import('highlight.js/lib/common').then(({ default: hljs }) => {
      if (live && hljs.getLanguage(language)) setHtml(hljs.highlight(text, { language, ignoreIllegals: true }).value);
    });
    return () => {
      live = false;
    };
  }, [text, language]);
  const lines = useMemo(() => {
    const n = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    return Array.from({ length: n }, (_, i) => i + 1).join('\n');
  }, [text]);
  return (
    <div className={`code-view ${numbers ? '' : 'bare'}`}>
      {numbers && (
        <pre className="code-lines" aria-hidden="true">
          {lines}
        </pre>
      )}
      {/* highlight.js escapes the text it marks up. */}
      {html !== null ? <pre className="code-text hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="code-text">{text}</pre>}
    </div>
  );
}

/** An agent's web page with the sandbox's policy put first, so nothing in the page runs before it applies. */
export function pageDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0];
  return doctype ? doctype + policy + html.slice(doctype.length) : policy + html;
}

/** Parse CSV (quoted fields, doubled quotes, CRLF) up to `limit` rows. */
export function parseCsv(text: string, separator: string, limit: number): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === separator) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      cell = '';
      row = [];
      if (rows.length > limit) return { rows: rows.slice(0, limit), more: true };
    } else cell += c;
  }
  if (cell !== '' || row.length) rows.push([...row, cell]);
  return { rows, more: false };
}

const NUMBER = /^\s*[-+]?[$€£¥]?\d[\d,]*(\.\d+)?%?\s*$/;

function CsvTable({ text, separator }: { text: string; separator: string }) {
  const { rows, more } = useMemo(() => parseCsv(text, separator, MAX_ROWS + 1), [text, separator]);
  if (!rows.length) return <div className="file-status muted">This table is empty.</div>;
  const [head, ...body] = rows;
  return (
    <div className="file-table">
      <table>
        <thead>
          <tr>
            <th className="row-no" />
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              <td className="row-no">{i + 1}</td>
              {r.map((c, j) => (
                <td key={j} className={NUMBER.test(c) ? 'num' : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more && <p className="small muted file-note">Showing the first {MAX_ROWS.toLocaleString()} rows. Download the file for the rest.</p>}
    </div>
  );
}

type NbSource = string | string[] | undefined;
interface NbOutput {
  output_type: string;
  text?: NbSource;
  name?: string;
  ename?: string;
  evalue?: string;
  data?: Record<string, NbSource>;
}
interface NbCell {
  cell_type: string;
  source: NbSource;
  execution_count?: number | null;
  outputs?: NbOutput[];
}
const joined = (s: NbSource) => (Array.isArray(s) ? s.join('') : (s ?? ''));

/** A Jupyter notebook: Markdown cells rendered, code cells highlighted, with their text and image outputs. */
function NotebookView({ text }: { text: string }) {
  const nb = useMemo(() => {
    try {
      return JSON.parse(text) as { cells?: NbCell[]; metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } } };
    } catch {
      return null;
    }
  }, [text]);
  if (!nb || !Array.isArray(nb.cells)) return <CodeView text={text} language="json" />;
  const language = nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? 'python';
  return (
    <div className="notebook">
      {nb.cells.map((cell, i) =>
        cell.cell_type === 'markdown' ? (
          <div key={i} className="nb-markdown">
            <Markdown text={joined(cell.source)} />
          </div>
        ) : cell.cell_type === 'code' ? (
          <div key={i} className="nb-cell">
            <div className="nb-prompt mono">[{cell.execution_count ?? ' '}]</div>
            <div className="nb-body">
              <CodeView text={joined(cell.source)} language={language} numbers={false} />
              {cell.outputs?.map((o, j) => <NotebookOutput key={j} output={o} />)}
            </div>
          </div>
        ) : (
          <pre key={i} className="nb-raw">
            {joined(cell.source)}
          </pre>
        ),
      )}
    </div>
  );
}

function NotebookOutput({ output: o }: { output: NbOutput }) {
  if (o.output_type === 'stream') return <pre className={`nb-out ${o.name === 'stderr' ? 'error-text' : ''}`}>{joined(o.text)}</pre>;
  if (o.output_type === 'error') return <pre className="nb-out error-text">{`${o.ename}: ${o.evalue}`}</pre>;
  const data = o.data ?? {};
  for (const type of ['image/png', 'image/jpeg', 'image/gif']) {
    if (data[type]) return <img className="nb-image" alt="Output" src={`data:${type};base64,${joined(data[type]).replace(/\s/g, '')}`} />;
  }
  if (data['image/svg+xml']) return <img className="nb-image" alt="Output" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(joined(data['image/svg+xml']))}`} />;
  if (data['text/plain']) return <pre className="nb-out">{joined(data['text/plain'])}</pre>;
  return null;
}

/** An SVG drawn as an image: scripts in it never run that way. */
function SvgImage({ text, name }: { text: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [text]);
  return <div className="file-media checker">{src && <img src={src} alt={name} />}</div>;
}

type ViewerKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'mermaid';

// Pinned versions, loaded only when someone opens that kind of file. pptx-preview is free to use but not open source.
// PDFs are drawn with pdf.js rather than the browser's viewer, which some browsers (phones, embedded ones) don't show in
// a frame. pdf.js runs on the frame's main thread (its worker script is loaded up front, and workers are blocked) and
// with eval off, which the policy blocks anyway.
const VIEWERS: Record<ViewerKind, string[]> = {
  docx: ['https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js'],
  xlsx: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'],
  pptx: ['https://cdn.jsdelivr.net/npm/pptx-preview@1.0.7/dist/pptx-preview.umd.js'],
  pdf: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'],
  mermaid: ['https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.min.js'],
};

const VIEWER_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--tb-bg);color:var(--tb-text);font:14px/1.5 var(--tb-font)}
#root{padding:20px}
.note{color:var(--tb-muted);text-align:center;margin:40px 16px}
.page{max-width:816px;margin:0 auto;padding:56px 64px;background:#fff;color:#111;border-radius:4px;box-shadow:0 2px 16px rgb(0 0 0 / 35%);font:15px/1.6 Calibri,Carlito,'Segoe UI',Arial,sans-serif;overflow-wrap:anywhere}
.page img{max-width:100%;height:auto}.page table{border-collapse:collapse;margin:12px 0}.page td,.page th{border:1px solid #ccc;padding:4px 10px}
@media (max-width:640px){#root{padding:12px}.page{padding:32px 24px}}
.page td p,.page th p{margin:0}.page h1.title{font-size:28px;margin:0 0 8px}.page .subtitle{color:#555;margin-top:0}
#root.xlsx{padding:0}
.sheet{overflow:auto;padding:12px 12px 56px}
.sheet table{border-collapse:collapse;font-size:13px}
.sheet td{border:1px solid var(--tb-border);padding:4px 8px;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
.sheet tr:first-child td{background:var(--tb-surface);font-weight:600;position:sticky;top:0}
.tabs{position:fixed;left:0;right:0;bottom:0;display:flex;gap:4px;overflow-x:auto;padding:8px 12px;background:var(--tb-surface);border-top:1px solid var(--tb-border)}
.tabs button{border:0;border-radius:8px;padding:5px 12px;background:none;color:var(--tb-muted);font:inherit;cursor:pointer;white-space:nowrap}
.tabs button.on{background:var(--tb-raised);color:var(--tb-text)}
#root.pptx{padding:20px 20px 0}#root.pptx .pptx-preview-wrapper{overflow-x:hidden!important}
.pdf-page{display:block;width:100%;margin:0 auto 14px;background:#fff;box-shadow:0 2px 12px rgb(0 0 0 / 30%)}
#root.mermaid{display:flex;justify-content:center}#root.mermaid svg{max-width:100%;height:auto}
`;

const VIEWER_JS = `
var root=document.getElementById('root');
function note(text){root.innerHTML='';var p=document.createElement('p');p.className='note';p.textContent=text;root.appendChild(p)}
var missing={docx:!window.mammoth,xlsx:!window.XLSX,pptx:!window.pptxPreview,pdf:!window.pdfjsLib||!window.pdfjsWorker,mermaid:!window.mermaid}[KIND];
async function render(data){
  if(missing)return note("The viewer for this file couldn't load (it comes from a CDN, so it needs internet). Download the file to open it.");
  if(KIND==='docx'){
    var r=await mammoth.convertToHtml({arrayBuffer:data},{styleMap:["p[style-name='Title'] => h1.title:fresh","p[style-name='Subtitle'] => p.subtitle:fresh"]});
    root.innerHTML='<article class="page">'+(r.value||'<p>(This document is empty.)</p>')+'</article>';
  }
  else if(KIND==='xlsx'){
    var wb=XLSX.read(data,{type:'array',sheetRows:MAX_ROWS+1,cellDates:true,cellFormula:true,sheetStubs:true});
    // Files written by a library (openpyxl) keep formulas without their results: show the formula.
    wb.SheetNames.forEach(function(name){var ws=wb.Sheets[name];Object.keys(ws).forEach(function(k){var c=ws[k];if(k[0]!=='!'&&c&&c.f&&(c.t==='z'||c.v===undefined)){c.t='s';c.v=c.w='='+c.f;}})});
    root.innerHTML='';var sheet=document.createElement('div');sheet.className='sheet';var tabs=document.createElement('nav');tabs.className='tabs';
    var showSheet=function(name,button){sheet.innerHTML=XLSX.utils.sheet_to_html(wb.Sheets[name],{header:'',footer:''});[].forEach.call(tabs.children,function(b){b.classList.toggle('on',b===button)})};
    wb.SheetNames.forEach(function(name){var b=document.createElement('button');b.textContent=name;b.onclick=function(){showSheet(name,b)};tabs.appendChild(b)});
    root.appendChild(sheet);if(wb.SheetNames.length>1)root.appendChild(tabs);
    if(wb.SheetNames.length)showSheet(wb.SheetNames[0],tabs.children[0]);else note('This workbook has no sheets.');
  }
  // The slides list scrolls inside a box the size of the frame; the library scales each slide to its width.
  else if(KIND==='pptx'){root.innerHTML='';await pptxPreview.init(root,{width:Math.max(240,Math.min(960,innerWidth-40)),height:Math.max(200,innerHeight-40),mode:'list'}).preview(data);}
  // Pages are drawn at the frame's width (sharp on high-density screens) and shrink with it.
  else if(KIND==='pdf'){
    var doc=await pdfjsLib.getDocument({data:new Uint8Array(data.slice(0)),isEvalSupported:false}).promise;
    root.innerHTML='';var width=Math.min(900,innerWidth-40),pages=Math.min(doc.numPages,MAX_PAGES);
    for(var i=1;i<=pages;i++){
      var page=await doc.getPage(i);var view=page.getViewport({scale:width/page.getViewport({scale:1}).width*(devicePixelRatio||1)});
      var c=document.createElement('canvas');c.className='pdf-page';c.width=Math.floor(view.width);c.height=Math.floor(view.height);c.style.maxWidth=width+'px';
      root.appendChild(c);await page.render({canvasContext:c.getContext('2d'),viewport:view}).promise;
    }
    if(doc.numPages>pages){var more=document.createElement('p');more.className='note';more.textContent='Showing the first '+pages+' of '+doc.numPages+' pages. Download the file for the rest.';root.appendChild(more);}
  }
  else if(KIND==='mermaid'){mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:DARK?'dark':'default'});var out=await mermaid.render('diagram',String(data));root.innerHTML=out.svg;}
}
var shown=null;
function show(data){shown=data;render(data).catch(function(err){note("Couldn't show this file: "+String(err&&err.message||err))});}
addEventListener('message',function(e){
  if(e.source!==parent)return;var d=e.data;if(!d||d.teambot!==true||d.type!=='file')return;
  show(d.data);
});
// Slides are drawn at a fixed size: draw them again when the panel is resized.
var redraw;
addEventListener('resize',function(){if(KIND!=='pptx'||shown===null)return;clearTimeout(redraw);redraw=setTimeout(function(){show(shown)},250);});
parent.postMessage({teambot:true,type:'ready'},'*');
`;

function viewerDocument(kind: ViewerKind, scheme: string): string {
  const setup = `var KIND=${scriptJson(kind)},DARK=${scheme === 'dark'},MAX_ROWS=${MAX_ROWS},MAX_PAGES=${MAX_PAGES};`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${themeTokens(scheme)}${inside(VIEWER_CSS, 'style')}</style>
</head><body><div id="root" class="${kind}"><p class="note">Opening…</p></div>
${VIEWERS[kind].map((src) => `<script src="${src}"></script>`).join('')}
<script>${inside(setup + VIEWER_JS, 'script')}</script></body></html>`;
}

/**
 * A document drawn by a viewer library inside the sandbox. The frame says when it is ready, then gets the file (a copy:
 * the bytes stay usable here). A changed file gets a new frame (the caller keys it by version).
 */
function ViewerFrame({ kind, data, title }: { kind: ViewerKind; data: ArrayBuffer | string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const scheme = useScheme();
  const doc = useMemo(() => viewerDocument(kind, scheme), [kind, scheme]);
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      const d = e.data as { teambot?: boolean; type?: string } | null;
      const target = frame.current?.contentWindow;
      if (!target || e.source !== target || d?.teambot !== true || d.type !== 'ready') return;
      target.postMessage({ teambot: true, type: 'file', data: latest.current }, '*');
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);
  return <iframe ref={frame} className="file-frame viewer" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} />;
}

const ICONS: Record<FileKind, typeof FileIcon> = {
  html: AppWindow,
  markdown: FileText,
  code: FileCode2,
  csv: FileSpreadsheet,
  notebook: NotebookText,
  mermaid: Workflow,
  svg: FileImage,
  image: FileImage,
  pdf: FileText,
  audio: FileAudio,
  video: FileVideo,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  other: FileIcon,
};

export function FileTypeIcon({ type, size = 16, className }: { type: FileType; size?: number; className?: string }) {
  const Icon = ICONS[type.kind];
  return <Icon size={size} className={className} aria-hidden="true" />;
}

/** Preview / Code, for files that have both. */
export function FileModeToggle({ path, mode, onChange }: { path: string; mode: FileMode; onChange: (mode: FileMode) => void }) {
  const modes = modesFor(fileType(path).kind);
  if (modes.length < 2) return null;
  return (
    <div className="seg" role="tablist" aria-label="View">
      {modes.map((m) => (
        <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => onChange(m)}>
          {m === 'preview' ? 'Preview' : 'Code'}
        </button>
      ))}
    </div>
  );
}

/** The view a file opens in (its default), starting over when another file is opened. */
export function useFileMode(path: string): [FileMode, (mode: FileMode) => void] {
  const [chosen, setChosen] = useState<{ path: string; mode: FileMode } | null>(null);
  const mode = chosen?.path === path ? chosen.mode : modesFor(fileType(path).kind)[0];
  return [mode, (m) => setChosen({ path, mode: m })];
}
