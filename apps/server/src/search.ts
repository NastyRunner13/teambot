// Search across past conversations and the task board. Every term must appear; newest first.
import type { SearchResults } from '@teambot/shared';
import type { App } from './app.js';

export function searchTerms(query: string): string[] {
  const terms = (query.match(/"[^"]+"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, '').trim()).filter((t) => t.length >= 2);
  return [...new Set(terms.map((t) => t.toLowerCase()))].slice(0, 6);
}

/** A short excerpt around the first matching term. */
export function snippet(text: string, terms: string[], width = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, at - width);
  const end = Math.min(flat.length, at + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** `workingIn`: an agent's search also leaves out what the people in that conversation can't see (see canSeeFrom). */
export function search(app: App, query: string, opts: { limit?: number; viewerId?: string; workingIn?: string | null } = {}): SearchResults {
  const terms = searchTerms(query);
  const ws = app.workspace;
  const messages = app.store.searchMessages(terms, { limit: opts.limit ?? 30 }).flatMap((message) => {
    const channel = app.store.getChannel(message.channelId);
    if (!channel || (opts.viewerId && !ws.canSee(channel, opts.viewerId))) return [];
    if (opts.viewerId && opts.workingIn !== undefined && !ws.canSeeFrom(channel, opts.viewerId, opts.workingIn)) return [];
    const where = `${ws.channelLabel(channel, opts.viewerId)}${message.threadId ? ' (thread)' : ''}`;
    return [{ message, where, snippet: snippet(message.text, terms) }];
  });
  const tasks = app.store.searchTasks(terms, Math.min(opts.limit ?? 30, 20)).map((task) => ({
    task,
    snippet: snippet([task.title, task.description, ...task.notes.map((n) => n.text)].join(' · '), terms),
  }));
  return { query, messages, tasks };
}
