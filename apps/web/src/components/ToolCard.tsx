// Inline tool cards (after OpenDots): each action an agent took, as a card in the conversation, with what it acted on
// (the command, the site, the file, the page) and how it went, opening to its output, screenshots or the page it
// wrote. Built from the run's events: tool.checked (the policy's decision), tool.started (the arguments, secrets
// redacted), tool.finished (the start of the output) and approval.resolved (a person's answer).
import {
  Ban,
  BookOpen,
  Brain,
  Camera,
  Check,
  ChevronRight,
  Code,
  Eye,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  LayoutTemplate,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Monitor,
  MousePointerClick,
  Plug,
  Search,
  ShieldQuestion,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { PROGRESS_TOOL, type EventRecord } from '@teambot/shared';
import { useStore } from '../store';

export type CallState = 'running' | 'ok' | 'failed' | 'blocked' | 'waiting' | 'declined';

export interface ToolCall {
  id: string;
  tool: string;
  summary: string;
  state: CallState;
  /** The arguments it ran with (absent when it never started). */
  args?: Record<string, unknown>;
  preview?: string;
  images?: string[];
  ms?: number;
  /** Why it didn't run: the rule that blocked it, or the person's note. */
  why?: string;
}

/** The run's tool calls, in order, from its events. The checklist (update_progress) isn't one. */
export function toolCalls(events: EventRecord[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.type === 'tool.checked') {
      if (d.tool === PROGRESS_TOOL) continue;
      const state: CallState = d.action === 'deny' ? 'blocked' : d.action === 'ask' || d.action === 'handoff' ? 'waiting' : 'running';
      const call: ToolCall = { id: d.toolCallId, tool: d.tool, summary: d.summary, state, ...(state === 'blocked' ? { why: d.rule } : {}) };
      byId.set(call.id, call);
      calls.push(call);
    } else if (e.type === 'tool.started') {
      const call = byId.get(d.toolCallId);
      if (call) Object.assign(call, { args: d.args, state: 'running' });
    } else if (e.type === 'tool.finished') {
      const call = byId.get(d.toolCallId);
      // A command that ran but exited non-zero did its job as a tool call, but it is a failure to the person reading.
      const exit = d.tool === 'shell' ? /^exit code: (\S+)/.exec(String(d.preview ?? ''))?.[1] : undefined;
      if (call) Object.assign(call, { state: d.ok && (exit === undefined || exit === '0') ? 'ok' : 'failed', preview: d.preview, images: d.images, ms: d.ms });
    } else if (e.type === 'approval.resolved' && d.approval) {
      const call = byId.get(d.approval.toolCallId);
      const status = d.approval.status as string;
      if (call && call.state === 'waiting' && status !== 'approved') {
        call.state = status === 'done' ? 'ok' : 'declined';
        call.why = status === 'done' ? `A person did this step${d.approval.note ? `: “${d.approval.note}”` : ''}` : status === 'cancelled' ? 'The request was withdrawn' : `A person said no${d.approval.note ? `: “${d.approval.note}”` : ''}`;
      }
    }
  }
  return calls;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const hostOf = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
};
/** The page a page tool acted on, from its result ("… [Title](/pages/page_…) …"). */
const pageIn = (text: string | undefined) => text?.match(/\[([^\]]*)\]\(\/pages\/(page_[\w-]+)\)/);

interface Look {
  icon: LucideIcon;
  /** While it runs (or waits for a person), and once it ran. */
  title: [string, string];
  detail?: string;
  mono?: boolean;
  page?: { id: string; title: string };
  file?: string;
}

