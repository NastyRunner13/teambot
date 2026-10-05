import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MAX_RECORDING_MS, describeAction, type Agent, type Recording } from '@teambot/shared';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { ChatRequest, ContentPart, TranscriptMessage } from '../src/models/types.js';
import { MAX_ACTIONS, MAX_FRAMES, skillNameFrom } from '../src/recordings.js';
import { startOfDay } from '../src/runtime/budget.js';
import { addAgent, general, testApp } from './helpers.js';

let current: App | null = null;
let server: FastifyInstance | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  current?.recordings.stop();
  await current?.runtime.stop();
  current = null;
  server = null;
});

function setup() {
  const t = testApp();
  current = t.app;
  const ops = addAgent(t.app, 'Ops');
  return { ...t, ops };
}

async function api(app: App) {
  server = await buildServer(app);
  return server;
}

const PAGE = 'https://expenses.example.com/new';
const target = (name: string, type = 'text', role = `input[${type}]`) => ({ role, name, tag: type ? 'input' : 'button', type });

/** What computerd sends for a short expense report: the page, a search, a password, a token typed in plain sight. */
function expenseReport(token: string) {
  return [
    { seq: 1, t: 10, kind: 'navigate', url: 'https://expenses.example.com/login', title: 'Sign in' },
    { seq: 2, t: 900, kind: 'type', url: 'https://expenses.example.com/login', target: target('Email', 'email'), value: 'ada@example.com', sensitive: false },
    // computerd never sends a password's value; a forged event claiming otherwise is caught here too.
    { seq: 3, t: 1500, kind: 'type', url: 'https://expenses.example.com/login', target: target('Password', 'password'), value: 'hunter2-leak', sensitive: false },
    { seq: 4, t: 1600, kind: 'press', url: 'https://expenses.example.com/login', target: target('Password', 'password'), key: 'Enter' },
    { seq: 5, t: 3000, kind: 'navigate', url: PAGE, title: 'New expense' },
    { seq: 6, t: 4000, kind: 'type', url: PAGE, target: target('API key'), value: null, sensitive: true },
    { seq: 7, t: 5000, kind: 'type', url: PAGE, target: target('Reference'), value: `ref ${token} end`, sensitive: false },
    { seq: 8, t: 6000, kind: 'type', url: PAGE, target: target('Amount', 'number'), value: '42.50', sensitive: false },
    { seq: 9, t: 6500, kind: 'select', url: PAGE, target: { role: 'select', name: 'Category', tag: 'select', type: '' }, value: 'Taxi', sensitive: false },
    { seq: 10, t: 7000, kind: 'check', url: PAGE, target: target('Billable', 'checkbox'), checked: true },
    { seq: 11, t: 8000, kind: 'click', url: PAGE, target: { role: 'button', name: 'Submit', tag: 'button', type: '' } },
  ];
}

const DRAFT = (name = 'file-expense', body = '## Steps\n1. Open https://expenses.example.com/new.\n2. Sign in with {{secret:EXPENSES_PASSWORD}}.') =>
  `---\nname: ${name}\ndescription: File an expense report. Use when someone asks to submit an expense.\n---\n\n${body}\n`;

/** Record the expense report on Ops's computer and stop. Returns the stopped recording, drafted from `reply`. */
async function recordAndDraft(t: ReturnType<typeof setup>, reply: string | (() => never) = DRAFT(), input: { name?: string; description?: string } = {}) {
  const { app, computers, models, ops, owner } = t;
  const rec = await app.recordings.begin(ops, owner);
  computers.recorder[ops.id].events.push(...expenseReport(t.app.vault.get('EXPENSES_TOKEN') ?? 'no-token'));
  await app.recordings.collect(rec.id);
  models.script('test/utility', [typeof reply === 'string' ? say(reply) : reply]);
  await app.recordings.end(rec.id, owner.id, input);
  return app.recordings.draft(rec.id, owner.id);
}

