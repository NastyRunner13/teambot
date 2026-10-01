// Snapshots of an agent's computer: its whole home folder (files, browser logins, installed tools) as a
// compressed archive in <data>/snapshots/<agentId>/, which can be restored later.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { Agent, Snapshot } from '@teambot/shared';
import type { App } from './app.js';

const ID_RE = /^\d{8}T\d{6}Z(-\d+)?$/;

export class Snapshots {
  constructor(private app: App) {}

  private dir(agentId: string) {
    return path.join(this.app.cfg.dataDir, 'snapshots', agentId);
  }

  list(agentId: string): Snapshot[] {
    const dir = this.dir(agentId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Snapshot)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private file(agentId: string, id: string) {
    if (!ID_RE.test(id)) throw new Error('not a snapshot id');
    return path.join(this.dir(agentId), `${id}.tar.gz`);
  }

  async take(agent: Agent, label: string): Promise<Snapshot> {
    const dir = this.dir(agent.id);
    fs.mkdirSync(dir, { recursive: true });
    let id = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
    for (let n = 2; fs.existsSync(path.join(dir, `${id}.json`)); n++) id = `${id.split('-')[0]}-${n}`;
    const file = this.file(agent.id, id);
    const spec = await this.app.lifecycle.spec(agent);
    try {
      await pipeline(await this.app.computers.exportHome(agent.id, spec), zlib.createGzip(), fs.createWriteStream(file));
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
    const snapshot: Snapshot = { id, agentId: agent.id, label: label.trim() || 'Snapshot', size: fs.statSync(file).size, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(snapshot));
    this.app.bus.emit('computer.snapshot', { agentId: agent.id }, { snapshot });
    return snapshot;
  }

  async restore(agent: Agent, id: string) {
    const file = this.file(agent.id, id);
    if (!fs.existsSync(file)) throw new Error('snapshot not found');
    const spec = await this.app.lifecycle.spec(agent);
    await this.app.computers.importHome(agent.id, fs.createReadStream(file).pipe(zlib.createGunzip()), spec);
    this.app.bus.emit('computer.restored', { agentId: agent.id }, { snapshotId: id });
  }

  remove(agentId: string, id: string) {
    fs.rmSync(this.file(agentId, id), { force: true });
    fs.rmSync(path.join(this.dir(agentId), `${id}.json`), { force: true });
  }

  removeAll(agentId: string) {
    fs.rmSync(this.dir(agentId), { recursive: true, force: true });
  }
}
