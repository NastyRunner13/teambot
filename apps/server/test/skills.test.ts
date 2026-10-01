import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { parseSkill, skillTemplate } from '../src/skills.js';
import { addAgent, general, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

function setup() {
  const t = testApp();
  current = t.app;
  t.app.runtime.start();
  return t;
}

const SKILL = (name: string, description = 'Compile the weekly metrics report. Use when asked for the weekly report.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# Weekly report\n\n1. Open the dashboard.\n2. Write /shared/weekly.md.\n`;

describe('SKILL.md parsing', () => {
  it('reads name, description and body, and explains what is wrong', () => {
    expect(parseSkill(SKILL('weekly-report'))).toMatchObject({ name: 'weekly-report', body: expect.stringContaining('Open the dashboard') });
    expect(parseSkill(skillTemplate('new-skill')).name).toBe('new-skill');
    expect(() => parseSkill('# no front matter')).toThrow(/front matter/);
    expect(() => parseSkill('---\nname: Bad Name\ndescription: x\n---\n')).toThrow(/lowercase/);
    expect(() => parseSkill('---\nname: ok\n---\nbody')).toThrow(/description is required/);
  });
});

describe('skills', () => {
  it('lists skills in the prompt and hands over the procedure and its files', async () => {
    const { app, models, owner, computers } = setup();
    app.skills.save('weekly-report', SKILL('weekly-report'));
    fs.writeFileSync(path.join(app.skills.dir, 'weekly-report', 'collect.sh'), 'echo collecting\n');
    const ops = addAgent(app, 'Ops');
    models.script('test/ops', [callTool('use_skill', { name: 'weekly-report' }), say('Following the weekly report skill.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops do the weekly report' });
    await app.runtime.idle();

    expect(models.requests[0].messages[0].content).toContain('- weekly-report: Compile the weekly metrics report.');
    const result = app.store
      .getTranscript<TranscriptMessage>(app.store.listRuns({ agentId: ops.id })[0].id)
      .find((m) => m.role === 'tool')!.content;
    expect(result).toContain('2. Write /shared/weekly.md.');
    expect(result).not.toContain('name: weekly-report'); // front matter stripped
    expect(result).toContain('/home/agent/skills/weekly-report/: collect.sh');
    expect(computers.calls.find((c) => c.path === '/fs/write')?.body).toEqual({ path: '/home/agent/skills/weekly-report/collect.sh', content: 'echo collecting\n' });
  });

  it('only offers an agent the skills it is given', async () => {
    const { app, models, owner } = setup();
    app.skills.save('weekly-report', SKILL('weekly-report'));
    app.skills.save('invoices', SKILL('invoices', 'Send the monthly invoices.'));
    const ops = addAgent(app, 'Ops');
    app.store.updateAgent(ops.id, { skills: ['weekly-report'] });
    models.script('test/ops', [callTool('use_skill', { name: 'invoices' }), say('ok')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops invoices please' });
    await app.runtime.idle();

    const prompt = String(models.requests[0].messages[0].content);
    expect(prompt).toContain('weekly-report');
    expect(prompt).not.toContain('invoices:');
    const result = app.store.getTranscript<TranscriptMessage>(app.store.listRuns({ agentId: ops.id })[0].id).find((m) => m.role === 'tool')!.content;
    expect(result).toContain('No skill named "invoices". Your skills: weekly-report');
  });

  it('routines can name the skill to follow', async () => {
    const { app, models } = setup();
    app.skills.save('weekly-report', SKILL('weekly-report'));
    const ops = addAgent(app, 'Ops');
    const s = app.store.createSchedule({ agentId: ops.id, name: 'Monday report', cron: '0 9 * * 1', prompt: 'Do the report.', skill: 'weekly-report', channelId: null, enabled: true });
    app.cron.fire(s.id);
    await app.runtime.idle();
    expect(JSON.stringify(models.requests[0].messages)).toContain('Follow the skill \\"weekly-report\\"');
  });

  it('saves through the API only when the front matter matches', async () => {
    const { app } = setup();
    const server = await buildServer(app);
    const bad = await server.inject({ method: 'PUT', url: '/api/skills/weekly-report', payload: { content: SKILL('other-name') } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('Make them match');
    const ok = await server.inject({ method: 'PUT', url: '/api/skills/weekly-report', payload: { content: SKILL('weekly-report') } });
    expect(ok.json().description).toContain('weekly metrics');
    expect((await server.inject({ method: 'GET', url: '/api/skills' })).json()).toHaveLength(1);
    expect((await server.inject({ method: 'DELETE', url: '/api/skills/weekly-report' })).statusCode).toBe(200);
    expect(app.skills.list()).toHaveLength(0);
    await server.close();
  });
});
