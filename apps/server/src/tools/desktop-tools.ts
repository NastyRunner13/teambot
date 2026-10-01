// Full desktop control (opt-in per agent): screenshots plus mouse and keyboard on the agent's display.
// Policy still applies: before a click or keystroke, computerd reports what is under the pointer (or focused).
// In the browser that is the page element, so rules like "confirm clicks on Send" cover coordinate clicks too.
import { z } from 'zod';
import { defineTool, hostOf, type PolicyFacts, type ToolContext, type ToolDef, type ToolOutput } from './types.js';

interface Screen {
  image: string;
  mime: string;
  width: number;
  height: number;
}
interface Described {
  window: string;
  url: string;
  element: { name: string; type: string; role: string } | null;
}

const desktopOn = (agent: { desktop: boolean }) => agent.desktop;

async function describe(ctx: ToolContext, point?: { x: number; y: number }): Promise<PolicyFacts> {
  const c = await ctx.computer();
  const d = await c.call<Described>('/desktop/describe', point ?? {}, { timeoutMs: 15_000, signal: ctx.signal });
  return {
    url: d.url || undefined,
    domain: hostOf(d.url),
    // Inside the browser the page element is the target; elsewhere, the window it lands in.
    target: d.element ? d.element.name : d.window,
    fieldType: d.element?.type || undefined,
  };
}

async function act(ctx: ToolContext, path: string, body: Record<string, unknown>, what: string): Promise<ToolOutput> {
  const c = await ctx.computer();
  const s = await c.call<Screen>(path, body, { timeoutMs: 60_000, signal: ctx.signal });
  return { text: `${what} Screen is ${s.width}x${s.height}; the screenshot after it is attached.`, images: [{ mime: s.mime, data: s.image }] };
}

const at = (f: PolicyFacts) => (f.target ? ` on "${f.target}"` : '') + (f.domain ? ` (${f.domain})` : '');
const xy = { x: z.number().int().min(0).describe('Pixels from the left of the screenshot'), y: z.number().int().min(0).describe('Pixels from the top') };

export function desktopTools(): ToolDef[] {
  return [
    defineTool({
      name: 'computer_screenshot',
      description:
        'See your whole screen (all windows, not just the web page). Use it with the other computer_* tools for desktop apps, or for pages the browser_* tools cannot handle.',
      risk: 'read',
      available: desktopOn,
      schema: z.object({}),
      summarize: () => 'Take a screenshot',
      execute: (_a, ctx) => act(ctx, '/desktop/screenshot', {}, 'Took a screenshot.'),
    }),

    defineTool({
      name: 'computer_click',
      description: 'Click at a point on the screen, in pixels of the latest screenshot. Returns a new screenshot.',
      risk: 'write',
      available: desktopOn,
      schema: z.object({ ...xy, button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional() }),
      facts: (a, ctx) => describe(ctx, { x: a.x, y: a.y }),
      summarize: (a, f) => `${a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click'} at (${a.x}, ${a.y})${at(f)}`,
      execute: (a, ctx) => act(ctx, '/desktop/click', a, `Clicked at (${a.x}, ${a.y}).`),
    }),

    defineTool({
      name: 'computer_type',
      description: 'Type text into whatever has keyboard focus (click the field first). Use {{secret:NAME}} for stored secrets. Returns a new screenshot.',
      risk: 'write',
      available: desktopOn,
      schema: z.object({ text: z.string().min(1) }),
      facts: (_a, ctx) => describe(ctx),
      summarize: (a, f) => `Type "${a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text}"${at(f)}`,
      execute: (a, ctx) => act(ctx, '/desktop/type', { text: a.text }, 'Typed the text.'),
    }),

    defineTool({
      name: 'computer_key',
      description: 'Press keys, xdotool style: "Return", "Escape", "Tab", "ctrl+l", "ctrl+shift+t", "alt+F4". Several presses separated by spaces. Returns a new screenshot.',
      risk: 'write',
      available: desktopOn,
      schema: z.object({ key: z.string().min(1) }),
      facts: (_a, ctx) => describe(ctx),
      summarize: (a, f) => `Press ${a.key}${at(f)}`,
      execute: (a, ctx) => act(ctx, '/desktop/key', { key: a.key }, `Pressed ${a.key}.`),
    }),

    defineTool({
      name: 'computer_scroll',
      description: 'Scroll at a point on the screen. amount is in wheel clicks (default 5). Returns a new screenshot.',
      risk: 'read',
      available: desktopOn,
      schema: z.object({ ...xy, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(30).optional() }),
      summarize: (a) => `Scroll ${a.direction} at (${a.x}, ${a.y})`,
      execute: (a, ctx) => act(ctx, '/desktop/scroll', a, `Scrolled ${a.direction}.`),
    }),

    defineTool({
      name: 'computer_drag',
      description: 'Drag with the left mouse button from one point to another. Returns a new screenshot.',
      risk: 'write',
      available: desktopOn,
      schema: z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }),
      facts: (a, ctx) => describe(ctx, { x: a.from_x, y: a.from_y }),
      summarize: (a, f) => `Drag from (${a.from_x}, ${a.from_y}) to (${a.to_x}, ${a.to_y})${at(f)}`,
      execute: (a, ctx) => act(ctx, '/desktop/drag', a, 'Dragged.'),
    }),
  ];
}