describe('recording a demonstration', () => {
  it('takes the computer from the agent, records what the person does with secrets redacted, and keeps stills', async () => {
    const t = setup();
    const { app, computers, ops, owner } = t;
    app.vault.set('EXPENSES_TOKEN', 'tok-1234567890');

    const rec = await app.recordings.begin(ops, owner);
    // The agent must not act while a person records, or its actions would be recorded as theirs.
    expect(app.store.getAgent(ops.id)?.takeoverBy).toBe(owner.id);
    expect(computers.calls.find((c) => c.path === '/record/start')?.body).toEqual({ id: rec.id });
    expect(rec).toMatchObject({ status: 'recording', agentId: ops.id, startedBy: owner.id });

    computers.recorder[ops.id].events.push(...expenseReport('tok-1234567890'));
    await app.recordings.collect(rec.id);
    const got = app.recordings.get(rec.id);
    expect(got.log).toHaveLength(11);
    const text = JSON.stringify(got);
    expect(text).not.toContain('tok-1234567890');
    expect(text).not.toContain('hunter2-leak');
    expect(got.log[2]).toMatchObject({ kind: 'type', sensitive: true, value: null });
    expect(got.log[5]).toMatchObject({ sensitive: true, value: null });
    expect(got.log[6]).toMatchObject({ value: 'ref {{secret:EXPENSES_TOKEN}} end', secrets: ['EXPENSES_TOKEN'] });
    expect(got.log[0].secrets).toBeUndefined();
    expect(describeAction(got.log[2])).toBe('Typed a password or other secret into input[password] "Password" (the value was not recorded)');
    expect(describeAction(got.log[6])).toBe('Typed "ref {{secret:EXPENSES_TOKEN}} end" into input[text] "Reference"');

    // A secret was typed on the expense page, so no still of it is kept.
    expect(got.frameList).toEqual([]);
    computers.stillUrl = 'https://expenses.example.com/done?ok=1';
    computers.recorder[ops.id].events.push({ seq: 12, t: 9000, kind: 'navigate', url: 'https://expenses.example.com/done?ok=1', title: 'Saved' });
    await app.recordings.collect(rec.id);
    const frames = app.recordings.get(rec.id).frameList;
    expect(frames).toEqual([{ file: '1.jpg', t: expect.any(Number), url: 'https://expenses.example.com/done?ok=1', title: 'Expenses' }]);
    expect(fs.readFileSync(path.join(app.recordings.dir(rec.id), '1.jpg'), 'utf8')).toBe('still of https://expenses.example.com/done?ok=1');
    // The query string doesn't make it another page: still the page of the secret.
    computers.stillUrl = `${PAGE}?step=2`;
    computers.recorder[ops.id].events.push({ seq: 13, t: 9500, kind: 'navigate', url: `${PAGE}?step=2`, title: 'New expense' });
    await app.recordings.collect(rec.id);
    expect(app.recordings.get(rec.id).frameList).toHaveLength(1);
  });

  it('drafts the skill with the utility model, from the log as outside content, with the stills, and no secret anywhere', async () => {
    const t = setup();
    const { app, models, ops, owner } = t;
    app.vault.set('EXPENSES_TOKEN', 'tok-1234567890');
    app.budgets.setWorkspaceDailyUsd(5, owner.id);
    // The person ends on a page they typed no secret on, so its still is kept and shown to the model.
    t.computers.stillUrl = 'https://expenses.example.com/done';
    // Even if a model wrote a secret's value, it would not reach the draft.
    const done = await recordAndDraft(t, DRAFT('expense-thing', '## Steps\n1. Use tok-1234567890 as the reference.'), { name: 'file-expense', description: 'Filing a taxi expense' });

    expect(done.status).toBe('ready');
    expect(done.name).toBe('file-expense'); // the person's name wins over the model's
    expect(done.draft).toContain('name: file-expense');
    expect(done.draft).toContain('description: File an expense report.');
    expect(done.draft).toContain('{{secret:EXPENSES_TOKEN}}');
    expect(done.draft).not.toContain('tok-1234567890');

    const req = models.requests.find((r) => r.model === 'test/utility') as ChatRequest;
    expect(String(req.messages[0].content)).toContain('{{secret:NAME}}');
    const parts = req.messages[1].content as ContentPart[];
    const prompt = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
    expect(prompt).toContain('What the person said they were doing: Filing a taxi expense');
    expect(prompt).toMatch(/<untrusted_content source="recording">[\s\S]*Typed a password or other secret[\s\S]*<\/untrusted_content>/);
    expect(prompt).toContain('Chose "Taxi" in select "Category"');
    expect(JSON.stringify(req)).not.toContain('tok-1234567890');
    expect(JSON.stringify(req)).not.toContain('hunter2-leak');
    // Stills the model sees: one when the first actions came in, one of how it ended (no secret was typed on that page).
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
    expect(prompt).toContain('Screenshot at 0:00 of "https://expenses.example.com/done" (outside content; fields are covered over):');

    // The model call costs the workspace, not the agent whose computer it was.
    expect(app.budgets.spend(startOfDay()).usd).toBeGreaterThan(0);
    expect(app.budgets.spend(startOfDay(), ops.id).usd).toBe(0);
  });

  it('keeps the draft away from agents until a person saves it, then hands it over and deletes the draft and stills', async () => {
    const t = setup();
    const { app, models, ops, owner } = t;
    app.runtime.start();
    t.computers.stillUrl = 'https://expenses.example.com/done';
    const done = await recordAndDraft(t);
    expect(done.frames).toBe(2);
    expect(fs.existsSync(app.recordings.dir(done.id))).toBe(true);

    // Not a skill: not listed, not in an agent's prompt, and use_skill can't load it.
    expect(app.skills.list()).toEqual([]);
    app.runtime.handBack(ops.id, owner.id, null);
    models.script('test/ops', [callTool('use_skill', { name: 'file-expense' }), say('done')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops file my expense' });
    await app.runtime.idle();
    const run = app.store.listRuns({ agentId: ops.id })[0];
    expect(String(models.requests.find((r) => r.model === 'test/ops')!.messages[0].content)).not.toContain('file-expense');
    expect(app.store.getTranscript<TranscriptMessage>(run.id).find((m) => m.role === 'tool')!.content).toContain('No skill named "file-expense"');

    // A person saves it.
    const srv = await api(app);
    const saved = await srv.inject({ method: 'POST', url: `/api/recordings/${done.id}/save`, payload: { content: done.draft } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ name: 'file-expense' });
    expect(app.skills.forAgent(app.store.getAgent(ops.id)!).map((s) => s.name)).toEqual(['file-expense']);
    expect(app.store.getRecording(done.id)).toBeUndefined();
    expect(fs.existsSync(app.recordings.dir(done.id))).toBe(false);
    const savedEvent = app.store.listEvents({ types: ['skill.saved'] })[0];
    expect(savedEvent).toMatchObject({ actorId: owner.id, data: { fromRecording: done.id } });
    expect(app.store.listEvents({ types: ['recording.deleted'] })[0].data).toMatchObject({ id: done.id, savedAs: 'file-expense' });
  });

  it('never overwrites a skill by accident, and refuses a draft that is not a valid SKILL.md', async () => {
    const t = setup();
    const { app } = t;
    app.vault.set('SITE_PASSWORD', 'p4ssw0rd-long');
    app.skills.save('file-expense', DRAFT('file-expense', 'The old procedure.'));
    const done = await recordAndDraft(t);
    const srv = await api(app);

    const clash = await srv.inject({ method: 'POST', url: `/api/recordings/${done.id}/save`, payload: { content: done.draft } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toContain('already a skill named file-expense');
    expect(app.skills.get('file-expense')?.content).toContain('The old procedure.');

    const broken = await srv.inject({ method: 'POST', url: `/api/recordings/${done.id}/save`, payload: { content: '# No front matter' } });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toContain('front matter');
    const badName = await srv.inject({ method: 'POST', url: `/api/recordings/${done.id}/save`, payload: { content: DRAFT('Bad Name') } });
    expect(badName.statusCode).toBe(400);
    expect(app.store.getRecording(done.id)).toBeDefined();

    // A person's edits are kept, a secret pasted in becomes its placeholder, and the name follows the front matter.
    const edited = await srv.inject({ method: 'PUT', url: `/api/recordings/${done.id}/draft`, payload: { content: DRAFT('file-taxi-expense', 'Sign in with p4ssw0rd-long.') } });
    expect(edited.json()).toMatchObject({ name: 'file-taxi-expense', draft: expect.stringContaining('{{secret:SITE_PASSWORD}}') });

    const replaced = await srv.inject({ method: 'POST', url: `/api/recordings/${done.id}/save`, payload: { content: DRAFT('file-expense', 'The new procedure.'), overwrite: true } });
    expect(replaced.statusCode).toBe(200);
    expect(app.skills.get('file-expense')?.content).toContain('The new procedure.');
  });

  it('turns any model reply into a SKILL.md that parses, under a usable name', async () => {
    const t = setup();
    const { app } = t;
    const rec = { name: '', description: 'File a taxi expense!', startedAt: '2026-10-05T10:00:00.000Z' };
    // No front matter at all, in a code fence.
    const fenced = app.recordings.finishDraft('```markdown\n## Steps\n1. Open the page.\n```', rec);
    expect(fenced.name).toBe('file-a-taxi-expense');
    expect(fenced.content).toMatch(/^---\nname: file-a-taxi-expense\ndescription: File a taxi expense!\n---\n\n## Steps\n1. Open the page.\n$/);
    // The model's name when it is a usable one, a made-up one when nothing else is.
    expect(app.recordings.finishDraft(DRAFT('expense-flow'), rec).name).toBe('expense-flow');
    expect(app.recordings.finishDraft(DRAFT('Expense Flow!!'), { ...rec, description: '' }).name).toBe('expense-flow');
    expect(app.recordings.finishDraft('---\nname: [oops\n---\nBody', { ...rec, description: '' })).toMatchObject({ name: 'recorded-task' });
    // A description with YAML-special characters survives.
    const colon = app.recordings.finishDraft('---\nname: x\ndescription: "Expenses: file one #taxi"\n---\nBody', rec);
    expect(colon.content).toContain('Expenses: file one #taxi');
    expect(skillNameFrom('  --Hello, World--  ')).toBe('hello-world');
    expect(skillNameFrom('a'.repeat(80))).toHaveLength(64);
    expect(skillNameFrom('!!!')).toBe('');
  });
});

describe('recording edge cases', () => {
  it('refuses to start when the computer is off, someone else is driving, or a recording is already going', async () => {
    const t = setup();
    const { app, computers, ops, owner } = t;
    computers.off.add(ops.id);
    await expect(app.recordings.begin(ops, owner)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("isn't running") });
    expect(app.store.listRecordings()).toEqual([]);
    expect(app.store.getAgent(ops.id)?.takeoverBy).toBeNull();
    computers.off.delete(ops.id);

    // Starting on a computer that can't record gives it back to the agent.
    computers.failRecordStart = true;
    await expect(app.recordings.begin(ops, owner)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('browser is not available') });
    expect(app.store.listRecordings()).toEqual([]);
    expect(app.store.getAgent(ops.id)?.takeoverBy).toBeNull();
    computers.failRecordStart = false;

    const bob = app.store.createHuman('Bob');
    app.runtime.takeover(ops.id, bob.id);
    await expect(app.recordings.begin(app.store.getAgent(ops.id)!, owner)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Bob has control') });
    app.runtime.handBack(ops.id, bob.id, null);

    // Two clicks at once: one recording.
    const [a, b] = await Promise.allSettled([app.recordings.begin(ops, owner), app.recordings.begin(ops, owner)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(app.store.listRecordings({ status: 'recording' })).toHaveLength(1);
  });

  it('ends the recording when the computer is handed back, and drafts what it has', async () => {
    const t = setup();
    const { app, computers, models, ops, owner } = t;
    const rec = await app.recordings.begin(ops, owner);
    computers.recorder[ops.id].events.push(...expenseReport('x'));
    models.script('test/utility', [say(DRAFT())]);
    app.runtime.handBack(ops.id, owner.id, null);
    await vi.waitFor(() => expect(app.store.getRecording(rec.id)?.status).toBe('ready'));
    // What was still on the computer was collected on the way out.
    expect(app.recordings.get(rec.id).log).toHaveLength(11);
    expect(computers.recorder[ops.id].id).toBeNull();
    expect(app.store.listEvents({ types: ['recording.stopped'] })[0].data.note).toContain('handed back');
  });

  it('fails without spending anything when nothing was demonstrated, and can be discarded', async () => {
    const t = setup();
    const { app, computers, models, ops, owner } = t;
    const rec = await app.recordings.begin(ops, owner);
    computers.recorder[ops.id].events.push({ seq: 1, t: 5, kind: 'navigate', url: PAGE, title: 'New expense' });
    const stopped = await app.recordings.end(rec.id, owner.id);
    expect(stopped).toMatchObject({ status: 'failed', error: expect.stringContaining('Nothing was recorded') });
    expect(models.requests).toEqual([]);
    await expect(app.recordings.draft(rec.id, owner.id)).rejects.toMatchObject({ status: 409 });
    await expect(app.recordings.end(rec.id, owner.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already stopped') });

    const srv = await api(app);
    expect((await srv.inject({ method: 'POST', url: `/api/recordings/${rec.id}/draft` })).statusCode).toBe(409);
    expect((await srv.inject({ method: 'DELETE', url: `/api/recordings/${rec.id}` })).statusCode).toBe(200);
    expect(app.store.getRecording(rec.id)).toBeUndefined();
    expect((await srv.inject({ method: 'GET', url: `/api/recordings/${rec.id}` })).statusCode).toBe(404);
  });

  it('discards a recording that is still going: the computer stops recording and nothing is kept', async () => {
    const t = setup();
    const { app, computers, ops, owner } = t;
    const rec = await app.recordings.begin(ops, owner);
    computers.recorder[ops.id].events.push(...expenseReport('x').slice(0, 2));
    await app.recordings.collect(rec.id);
    expect(app.recordings.get(rec.id).frameList).toHaveLength(1);
    await app.recordings.discard(rec.id, owner.id);
    expect(computers.recorder[ops.id].id).toBeNull();
    expect(app.store.getRecording(rec.id)).toBeUndefined();
    expect(fs.existsSync(app.recordings.dir(rec.id))).toBe(false);
  });

  it('drops what is not an action, caps the log, and stops itself at the limits', async () => {
    const t = setup();
    const { app, computers, ops, owner } = t;
    const rec = await app.recordings.begin(ops, owner);
    computers.recorder[ops.id].events.push(
      { seq: 1, t: 1, kind: 'navigate', url: PAGE },
      { seq: 2, t: 2, kind: 'run_shell', url: PAGE, value: 'rm -rf /' },
      { seq: 3, t: 3, kind: 'click', url: 'x'.repeat(5000) },
      { seq: 4, t: 4, kind: 'press', url: PAGE },
      'not even an object',
      { seq: 5, t: 5, kind: 'type', url: PAGE, target: target('Note'), value: 'a\u0000b' },
    );
    computers.recorder[ops.id].dropped = 3;
    await app.recordings.collect(rec.id);
    let got = app.recordings.get(rec.id);
    expect(got.log.map((a) => a.seq)).toEqual([1, 5]);
    expect(got.log[1].value).toBe('ab');
    expect(got.dropped).toBe(3 + 4);

    const many = Array.from({ length: MAX_ACTIONS + 5 }, (_, i) => ({ seq: 10 + i, t: 10 + i, kind: 'click', url: PAGE, target: { role: 'button', name: `B${i}`, tag: 'button', type: '' } }));
    computers.recorder[ops.id].events.push(...many);
    await app.recordings.collect(rec.id);
    got = app.recordings.get(rec.id);
    expect(got.log).toHaveLength(MAX_ACTIONS);
    expect(got.status).not.toBe('recording');
    expect(app.store.listEvents({ types: ['recording.stopped'] })[0].data.note).toContain(`${MAX_ACTIONS} actions`);
  });

  it('stops after the time limit', async () => {
    const t = setup();
    const { app, computers, ops, owner } = t;
    const rec = await app.recordings.begin(ops, owner);
    computers.recorder[ops.id].events.push(...expenseReport('x'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + MAX_RECORDING_MS + 1000);
    await app.recordings.collect(rec.id);
    expect(app.store.getRecording(rec.id)?.status).not.toBe('recording');
    expect(app.store.listEvents({ types: ['recording.stopped'] })[0].data.note).toContain('10 minutes');
  });

  it('ends with what it has when the computer is stopped or its recorder restarts', async () => {
    const t = setup();
    const { app, computers, ops, owner } = t;
    const first = await app.recordings.begin(ops, owner);
    computers.recorder[ops.id].events.push(...expenseReport('x'));
    await app.recordings.collect(first.id);
    computers.off.add(ops.id);
    await app.recordings.collect(first.id);
    expect(app.store.getRecording(first.id)?.status).not.toBe('recording');
    expect(app.store.listEvents({ types: ['recording.stopped'] })[0].data.note).toContain('computer was stopped');
    await app.recordings.draft(first.id, owner.id).catch(() => undefined);
    computers.off.delete(ops.id);

    const second = await app.recordings.begin(app.store.getAgent(ops.id)!, owner);
    computers.recorder[ops.id] = { id: null, events: [], dropped: 0 }; // computerd restarted and forgot it
    await app.recordings.collect(second.id);
    expect(app.store.getRecording(second.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('stopped recording') });
    // Nothing was asked of a computer that was off, or of a recorder that had nothing.
    expect(computers.calls.filter((c) => c.path === '/record/stop')).toEqual([]);
  });

  it('keeps at most MAX_FRAMES stills', async () => {
    const t = setup();
    const { app, computers, ops, owner } = t;
    const rec = await app.recordings.begin(ops, owner);
    for (let i = 0; i < MAX_FRAMES + 3; i++) {
      computers.stillUrl = `https://example.com/page-${i}`;
      computers.recorder[ops.id].events.push({ seq: i + 1, t: i, kind: 'navigate', url: computers.stillUrl });
      await app.recordings.collect(rec.id);
    }
    expect(app.recordings.get(rec.id).frameList).toHaveLength(MAX_FRAMES);
    // No tab showing: no still, and no error.
    computers.stillUrl = null;
    await app.recordings.discard(rec.id, owner.id);
  });

  it('reports a failed draft, and drafts again on request', async () => {
    const t = setup();
    const { app, models, owner } = t;
    const failed = await recordAndDraft(t, () => {
      throw new Error('provider is down');
    });
    expect(failed).toMatchObject({ status: 'failed', error: 'Drafting failed: provider is down' });

    const srv = await api(app);
    models.script('test/utility', [say('')]);
    const again = await srv.inject({ method: 'POST', url: `/api/recordings/${failed.id}/draft` });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('drafting');
    await vi.waitFor(() => expect(app.store.getRecording(failed.id)?.error).toContain('empty draft'));

    models.script('test/utility', [say(DRAFT())]);
    const third = await app.recordings.draft(failed.id, owner.id);
    expect(third).toMatchObject({ status: 'ready', error: null });
  });

  it('does not draft when the workspace budget is spent', async () => {
    const t = setup();
    const { app, models, owner } = t;
    app.budgets.setWorkspaceDailyUsd(0.00001, owner.id);
    app.bus.emit('llm.response', {}, { costUsd: 1, inputTokens: 1, outputTokens: 1 });
    const blocked = await recordAndDraft(t);
    expect(blocked).toMatchObject({ status: 'failed', error: expect.stringContaining("workspace's daily budget") });
    expect(models.requests.filter((r) => r.model === 'test/utility')).toEqual([]);
  });

  it('a discarded draft that was still being written is not brought back', async () => {
    const t = setup();
    const { app, computers, models, ops, owner } = t;
    const rec = await app.recordings.begin(ops, owner);
    computers.recorder[ops.id].events.push(...expenseReport('x'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    models.script('test/utility', [say(DRAFT())]);
    const chat = models.chat.bind(models);
    models.chat = async (req) => {
      await gate;
      return chat(req);
    };
    await app.recordings.end(rec.id, owner.id);
    const drafting = app.recordings.draft(rec.id, owner.id);
    await app.recordings.discard(rec.id, owner.id);
    release();
    await drafting;
    expect(app.store.getRecording(rec.id)).toBeUndefined();
  });

  it('marks drafts interrupted by a restart as failed, so they can be drafted again', async () => {
    const t = setup();
    const { app, ops, owner } = t;
    const rec = app.store.createRecording({ agentId: ops.id, startedBy: owner.id });
    app.store.updateRecording(rec.id, { status: 'drafting' });
    app.recordings.start();
    expect(app.store.getRecording(rec.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
  });

  it('goes with its agent', async () => {
    const t = setup();
    const { app, ops, owner } = t;
    const done = await recordAndDraft(t);
    const srv = await api(app);
    expect((await srv.inject({ method: 'DELETE', url: `/api/agents/${ops.id}` })).statusCode).toBe(200);
    expect(app.store.getRecording(done.id)).toBeUndefined();
    expect(fs.existsSync(app.recordings.dir(done.id))).toBe(false);
    expect(owner).toBeDefined();
  });
});

describe('recordings over the API', () => {
  it('starts, stops with a name and description, serves stills, and validates input', async () => {
    const t = setup();
    const { app, computers, models, ops, owner } = t;
    const srv = await api(app);
    const started = await srv.inject({ method: 'POST', url: `/api/agents/${ops.id}/recordings` });
    expect(started.statusCode).toBe(200);
    const id = started.json().id as string;
    expect(app.store.listEvents({ types: ['recording.started'] })[0]).toMatchObject({ actorId: owner.id, agentId: ops.id });
    expect((await srv.inject({ method: 'POST', url: `/api/agents/${ops.id}/recordings` })).statusCode).toBe(409);
    expect((await srv.inject({ method: 'POST', url: '/api/agents/nobody/recordings' })).statusCode).toBe(404);

    computers.recorder[ops.id].events.push(...expenseReport('x').slice(0, 2));
    await app.recordings.collect(id);
    const frame = await srv.inject({ method: 'GET', url: `/api/recordings/${id}/frames/1.jpg` });
    expect(frame.body).toBe(`still of ${PAGE}`);
    expect(frame.headers).toMatchObject({ 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
    expect((await srv.inject({ method: 'GET', url: `/api/recordings/${id}/frames/2.jpg` })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'GET', url: `/api/recordings/${id}/frames/..%2F..%2Fmaster.key` })).statusCode).toBe(400);

    expect((await srv.inject({ method: 'POST', url: `/api/recordings/${id}/stop`, payload: { name: 'Not A Name' } })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'PUT', url: `/api/recordings/${id}/draft`, payload: { content: DRAFT() } })).statusCode).toBe(409);
    models.script('test/utility', [say(DRAFT())]);
    const stopped = await srv.inject({ method: 'POST', url: `/api/recordings/${id}/stop`, payload: { name: 'taxi-expense', description: 'A taxi ride' } });
    expect(stopped.json()).toMatchObject({ status: 'drafting', name: 'taxi-expense', description: 'A taxi ride' });
    expect((await srv.inject({ method: 'POST', url: `/api/recordings/${id}/stop` })).statusCode).toBe(409);
    await app.recordings.draft(id, owner.id);

    const list = (await srv.inject({ method: 'GET', url: '/api/recordings' })).json();
    expect(list).toEqual([expect.objectContaining({ id, status: 'ready', actions: 2, frames: 2, name: 'taxi-expense' })]);
    expect(list[0].log).toBeUndefined();
    expect((await srv.inject({ method: 'GET', url: '/api/bootstrap' })).json().recordings).toHaveLength(1);
    const full = (await srv.inject({ method: 'GET', url: `/api/recordings/${id}` })).json() as Recording;
    expect(full.log).toHaveLength(2);
    expect(full.draft).toContain('name: taxi-expense');
  });

  it('keeps a recording to the person who made it and owners when sign-in is on', async () => {
    const t = setup();
    const { app, computers, ops } = t;
    const srv = await api(app);
    const jar = () => {
      let session = '';
      return async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => {
        const res = await srv.inject({ method, url, payload, headers: session ? { cookie: `teambot_session=${session}` } : {} });
        const value = String(res.headers['set-cookie'] ?? '').match(/^teambot_session=([^;]*)/)?.[1];
        if (value !== undefined) session = value;
        return res;
      };
    };
    const alice = jar();
    await alice('POST', '/api/team/enable', { password: 'owner password 1' });
    const { token } = (await alice('POST', '/api/team/invites', {})).json();
    const bob = jar();
    const bobId = (await bob('POST', '/api/auth/join', { token, name: 'Bob', password: 'bob password 1' })).json().me.id as string;
    const { token: token2 } = (await alice('POST', '/api/team/invites', {})).json();
    const carol = jar();
    await carol('POST', '/api/auth/join', { token: token2, name: 'Carol', password: 'carol password 1' });

    // Bob records: it is his, and the takeover is his too.
    const started = await bob('POST', `/api/agents/${ops.id}/recordings`);
    expect(started.json().startedBy).toBe(bobId);
    expect(app.store.getAgent(ops.id)?.takeoverBy).toBe(bobId);
    const id = started.json().id as string;
    computers.recorder[ops.id].events.push(...expenseReport('x').slice(0, 3));
    await app.recordings.collect(id);

    // Carol can't see it, stop it, or start one while Bob is driving.
    expect((await carol('GET', `/api/recordings/${id}`)).statusCode).toBe(404);
    expect((await carol('GET', '/api/recordings')).json()).toEqual([]);
    expect((await carol('GET', '/api/bootstrap')).json().recordings).toEqual([]);
    expect((await carol('GET', `/api/recordings/${id}/frames/1.jpg`)).statusCode).toBe(404);
    expect((await carol('POST', `/api/recordings/${id}/stop`)).statusCode).toBe(404);
    expect((await carol('DELETE', `/api/recordings/${id}`)).statusCode).toBe(404);
    expect((await carol('POST', `/api/agents/${ops.id}/recordings`)).json().error).toContain('Bob is already recording');
    // Nor does news of it reach her.
    expect((await carol('GET', '/api/events?types=recording.*')).json()).toEqual([]);
    expect((await bob('GET', '/api/events?types=recording.*')).json().length).toBeGreaterThan(0);
    // The owner can.
    expect((await alice('GET', `/api/recordings/${id}`)).json().log).toHaveLength(3);
    expect((await alice('GET', '/api/events?types=recording.*')).json().length).toBeGreaterThan(0);
    // Stopping is attributed to whoever stopped it.
    t.models.script('test/utility', [say(DRAFT())]);
    expect((await bob('POST', `/api/recordings/${id}/stop`)).statusCode).toBe(200);
    expect(app.store.listEvents({ types: ['recording.stopped'] })[0].actorId).toBe(bobId);
    await app.recordings.draft(id, bobId);
    expect((await bob('DELETE', `/api/recordings/${id}`)).statusCode).toBe(200);
    expect((await carol('GET', '/api/events?types=recording.*')).json()).toEqual([]);
  });
});

describe('the recorder fake', () => {
  it('answers like computerd', async () => {
    const t = setup();
    const c = await t.computers.ensure('a1');
    expect(await c.call('/record/events')).toEqual({ id: null, recording: false, events: [], dropped: 0 });
    expect(await c.call('/record/start', { id: 'r1' })).toEqual({ id: 'r1', url: PAGE });
    expect(((await c.call('/record/stop')) as { id: string }).id).toBe('r1');
    expect((t.app.store.getAgent(t.ops.id) as Agent).name).toBe('Ops');
  });
});
