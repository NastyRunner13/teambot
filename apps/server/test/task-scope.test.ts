// Agents stick to work someone gave them: a removed agent's tasks don't linger as unowned work, and an agent can
// take over or close a task that isn't its own only when a person asks it directly.
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { removeAgent } from '../src/runtime/helpers.js';
import { humanActor } from '../src/workspace.js';
import { addAgent, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

const toolResults = (app: App, agentId: string) =>
  app.store.listRuns({ agentId }).flatMap((r) =>
    app.store
      .getTranscript<TranscriptMessage>(r.id)
      .filter((m) => m.role === 'tool')
      .map((m) => m.content as string),
  );

describe('task scope', () => {
  it("cancels a removed agent's open tasks, and its helpers', without waking whoever created them", async () => {
    const { app, owner } = testApp(); // runtime not started: nobody works on anything
    current = app;
    const lead = addAgent(app, 'Lead');
    const writer = addAgent(app, 'Writer');
    const drafting = app.workspace.createTask({ title: 'Draft the post', assigneeId: writer.id }, { id: lead.id, depth: 0, initiator: 'human' });
    const done = app.workspace.createTask({ title: 'Outline', assigneeId: writer.id }, { id: lead.id, depth: 0, initiator: 'human' });
    app.store.saveTask({ ...done, status: 'done' });
    const run = app.store.createRun({ agentId: writer.id, channelId: null, initiator: 'human', depth: 0, title: 'x' });
    const [{ task: helperTask }] = app.helpers.spawn(app.store.getAgent(writer.id)!, run, [{ title: 'Find sources', task: 'Find three sources' }]);
    const leadInbox = app.store.pendingInbox(lead.id).length;

    await removeAgent(app, app.store.getAgent(writer.id)!, owner.id);

    expect(app.store.getTaskByNumber(drafting.number)).toMatchObject({ status: 'cancelled' });
    expect(app.store.getTaskByNumber(drafting.number)!.notes.at(-1)).toMatchObject({ authorId: owner.id, text: 'Cancelled: Writer was removed from the team.' });
    expect(app.store.getTaskByNumber(helperTask.number)).toMatchObject({ status: 'cancelled' });
    expect(app.store.getTaskByNumber(done.number)).toMatchObject({ status: 'done' });
    expect(app.store.pendingInbox(lead.id)).toHaveLength(leadInbox);
  });

  it("lets an agent take over a task that isn't its own only when a person asks it directly", async () => {
    const { app, models, owner } = testApp();
    current = app;
    app.runtime.start();
    const writer = addAgent(app, 'Writer');
    const editor = addAgent(app, 'Editor');
    const orphan = app.workspace.createTask({ title: 'Old research' }, humanActor(owner.id));
    const takeOver = callTool('update_task', { task: orphan.number, assignee: 'me', status: 'in_progress' });
    models.script('test/writer', [takeOver, say('Picked it up.'), takeOver, say('It is mine now.')]);

    // Woken by a teammate's hello: not its call.
    app.workspace.postMessage({ channelId: app.workspace.getOrCreateDm(editor.id, writer.id).id, authorId: editor.id, text: 'Hello back!', actor: { id: editor.id, depth: 0, initiator: 'human' } });
    await app.runtime.idle();
    expect(app.store.getTaskByNumber(orphan.number)).toMatchObject({ assigneeId: null, status: 'todo' });
    expect(toolResults(app, writer.id).at(-1)).toContain("you can't change its status or owner");

    // Asked by a person: fine.
    app.workspace.postMessage({ channelId: app.workspace.getOrCreateDm(owner.id, writer.id).id, authorId: owner.id, text: `Please take over #${orphan.number}` });
    await app.runtime.idle();
    expect(app.store.getTaskByNumber(orphan.number)).toMatchObject({ assigneeId: writer.id, status: 'in_progress' });
  });
});
