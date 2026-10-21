import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// File checkpoints: before a tool first changes a file in a turn, its previous
// content is saved. Rewinding to turn N puts every file touched in turns >= N
// back the way it was before turn N (files created since are removed).
// Like Claude Code's checkpoints, this covers changes made through the file
// tools; changes a shell command makes are not tracked.

export interface CheckpointTurn { turn: number; at: number; prompt: string; files: string[] }

/**
 * Where the files are. Local: the workspace folder. A companion: the user's
 * computer, reached through file jobs (get, push, delete).
 */
export interface CheckpointFiles {
  /** The workspace-relative path ('/'-separated) of a path a tool was given, or undefined when it is outside. */
  rel(p: string): Promise<string | undefined>;
  read(rel: string): Promise<Buffer | null>;
  write(rel: string, data: Buffer): Promise<void>;
  remove(rel: string): Promise<void>;
}

/** The workspace folder on this machine (symlinks resolved, so a link cannot point a restore outside). */
export function localFiles(root: string): CheckpointFiles {
  const rootReal = () => fs.realpath(root);
  return {
    async rel(p) {
      const r = path.relative(await rootReal(), await canonical(p));
      return r.startsWith('..') || path.isAbsolute(r) ? undefined : r.split(path.sep).join('/');
    },
    read: (rel) => fs.readFile(path.join(root, ...rel.split('/'))).catch(() => null),
    async write(rel, data) { const t = path.join(await rootReal(), ...rel.split('/')); await fs.mkdir(path.dirname(t), { recursive: true }); await fs.writeFile(t, data); },
    async remove(rel) { await fs.rm(path.join(await rootReal(), ...rel.split('/')), { force: true }); },
  };
}

/** The canonical path, also for a file that does not exist yet (its folder is resolved). */
async function canonical(p: string): Promise<string> {
  const abs = path.resolve(p);
  try { return await fs.realpath(abs); } catch { /* not there yet */ }
  try { return path.join(await fs.realpath(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}
interface Manifest { at: number; prompt: string; files: Record<string, { existed: boolean; blob?: string }> }

export class Checkpoints {
  private dir: string;
  private files: CheckpointFiles;
  private turn = 0;
  private prompt = '';
  private manifest?: Manifest;
  /** Saves run one at a time: parallel tool calls once overwrote each other's manifest entries. */
  private queue: Promise<void> = Promise.resolve();

  constructor(sessionDir: string, workspace: string | CheckpointFiles) {
    this.dir = path.join(sessionDir, 'checkpoints');
    this.files = typeof workspace === 'string' ? localFiles(workspace) : workspace;
  }

  /** Starts a new turn: later saves go to it. */
  begin(turn: number, prompt: string): void {
    this.turn = turn;
    this.prompt = prompt;
    this.manifest = undefined;
  }

  private turnDir(t: number) { return path.join(this.dir, String(t).padStart(6, '0')); }

  before(filePath: string): Promise<void> {
    const next = this.queue.then(() => this.save(filePath));
    this.queue = next.catch(() => {});
    return next;
  }

  private async save(filePath: string): Promise<void> {
    const rel = await this.files.rel(filePath);
    if (!rel) return;
    const td = this.turnDir(this.turn);
    if (!this.manifest) {
      this.manifest = await fs.readFile(path.join(td, 'manifest.json'), 'utf8').then((t) => JSON.parse(t) as Manifest).catch(() => ({ at: Date.now(), prompt: this.prompt.slice(0, 120), files: {} }));
    }
    if (this.manifest.files[rel]) return;
    let entry: { existed: boolean; blob?: string };
    const data = await this.files.read(rel);
    if (data) {
      const blob = crypto.createHash('sha256').update(data).digest('hex');
      await fs.mkdir(path.join(this.dir, 'blobs'), { recursive: true });
      await fs.writeFile(path.join(this.dir, 'blobs', blob), data, { flag: 'w' });
      entry = { existed: true, blob };
    } else {
      entry = { existed: false };
    }
    this.manifest.files[rel] = entry;
    await fs.mkdir(td, { recursive: true });
    const f = path.join(td, 'manifest.json');
    await fs.writeFile(`${f}.tmp`, JSON.stringify(this.manifest));
    await fs.rename(`${f}.tmp`, f);
  }

  async list(): Promise<CheckpointTurn[]> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const out: CheckpointTurn[] = [];
    for (const n of names.filter((x) => /^\d+$/.test(x)).sort()) {
      try {
        const m = JSON.parse(await fs.readFile(path.join(this.dir, n, 'manifest.json'), 'utf8')) as Manifest;
        out.push({ turn: Number(n), at: m.at, prompt: m.prompt, files: Object.keys(m.files) });
      } catch { /* partial */ }
    }
    return out;
  }

  /** Restores files to their state before `turn`. Returns the files changed. */
  async rewind(turn: number): Promise<string[]> {
    const turns = (await this.list()).filter((t) => t.turn >= turn).sort((a, b) => b.turn - a.turn);
    const restored = new Set<string>();
    for (const t of turns) {
      const m = JSON.parse(await fs.readFile(path.join(this.turnDir(t.turn), 'manifest.json'), 'utf8')) as Manifest;
      for (const [rel, e] of Object.entries(m.files)) {
        // Manifests written before paths were '/'-separated are read the same way.
        const r = rel.split(path.sep).join('/');
        if (e.existed && e.blob) await this.files.write(r, await fs.readFile(path.join(this.dir, 'blobs', e.blob)));
        else await this.files.remove(r);
        restored.add(rel);
      }
      await fs.rm(this.turnDir(t.turn), { recursive: true, force: true });
    }
    this.manifest = undefined;
    return [...restored].sort();
  }
}
