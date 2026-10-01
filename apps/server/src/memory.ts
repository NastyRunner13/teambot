// Long-term memory as plain Markdown files you can open, edit and delete:
//   <data>/memory/team.md              shared by every agent (preferences about the team and its work)
//   <data>/memory/agents/<Name>.md     one agent's own notes
// Agents add to them with `remember` and prune them with `forget`; both files go into every prompt.
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '@teambot/shared';

export type MemoryScope = 'team' | 'agent';

export const MAX_MEMORY_BYTES = 32_000;
/** How much of each file goes into a prompt. */
const PROMPT_CHARS = 8_000;

export class MemoryStore {
  constructor(readonly dir: string) {}

  file(scope: MemoryScope, agent?: Pick<Agent, 'name'>): string {
    if (scope === 'team') return path.join(this.dir, 'team.md');
    if (!agent) throw new Error('agent memory needs an agent');
    return path.join(this.dir, 'agents', `${agent.name}.md`);
  }

  read(scope: MemoryScope, agent?: Pick<Agent, 'name'>): string {
    const file = this.file(scope, agent);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  write(scope: MemoryScope, content: string, agent?: Pick<Agent, 'name'>) {
    if (Buffer.byteLength(content) > MAX_MEMORY_BYTES) throw new Error(`Memory is limited to ${MAX_MEMORY_BYTES / 1000} KB. Remove outdated notes first.`);
    const file = this.file(scope, agent);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content.trim() ? `${content.trimEnd()}\n` : '');
  }

  /** Add one dated bullet. */
  remember(scope: MemoryScope, note: string, by: string, agent?: Pick<Agent, 'name'>): string {
    const line = `- ${note.replace(/\s*\n\s*/g, ' ').trim()} (${scope === 'team' ? `${by}, ` : ''}${new Date().toISOString().slice(0, 10)})`;
    const current = this.read(scope, agent);
    this.write(scope, current.trim() ? `${current.trimEnd()}\n${line}` : line, agent);
    return line;
  }

  /** Remove the lines that contain `text` (case-insensitive). Returns them. */
  forget(scope: MemoryScope, text: string, agent?: Pick<Agent, 'name'>): string[] {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];
    const lines = this.read(scope, agent).split('\n');
    const removed = lines.filter((l) => l.toLowerCase().includes(needle));
    if (removed.length) this.write(scope, lines.filter((l) => !l.toLowerCase().includes(needle)).join('\n'), agent);
    return removed;
  }

  rename(oldName: string, newName: string) {
    const from = this.file('agent', { name: oldName });
    if (fs.existsSync(from)) fs.renameSync(from, this.file('agent', { name: newName }));
  }

  remove(name: string) {
    fs.rmSync(this.file('agent', { name }), { force: true });
  }

  /** Memory as it appears in an agent's instructions. */
  promptSection(agent: Agent): string {
    const clip = (s: string) => (s.length > PROMPT_CHARS ? `${s.slice(0, PROMPT_CHARS)}\n… (memory is long; the rest was left out — ask a human to tidy it)` : s);
    const team = this.read('team').trim();
    const own = this.read('agent', agent).trim();
    return `## Memory
Lasting facts and preferences, kept as files humans can read and edit. Save new ones with remember (scope "me" for your own work, "team" for things every agent should know); remove outdated ones with forget. Don't store task progress or secrets here.
### Team memory
${team ? clip(team) : '(empty)'}
### Your memory
${own ? clip(own) : '(empty)'}`;
  }
}
