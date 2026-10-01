import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { traceIdFor } from '../src/telemetry.js';
import { addAgent, general, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

describe('OpenTelemetry export', () => {
  it('sends events as logs and each run as a trace of run, tool and model spans', async () => {
    const posts: { url: string; body: any; headers: Record<string, string> }[] = [];
    const t = testApp({
      telemetry: { endpoint: 'http://collector:4318/', headers: 'authorization=Bearer%20abc,x-team=ops', post: async (url, body, headers) => void posts.push({ url, body, headers }) },
    });
    current = t.app;
    const { app, models, owner } = t;
    app.telemetry.start();
    app.runtime.start();
    addAgent(app, 'Ops');
    models.script('test/ops', [callTool('shell', { command: 'uptime' }), say('All good.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops check the box' });
    await app.runtime.idle();
    await app.telemetry.stop();

    const logs = posts.find((p) => p.url === 'http://collector:4318/v1/logs')!;
    expect(logs.headers).toEqual({ authorization: 'Bearer abc', 'x-team': 'ops' });
    const records = logs.body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.map((r: any) => r.body.stringValue)).toContain('tool.finished');
    expect(logs.body.resourceLogs[0].resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'teambot' } });

    const spans = posts.find((p) => p.url.endsWith('/v1/traces'))!.body.resourceSpans[0].scopeSpans[0].spans;
    const run = app.store.listRuns({})[0];
    const runSpan = spans.find((s: any) => s.name.startsWith('run '));
    const tool = spans.find((s: any) => s.name === 'tool shell');
    const chats = spans.filter((s: any) => s.name.startsWith('chat '));
    expect(runSpan.traceId).toBe(traceIdFor(run.id));
    expect(runSpan.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(tool.parentSpanId).toBe(runSpan.spanId);
    expect(tool.status.code).toBe(1);
    expect(chats).toHaveLength(2);
    expect(chats[0].attributes).toContainEqual({ key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } });
    expect(BigInt(runSpan.endTimeUnixNano) >= BigInt(runSpan.startTimeUnixNano)).toBe(true);
    expect(app.telemetry.status()).toMatchObject({ enabled: true, error: null });
  });

  it('stays off without an endpoint and never breaks the app when the collector fails', async () => {
    const off = testApp({ telemetry: { endpoint: '' } });
    expect(off.app.telemetry.enabled).toBe(false);

    const t = testApp({ telemetry: { endpoint: 'http://down:4318', post: async () => Promise.reject(new Error('connection refused')) } });
    current = t.app;
    t.app.telemetry.start();
    t.app.bus.emit('system.paused', { actorId: t.owner.id }, {});
    await t.app.telemetry.flush();
    expect(t.app.telemetry.status().error).toBe('connection refused');
    await t.app.telemetry.stop();
  });
});
