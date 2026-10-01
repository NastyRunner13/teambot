// computerd: the tool API inside an agent's computer.
// Only the TeamBot server talks to it, authenticated with a per-agent bearer token.
import http from 'node:http';
import { cancelAll, runShell } from './shell.js';
import { listFiles, readFile, writeFile } from './files.js';
import { BrowserController } from './browser.js';
import * as desktop from './desktop.js';

const TOKEN = process.env.COMPUTERD_TOKEN ?? '';
const PORT = Number(process.env.COMPUTERD_PORT ?? 7070);
const MAX_BODY = 8 * 1024 * 1024;

if (!TOKEN) {
  console.error('COMPUTERD_TOKEN is not set; refusing to start');
  process.exit(1);
}

const browser = new BrowserController();

/** `signal` aborts when the caller goes away (the server cancelled its request). */
type Handler = (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

const routes: Record<string, Handler> = {
  'GET /health': async () => ({ ok: true, browser: await browser.ping() }),
  'POST /shell': (b, signal) => runShell(b, signal),
  // The server calls this when a run is paused, cancelled or taken over, and waits for the answer.
  'POST /cancel': async () => ({ killed: cancelAll() }),
  'POST /fs/read': (b) => readFile(b),
  'POST /fs/write': (b) => writeFile(b),
  'POST /fs/list': (b) => listFiles(b),
  'POST /browser/navigate': (b) => browser.navigate(String(b.url ?? '')),
  'POST /browser/snapshot': () => browser.snapshot(),
  'POST /browser/describe': (b) => browser.describe(b.ref === undefined ? undefined : Number(b.ref)),
  'POST /browser/click': (b) => browser.click(Number(b.ref)),
  'POST /browser/type': (b) =>
    browser.type(Number(b.ref), String(b.text ?? ''), Boolean(b.submit), b.clear !== false),
  'POST /browser/press': (b) => browser.press(String(b.key ?? '')),
  'POST /browser/scroll': (b) =>
    browser.scroll(b.direction === 'up' ? 'up' : 'down', Number(b.amount ?? 1)),
  'POST /browser/back': () => browser.back(),
  'POST /browser/tabs': () => browser.tabs(),
  'POST /browser/switch_tab': (b) => browser.switchTab(Number(b.index)),
  'POST /desktop/screenshot': () => desktop.screenshot(),
  'POST /desktop/click': (b) => desktop.click(b),
  'POST /desktop/type': (b) => desktop.type(b),
  'POST /desktop/key': (b) => desktop.key(b),
  'POST /desktop/scroll': (b) => desktop.scroll(b),
  'POST /desktop/drag': (b) => desktop.drag(b),
  // What a desktop action would touch: the focused window and, inside the browser, the page element.
  'POST /desktop/describe': async (b) => {
    const win = await desktop.activeWindow();
    const point = b.x === undefined ? null : { x: Number(b.x), y: Number(b.y) };
    const inBrowser =
      !!win && /chromium/i.test(win.name) && (!point || (point.x >= win.x && point.x < win.x + win.width && point.y >= win.y && point.y < win.y + win.height));
    if (!inBrowser) return { window: win?.name ?? '', url: '', element: null };
    const d = point ? await browser.describeAt(point.x, point.y) : await browser.describe();
    return { window: win!.name, ...d };
  },
};

function send(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  const route = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
  if (!route) return send(res, 404, { error: 'not found' });
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  try {
    const body = await readBody(req);
    const result = await route(body, gone.signal);
    send(res, 200, { result });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`computerd listening on ${PORT}`));