/** How a call reads on its card. Unknown tools fall back to their one-line summary. */
function lookOf(c: ToolCall): Look {
  const a = c.args ?? {};
  const page = pageIn(c.preview);
  const pageLink = page ? { id: page[2], title: page[1] } : undefined;
  if (c.tool === 'shell') return { icon: Terminal, title: ['Running a command', c.state === 'failed' ? 'Command failed' : 'Ran a command'], detail: str(a.command) && `$ ${str(a.command)}`, mono: true };
  if (c.tool === 'browser_navigate') return { icon: Globe, title: [`Opening ${hostOf(str(a.url)) ?? 'a page'}`, `Opened ${hostOf(str(a.url)) ?? 'a page'}`], detail: str(a.url), mono: true };
  if (c.tool === 'browser_snapshot') return { icon: Eye, title: ['Reading the page', 'Read the page'] };
  if (c.tool === 'browser_screenshot' || c.tool === 'computer_screenshot') return { icon: Camera, title: ['Taking a screenshot', 'Took a screenshot'] };
  if (c.tool.startsWith('browser_')) return { icon: MousePointerClick, title: [c.summary, c.summary] };
  if (c.tool.startsWith('computer_')) return { icon: Monitor, title: [c.summary, c.summary] };
  if (c.tool === 'read_file' || c.tool === 'write_file') {
    const path = str(a.path);
    return { icon: FileText, title: c.tool === 'read_file' ? ['Reading a file', 'Read a file'] : ['Saving a file', a.append ? 'Added to a file' : 'Saved a file'], detail: path, mono: true, file: path?.startsWith('/shared/') ? path : undefined };
  }
  if (c.tool === 'list_files') return { icon: FolderOpen, title: ['Listing files', 'Listed files'], detail: str(a.path) ?? 'workspace', mono: true };
  if (c.tool === 'list_pages') return { icon: FileText, title: ['Looking through pages', 'Looked through pages'], detail: str(a.query) };
  if (c.tool === 'read_page') return { icon: FileText, title: ['Reading a page', 'Read a page'], detail: pageLink?.title ?? str(a.page), page: pageLink };
  if (c.tool === 'create_page') return { icon: FileText, title: ['Creating a page', 'Created a page'], detail: str(a.title), page: pageLink };
  if (c.tool === 'edit_page') return { icon: FileText, title: ['Editing a page', 'Edited a page'], detail: pageLink?.title ?? str(a.page), page: pageLink };
  if (c.tool === 'propose_page') return { icon: FileText, title: ['A page for you to review', 'Saved a page you approved'], detail: str(a.title), page: pageLink };
  if (c.tool === 'list_page_comments') return { icon: MessagesSquare, title: ['Reading comments on a page', 'Read comments on a page'], detail: pageLink?.title ?? str(a.page), page: pageLink };
  if (c.tool === 'comment_on_page')
    return { icon: MessagesSquare, title: a.reply_to ? ['Replying to a comment', 'Replied to a comment'] : ['Commenting on a page', 'Commented on a page'], detail: str(a.text), page: pageLink };
  if (c.tool === 'resolve_comment')
    return { icon: MessagesSquare, title: a.resolved === false ? ['Reopening a comment thread', 'Reopened a comment thread'] : ['Resolving a comment thread', 'Resolved a comment thread'], detail: pageLink?.title, page: pageLink };
  if (c.tool === 'show_ui' || c.tool.startsWith('ui_')) return { icon: LayoutTemplate, title: ['Drawing', 'Showed'], detail: str(a.title) ?? c.summary.replace(/^Show /, '') };
  if (c.tool === 'draft_component') return { icon: LayoutTemplate, title: ['Drafting a component', 'Drafted a component'], detail: str(a.name) && `ui_${str(a.name)}`, mono: true };
  if (c.tool === 'ask_agent' || c.tool === 'send_dm' || c.tool === 'post_message' || c.tool === 'read_channel') return { icon: MessageSquare, title: [c.summary, c.summary] };
  if (c.tool === 'ask_for_approval') return { icon: ShieldQuestion, title: ['Asking for your approval', 'You approved'], detail: str(a.action) };
  if (c.tool === 'request_human_takeover') return { icon: Hand, title: ['Asking you to take over', 'You took over and handed back'], detail: str(a.reason) };
  if (c.tool === 'use_skill') return { icon: BookOpen, title: ['Loading a skill', 'Loaded a skill'], detail: str(a.name), mono: true };
  if (c.tool === 'remember' || c.tool === 'forget') return { icon: Brain, title: [c.summary, c.summary] };
  if (c.tool === 'search_history') return { icon: Search, title: [c.summary, c.summary] };
  if (c.tool === 'run_coding_agent') return { icon: Code, title: ['Coding agent at work', 'Coding agent finished'], detail: str(a.task) };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(c.tool);
  if (mcp) return { icon: Plug, title: [`Using ${mcp[1]}`, `Used ${mcp[1]}`], detail: mcp[2], mono: true };
  return { icon: Wrench, title: [c.summary, c.summary] };
}

