import { readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';

// Workflow runs that paused at a step needing a plugin that is switched off: listed here (one
// small file for the server), so switching the plugin on carries each of them on from that step.

export interface PausedRun { plugin: string; sessionId: string; runId: string; at: number }

export class PausedRuns {
  private file: string;
  constructor(file: string) { this.file = file; }

  async add(r: Omit<PausedRun, 'at'>): Promise<void> {
    await withFileLock(this.file, async () => {
      const list = await this.read();
      if (!list.some((x) => x.runId === r.runId && x.sessionId === r.sessionId && x.plugin === r.plugin)) list.push({ ...r, at: Date.now() });
      await writeFileAtomic(this.file, JSON.stringify(list, null, 1));
    });
  }

  /** The runs waiting for `plugin`, taken off the list. */
  async take(plugin: string): Promise<PausedRun[]> {
    return withFileLock(this.file, async () => {
      const list = await this.read();
      const mine = list.filter((x) => x.plugin === plugin);
      if (mine.length) await writeFileAtomic(this.file, JSON.stringify(list.filter((x) => x.plugin !== plugin), null, 1));
      return mine;
    });
  }

  private async read(): Promise<PausedRun[]> {
    const v = await readJson<PausedRun[]>(this.file, []);
    return Array.isArray(v) ? v : [];
  }
}
