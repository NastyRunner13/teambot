// End-to-end against a real agent computer. Needs Docker and the computer image:
//   pnpm computer:build && TEAMBOT_DOCKER_TESTS=1 pnpm --filter @teambot/server test
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import Docker from 'dockerode';
import { DockerComputers } from '../src/computers/docker.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { addAgent, general, testApp } from './helpers.js';

const enabled = process.env.TEAMBOT_DOCKER_TESTS === '1';

describe.skipIf(!enabled)('agent computer (Docker)', () => {
  const t = testApp();
  const app: App = t.app;
  fs.mkdirSync(app.cfg.sharedDir, { recursive: true });
  app.computers = new DockerComputers(app.cfg, app.vault, app.bus);
  const ops = addAgent(app, 'Ops');

  afterAll(async () => {
    await app.runtime.stop();
    await app.computers.reset(ops.id);
  }, 60_000);

  it(
    'uses the shell, the shared folder and the browser, and waits for approval before clicking Send',
    async () => {
      const page = `<html><body><h1>Mail</h1><input id="to" placeholder="To"><button onclick="document.querySelector('h1').textContent='Sent to '+document.getElementById('to').value">Send</button></body></html>`;
      t.models.script('test/ops', [
        callTool('shell', { command: 'head -1 /etc/os-release && echo hello from ops > /shared/hello.txt' }),
        callTool('write_file', { path: '/tmp/mail.html', content: page }),
        callTool('browser_navigate', { url: 'file:///tmp/mail.html' }),
        callTool('browser_type', { ref: 1, text: 'bob@example.com' }),
        callTool('browser_click', { ref: 2 }),
        say('Email sent.'),
      ]);
      app.runtime.start();
      app.workspace.postMessage({ channelId: general(app).id, authorId: t.owner.id, text: '@Ops send the email to bob' });
      await app.runtime.idle(120_000);

      const [approval] = app.store.listApprovals({ status: 'pending' });
      expect(approval?.summary).toBe('Click "Send"');
      const results = () =>
        app.store
          .getTranscript<TranscriptMessage>(approval.runId)
          .filter((m) => m.role === 'tool')
          .map((m) => m.content);
      expect(results()[0]).toContain('Debian');
      expect(fs.readFileSync(path.join(app.cfg.sharedDir, 'hello.txt'), 'utf8')).toBe('hello from ops\n');
      expect(results()[3]).toContain('value="bob@example.com"');

      app.runtime.resolveApproval(approval.id, 'approve', null, t.owner.id);
      await app.runtime.idle(60_000);
      expect(results().at(-1)).toContain('Sent to bob@example.com');
      expect(app.store.getRun(approval.runId)!.status).toBe('completed');
    },
    240_000,
  );

  it(
    'controls the desktop, and a coordinate click on "Send" still waits for approval',
    async () => {
      app.store.updateAgent(ops.id, { desktop: true });
      // One big button covering the page, so any point in the page area lands on it.
      const page = `<html><body style="margin:0"><button style="position:fixed;inset:0;font-size:40px" onclick="this.textContent='Sent!'">Send</button></body></html>`;
      t.models.script('test/ops', [
        callTool('write_file', { path: '/tmp/big.html', content: page }),
        callTool('browser_navigate', { url: 'file:///tmp/big.html' }),
        callTool('computer_screenshot', {}),
        callTool('computer_click', { x: 640, y: 500 }),
        callTool('browser_snapshot', {}),
        say('Clicked it.'),
      ]);
      app.workspace.postMessage({ channelId: general(app).id, authorId: t.owner.id, text: '@Ops click send on the page' });
      await app.runtime.idle(120_000);

      const [approval] = app.store.listApprovals({ status: 'pending' });
      expect(approval?.summary).toBe('Click at (640, 500) on "Send"');
      const run = app.store.getRun(approval.runId)!;
      const shot = app.store.getTranscript<TranscriptMessage>(run.id).find((m) => m.role === 'tool' && (m as { images?: string[] }).images)!;
      const jpeg = fs.readFileSync(path.join(app.cfg.dataDir, (shot as { images: string[] }).images[0]));
      expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');

      app.runtime.resolveApproval(approval.id, 'approve', null, t.owner.id);
      await app.runtime.idle(60_000);
      const results = app.store
        .getTranscript<TranscriptMessage>(run.id)
        .filter((m) => m.role === 'tool')
        .map((m) => m.content);
      expect(results.at(-1)).toContain('Sent!');
    },
    240_000,
  );

  it(
    'with an allowlist, only allowed sites are reachable, through the proxy, and the agent cannot lift the firewall',
    async () => {
      // A site on the host; the proxy (also on the host) reaches it at 127.0.0.1.
      const site = http.createServer((req, res) => res.end(`site says hi to ${req.url}`));
      await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
      const port = (site.address() as AddressInfo).port;
      const scout = addAgent(app, 'Scout');
      app.store.updateAgent(scout.id, { network: { mode: 'allowlist', allow: ['127.0.0.1'] } });
      const checks = [
        `curl --noproxy '' -s -m 10 http://127.0.0.1:${port}/allowed`,
        `echo; curl --noproxy '' -s -m 10 -o /dev/null -w 'proxy says %{http_code} to example.com' http://example.com/`,
        `echo; curl --noproxy '*' -s -m 5 http://1.1.1.1/ >/dev/null 2>&1 && echo DIRECT-OPEN || echo DIRECT-BLOCKED`,
        `sudo iptables -F OUTPUT 2>/dev/null && echo FIREWALL-LIFTED || echo FIREWALL-HELD`,
      ].join('; ');
      t.models.script('test/scout', [callTool('shell', { command: checks }), callTool('browser_navigate', { url: 'http://example.com/' }), say('Checked.')]);
      // The sudo in the checks sends the command to the reviewer (default policy).
      t.models.script('test/reviewer', [say('{"verdict":"allow","reason":"a network check the owner asked for"}')]);
      try {
        app.workspace.postMessage({ channelId: general(app).id, authorId: t.owner.id, text: '@Scout check the network' });
        await app.runtime.idle(180_000);
        const run = app.store.listRuns({ agentId: scout.id })[0];
        const [shell, page] = app.store
          .getTranscript<TranscriptMessage>(run.id)
          .filter((m) => m.role === 'tool')
          .map((m) => m.content);
        expect(shell).toContain('site says hi to /allowed');
        expect(shell).toContain('proxy says 403 to example.com');
        expect(shell).toContain('DIRECT-BLOCKED');
        expect(shell).toContain('FIREWALL-HELD');
        expect(page).toContain("not on this agent's allowlist");
        expect(app.store.listEvents({ agentId: scout.id, types: ['computer.network'] })[0].data.mode).toBe('allowlist');
      } finally {
        await app.computers.reset(scout.id);
        await new Promise((r) => site.close(r));
      }
    },
    300_000,
  );

  it(
    'snapshots the home folder and restores it exactly',
    async () => {
      const shell = async (command: string) => (await (await app.lifecycle.ready(app.store.getAgent(ops.id)!)).call<{ stdout: string }>('/shell', { command })).stdout.trim();
      await shell('mkdir -p ~/workspace/proj && echo v1 > ~/workspace/proj/notes.txt');
      const snap = await app.snapshots.take(app.store.getAgent(ops.id)!, 'v1');
      expect(snap.size).toBeGreaterThan(1000);

      await shell('echo v2 > ~/workspace/proj/notes.txt && touch ~/workspace/proj/later.txt');
      await app.snapshots.restore(app.store.getAgent(ops.id)!, snap.id);

      expect(await shell('cat ~/workspace/proj/notes.txt; ls ~/workspace/proj; stat -c %U ~/workspace/proj/notes.txt')).toBe('v1\nnotes.txt\nagent');
    },
    240_000,
  );

  it(
    'runs the setup script on the real computer before the next tool call',
    async () => {
      app.store.updateAgent(ops.id, { setupScript: 'echo "set up by $(whoami)" > ~/setup-proof' });
      t.models.script('test/ops', [callTool('shell', { command: 'cat ~/setup-proof ~/.teambot/setup.sha' }), say('ok')]);
      app.workspace.postMessage({ channelId: general(app).id, authorId: t.owner.id, text: '@Ops check setup' });
      await app.runtime.idle(120_000);

      expect(app.lifecycle.lastSetup(ops.id)).toMatchObject({ ok: true, exitCode: 0 });
      const run = app.store.listRuns({ agentId: ops.id })[0];
      const out = app.store.getTranscript<TranscriptMessage>(run.id).find((m) => m.role === 'tool')!.content;
      expect(out).toContain('set up by agent');
    },
    180_000,
  );

  it(
    'with open internet, keeps the computer off the host, and starts locked after a restart Docker does by itself',
    async () => {
      // Something listening on the host's loopback, like TeamBot's own API.
      const site = http.createServer((_req, res) => res.end('HOST-REACHED'));
      await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
      const port = (site.address() as AddressInfo).port;
      const free = addAgent(app, 'Free');
      const agentShell = async (command: string) => {
        // As the agent, straight through Docker (not computerd), so it works before TeamBot has set anything up.
        const exec = await new Docker().getContainer(`teambot-${free.id}`).exec({ Cmd: ['sh', '-c', command], User: 'agent', AttachStdout: true, AttachStderr: true });
        const stream = await exec.start({ hijack: true, stdin: false });
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        await new Promise((r) => stream.on('end', r));
        return Buffer.concat(chunks).toString('utf8');
      };
      const probe = `curl -s -m 5 http://host.docker.internal:${port}/ || echo HOST-BLOCKED; echo; curl -s -m 8 -o /dev/null http://1.1.1.1/ && echo NET-OPEN || echo NET-BLOCKED`;
      // The way an agent's commands run: through computerd, which the entrypoint started without NET_ADMIN.
      const viaComputerd = async (command: string) =>
        (await (await app.lifecycle.ready(app.store.getAgent(free.id)!)).call<{ stdout: string }>('/shell', { command })).stdout;
      try {
        const out = await viaComputerd(`${probe}; sudo iptables -F OUTPUT 2>/dev/null && echo FIREWALL-LIFTED || echo FIREWALL-HELD`);
        expect(out).toContain('HOST-BLOCKED');
        expect(out).not.toContain('HOST-REACHED');
        expect(out).toContain('NET-OPEN');
        expect(out).toContain('FIREWALL-HELD');

        // Docker restarts it behind TeamBot's back: nothing gets out until TeamBot sets the rules again.
        await new Docker().getContainer(`teambot-${free.id}`).restart({ t: 2 });
        const locked = await agentShell(probe);
        expect(locked).toContain('NET-BLOCKED');
        expect(locked).not.toContain('HOST-REACHED');
        expect(await viaComputerd(probe)).toContain('NET-OPEN');
      } finally {
        await app.computers.reset(free.id);
        await new Promise((r) => site.close(r));
      }
    },
    300_000,
  );

  it(
    'cancelling a run stops its command on the computer',
    async () => {
      const marker = path.join(app.cfg.sharedDir, 'cancel-marker');
      fs.rmSync(marker, { force: true });
      t.models.script('test/ops', [callTool('shell', { command: 'sleep 4; touch /shared/cancel-marker' })]);
      app.workspace.postMessage({ channelId: general(app).id, authorId: t.owner.id, text: '@Ops run the slow job' });
      const deadline = Date.now() + 120_000;
      while (!app.store.listEvents({ agentId: ops.id, types: ['tool.started'] }).some((e) => e.data.tool === 'shell' && Date.now() - Date.parse(e.ts) < 120_000)) {
        if (Date.now() > deadline) throw new Error('the shell call never started');
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 1000));
      const run = app.store.listRuns({ agentId: ops.id })[0];
      app.runtime.cancelRun(run.id, t.owner.id);
      await app.runtime.idle(60_000);
      expect(app.store.getRun(run.id)!.status).toBe('cancelled');
      await new Promise((r) => setTimeout(r, 5000));
      expect(fs.existsSync(marker)).toBe(false);
    },
    180_000,
  );
});