const STATE: Record<CallState, { icon: React.ReactNode; label: string }> = {
  running: { icon: <Loader2 size={12} className="spin" />, label: 'Working' },
  ok: { icon: <Check size={12} />, label: 'Done' },
  failed: { icon: <X size={12} />, label: 'Failed' },
  blocked: { icon: <Ban size={12} />, label: 'Blocked' },
  waiting: { icon: <ShieldQuestion size={12} />, label: 'Waiting for you' },
  declined: { icon: <Hand size={12} />, label: 'Not done' },
};

/** One action. Opens to its output, screenshots and links, when it has any. */
export function ToolCard({ call, defaultOpen = false }: { call: ToolCall; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [, navigate] = useLocation();
  const openFile = useStore((s) => s.openFile);
  const look = lookOf(call);
  const Icon = look.icon;
  // Under way, it says what it is doing; once run, what it did; when it never ran, what it would have done.
  const title = call.state === 'running' || call.state === 'waiting' ? look.title[0] : call.state === 'ok' || call.state === 'failed' ? look.title[1] : call.summary;
  const output = call.preview?.trim();
  const hasBody = !!(output || call.images?.length || call.why || look.page || look.file);
  const state = STATE[call.state];

  return (
    <div className={`tool-card ${call.state} ${open ? 'open' : ''}`}>
      <button type="button" className="tool-card-head" aria-expanded={hasBody ? open : undefined} disabled={!hasBody} onClick={() => setOpen(!open)}>
        <span className="tool-card-icon">
          <Icon size={14} />
        </span>
        <span className="tool-card-text">
          <span className="tool-card-title ellipsis">{title}</span>
          {look.detail && <span className={`tool-card-detail ellipsis ${look.mono ? 'mono' : ''}`}>{look.detail}</span>}
        </span>
        <span className={`tool-card-state ${call.state}`} title={state.label}>
          {state.icon}
          <span>{call.ms !== undefined && call.state !== 'failed' ? `${(call.ms / 1000).toFixed(1)}s` : state.label}</span>
        </span>
        {hasBody && <ChevronRight size={14} className="chev" />}
      </button>
      {open && hasBody && (
        <div className="tool-card-body">
          {call.why && <p className="tool-card-why">{call.why}</p>}
          {(look.page || look.file) && (
            <div className="tool-card-links">
              {look.page && (
                <a href={`/pages/${look.page.id}`} onClick={(e) => (e.preventDefault(), navigate(`/pages/${look.page!.id}`))}>
                  <FileText size={13} /> Open “{look.page.title}”
                </a>
              )}
              {look.file && (
                <button type="button" className="link-btn" onClick={() => openFile(look.file!)}>
                  <FileText size={13} /> Open {look.file.split('/').pop()}
                </button>
              )}
            </div>
          )}
          {output && <pre className="tool-card-output">{output}</pre>}
          {call.images?.map((ref) => (
            <a key={ref} href={`/api/${ref}`} target="_blank" rel="noreferrer" className="tool-card-shot" title="Open the screenshot">
              <img src={`/api/${ref}`} alt="Screenshot the agent took" loading="lazy" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** A run's actions as cards. */
export function ToolCards({ calls }: { calls: ToolCall[] }) {
  return (
    <div className="tool-cards">
      {calls.map((c) => (
        <ToolCard key={c.id} call={c} />
      ))}
    </div>
  );
}
