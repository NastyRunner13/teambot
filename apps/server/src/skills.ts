// Skills: reusable written procedures in the SKILL.md format (a folder per skill, YAML front matter
// with name and description, Markdown instructions, optional supporting files). They live as plain
// files in <data>/skills so they can be read, edited and versioned outside TeamBot too.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Agent, Skill, SkillSummary } from '@teambot/shared';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 100_000;
const MAX_FILE_BYTES = 200_000;
const CACHE_MS = 3000;

export function skillTemplate(name: string): string {
  return `---
name: ${name}
description: What this skill does and when to use it, in one or two sentences. Agents decide whether to load it from this line.
---

# ${name.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}

## When to use
Describe the situations where this procedure applies.

## Steps
1. First step.
2. Second step.

## Output
Where the result goes and what it looks like (for example a file in /shared, or a message in a channel).
`;
}

/** Split SKILL.md into its front matter and body. Throws with a readable message when it is malformed. */
export function parseSkill(content: string): { name: string; description: string; body: string } {
  const m = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md must start with front matter between --- lines (name and description).');
  let meta: unknown;
  try {
    meta = YAML.parse(m[1]);
  } catch (err) {
    throw new Error(`The front matter is not valid YAML: ${(err as Error).message}`);
  }
  const { name, description } = (meta ?? {}) as { name?: unknown; description?: unknown };
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new Error('name must be lowercase letters, numbers and hyphens (max 64), e.g. weekly-report');
  if (typeof description !== 'string' || !description.trim()) throw new Error('description is required: say what the skill does and when to use it');
  if (description.length > 1024) throw new Error('description is too long (max 1024 characters)');
  return { name, description: description.trim(), body: m[2].trim() };
}

export class SkillStore {
  private cache: { at: number; list: SkillSummary[] } | null = null;

  constructor(readonly dir: string) {}

  private folder(name: string): string {
    if (!SKILL_NAME_RE.test(name)) throw new Error(`"${name}" is not a valid skill name`);
    return path.join(this.dir, name);
  }

  private files(folder: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && out.length < 100) out.push(path.relative(folder, full).split(path.sep).join('/'));
      }
    };
    walk(folder);
    return out.filter((f) => f !== 'SKILL.md').sort();
  }

  list(): SkillSummary[] {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.list;
    const list: SkillSummary[] = [];
    if (fs.existsSync(this.dir)) {
      for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (!e.isDirectory() || !SKILL_NAME_RE.test(e.name)) continue;
        const file = path.join(this.dir, e.name, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        try {
          const parsed = parseSkill(fs.readFileSync(file, 'utf8'));
          list.push({ name: e.name, description: parsed.description, files: this.files(path.join(this.dir, e.name)), updatedAt: fs.statSync(file).mtime.toISOString() });
        } catch (err) {
          list.push({ name: e.name, description: '', files: [], updatedAt: fs.statSync(file).mtime.toISOString(), error: (err as Error).message });
        }
      }
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { at: Date.now(), list };
    return list;
  }

  get(name: string): Skill | undefined {
    const folder = this.folder(name);
    const file = path.join(folder, 'SKILL.md');
    if (!fs.existsSync(file)) return undefined;
    const content = fs.readFileSync(file, 'utf8');
    const summary = this.list().find((s) => s.name === name);
    return { name, description: summary?.description ?? '', files: this.files(folder), updatedAt: fs.statSync(file).mtime.toISOString(), error: summary?.error, content };
  }

  save(name: string, content: string): Skill {
    if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new Error('SKILL.md is too long (max 100 KB)');
    const parsed = parseSkill(content);
    if (parsed.name !== name) throw new Error(`The front matter says name: ${parsed.name}, but this skill is ${name}. Make them match.`);
    const folder = this.folder(name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), content.endsWith('\n') ? content : `${content}\n`);
    this.cache = null;
    return this.get(name)!;
  }

  delete(name: string) {
    fs.rmSync(this.folder(name), { recursive: true, force: true });
    this.cache = null;
  }

  /** The skills an agent may use: all of them for "*", otherwise the ones it lists. */
  forAgent(agent: Agent): SkillSummary[] {
    const all = this.list().filter((s) => !s.error);
    return agent.skills.includes('*') ? all : all.filter((s) => agent.skills.includes(s.name));
  }

  /** Supporting text files, to copy next to the agent. Binary and oversized files are reported, not copied. */
  supportFiles(name: string): { files: { path: string; content: string }[]; skipped: string[] } {
    const folder = this.folder(name);
    const files: { path: string; content: string }[] = [];
    const skipped: string[] = [];
    for (const rel of this.files(folder)) {
      const buf = fs.readFileSync(path.join(folder, rel));
      if (buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) skipped.push(rel);
      else files.push({ path: rel, content: buf.toString('utf8') });
    }
    return { files, skipped };
  }
}
