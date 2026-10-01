// Full desktop control: screenshots plus mouse and keyboard through xdotool, on the same display
// humans watch live. Every action returns a fresh screenshot so the model sees what happened.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SHOT = '/tmp/teambot-screen.jpg';
const SETTLE_MS = 500;

export interface Screen {
  image: string;
  mime: 'image/jpeg';
  width: number;
  height: number;
}

async function xdotool(...args: string[]): Promise<string> {
  const { stdout } = await exec('xdotool', args, { env: process.env, timeout: 15_000 });
  return stdout.trim();
}

async function geometry(): Promise<{ width: number; height: number }> {
  const [w, h] = (await xdotool('getdisplaygeometry')).split(/\s+/).map(Number);
  return { width: w, height: h };
}

export async function screenshot(): Promise<Screen> {
  await exec('scrot', ['--overwrite', '--silent', '--quality', '75', SHOT], { env: process.env, timeout: 15_000 });
  const image = (await fs.readFile(SHOT)).toString('base64');
  return { image, mime: 'image/jpeg', ...(await geometry()) };
}

async function point(body: Record<string, unknown>, xKey = 'x', yKey = 'y'): Promise<[string, string]> {
  const x = Number(body[xKey]);
  const y = Number(body[yKey]);
  const { width, height } = await geometry();
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(`(${body[xKey]}, ${body[yKey]}) is off the screen; it is ${width}x${height} pixels`);
  }
  return [String(x), String(y)];
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));
const BUTTONS: Record<string, string> = { left: '1', middle: '2', right: '3' };

export async function click(body: Record<string, unknown>): Promise<Screen> {
  const [x, y] = await point(body);
  const button = BUTTONS[String(body.button ?? 'left')] ?? '1';
  await xdotool('mousemove', '--sync', x, y, 'click', '--repeat', body.double ? '2' : '1', '--delay', '80', button);
  await settle();
  return screenshot();
}

export async function type(body: Record<string, unknown>): Promise<Screen> {
  const text = String(body.text ?? '');
  if (!text) throw new Error('text is required');
  await xdotool('type', '--delay', '15', '--', text);
  await settle();
  return screenshot();
}

export async function key(body: Record<string, unknown>): Promise<Screen> {
  const keys = String(body.key ?? '').trim();
  if (!keys) throw new Error('key is required, e.g. "Return", "ctrl+l" or "alt+Tab"');
  await xdotool('key', '--delay', '50', '--', ...keys.split(/\s+/));
  await settle();
  return screenshot();
}

export async function scroll(body: Record<string, unknown>): Promise<Screen> {
  const [x, y] = await point(body);
  const button = { up: '4', down: '5', left: '6', right: '7' }[String(body.direction)] ?? '5';
  const amount = String(Math.min(Math.max(Math.round(Number(body.amount ?? 5)), 1), 30));
  await xdotool('mousemove', '--sync', x, y, 'click', '--repeat', amount, '--delay', '30', button);
  await settle();
  return screenshot();
}

export async function drag(body: Record<string, unknown>): Promise<Screen> {
  const [x1, y1] = await point(body, 'from_x', 'from_y');
  const [x2, y2] = await point(body, 'to_x', 'to_y');
  await xdotool('mousemove', '--sync', x1, y1, 'mousedown', '1', 'mousemove', '--sync', x2, y2, 'mouseup', '1');
  await settle();
  return screenshot();
}

/** The focused window: its title and where it is on the screen. */
export async function activeWindow(): Promise<{ name: string; x: number; y: number; width: number; height: number } | null> {
  try {
    const id = await xdotool('getactivewindow');
    const name = await xdotool('getwindowname', id);
    const geo = Object.fromEntries(
      (await xdotool('getwindowgeometry', '--shell', id))
        .split('\n')
        .map((l) => l.split('='))
        .map(([k, v]) => [k, Number(v)]),
    ) as Record<string, number>;
    return { name, x: geo.X ?? 0, y: geo.Y ?? 0, width: geo.WIDTH ?? 0, height: geo.HEIGHT ?? 0 };
  } catch {
    return null;
  }
}
