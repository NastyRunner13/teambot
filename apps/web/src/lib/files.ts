// What a file in /shared is, from its name: how it previews, what to call it, and how to highlight it as code.

export type FileKind =
  | 'html'
  | 'markdown'
  | 'code'
  | 'csv'
  | 'notebook'
  | 'mermaid'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  /** Anything else: shown as text when it is text, otherwise offered as a download. */
  | 'other';

/** Preview draws the file (a page running, a table, a document); code shows its source. */
export type FileMode = 'preview' | 'code';

export interface FileType {
  kind: FileKind;
  /** For a file card: "Code", "Web page", "Document"… */
  label: string;
  /** The extension in capitals, e.g. "PY". */
  ext: string;
  /** highlight.js language for the source; none for plain text. */
  language?: string;
}

const LANGUAGES: Record<string, string> = {
  py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  mts: 'typescript', cts: 'typescript', json: 'json', jsonl: 'json', ipynb: 'json', geojson: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', r: 'r', lua: 'lua', pl: 'perl', pm: 'perl', md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff',
  graphql: 'graphql', gql: 'graphql', mk: 'makefile', vb: 'vbnet', m: 'objectivec',
};
const NAMED: Record<string, string> = { makefile: 'makefile', dockerfile: 'bash', '.env': 'ini', '.gitignore': 'bash' };

const KINDS: Record<string, [FileKind, string]> = {
  html: ['html', 'Web page'], htm: ['html', 'Web page'],
  md: ['markdown', 'Document'], markdown: ['markdown', 'Document'],
  csv: ['csv', 'Table'], tsv: ['csv', 'Table'],
  ipynb: ['notebook', 'Notebook'],
  mmd: ['mermaid', 'Diagram'], mermaid: ['mermaid', 'Diagram'],
  svg: ['svg', 'Image'],
  png: ['image', 'Image'], jpg: ['image', 'Image'], jpeg: ['image', 'Image'], gif: ['image', 'Image'], webp: ['image', 'Image'],
  avif: ['image', 'Image'], bmp: ['image', 'Image'], ico: ['image', 'Image'],
  pdf: ['pdf', 'PDF'],
  mp3: ['audio', 'Audio'], wav: ['audio', 'Audio'], ogg: ['audio', 'Audio'], m4a: ['audio', 'Audio'], flac: ['audio', 'Audio'],
  mp4: ['video', 'Video'], webm: ['video', 'Video'], mov: ['video', 'Video'],
  docx: ['docx', 'Word document'],
  xlsx: ['xlsx', 'Spreadsheet'], xlsm: ['xlsx', 'Spreadsheet'], xls: ['xlsx', 'Spreadsheet'], ods: ['xlsx', 'Spreadsheet'],
  pptx: ['pptx', 'Slides'],
};

export const fileName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

export function fileType(path: string): FileType {
  const name = fileName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const language = LANGUAGES[ext] ?? NAMED[name];
  const known = KINDS[ext];
  if (known) return { kind: known[0], label: known[1], ext: ext.toUpperCase(), language };
  if (language || ['txt', 'log', 'text', 'tex', 'rst', 'env'].includes(ext)) return { kind: 'code', label: ext === 'txt' || ext === 'log' ? 'Text' : 'Code', ext: ext.toUpperCase() || 'TEXT', language };
  return { kind: 'other', label: 'File', ext: ext.toUpperCase() || 'FILE' };
}

/** The views a kind of file has, the default first. */
export function modesFor(kind: FileKind): FileMode[] {
  switch (kind) {
    case 'html':
    case 'markdown':
    case 'csv':
    case 'notebook':
    case 'mermaid':
    case 'svg':
      return ['preview', 'code'];
    case 'code':
    case 'other':
      return ['code'];
    default:
      return ['preview'];
  }
}

/** Kinds whose source is text, so it can be copied. */
export const isText = (kind: FileKind) => modesFor(kind).includes('code');

/** How a file is read for its view: as text, as bytes for a viewer in the sandbox, or not at all (the browser loads its URL). */
export function readAs(kind: FileKind, mode: FileMode): 'text' | 'bytes' | 'url' {
  if (mode === 'code') return 'text';
  if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'pdf') return 'bytes';
  if (kind === 'image' || kind === 'audio' || kind === 'video') return 'url';
  return 'text';
}

export const fileUrl = (path: string) => `/api/shared/file?path=${encodeURIComponent(path)}`;
