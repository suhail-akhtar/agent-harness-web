/**
 * Small JSON files in the app's data folder: prefs, plugin grants, the servers' encrypted tokens.
 * Written atomically (a temp file, then rename) so a crash cannot leave a truncated file; a file
 * that does not parse is kept aside as `<name>.bad` rather than overwritten.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_PREFS, mergePrefs, type DesktopPrefs } from '../shared/prefs';

export class JsonFile<T> {
  private file: string;
  private fallback: () => T;
  value: T;
  private timer: NodeJS.Timeout | null = null;
  constructor(file: string, fallback: () => T, parse: (raw: unknown) => T = (r) => r as T) {
    this.file = file;
    this.fallback = fallback;
    this.value = this.read(parse);
  }
  private read(parse: (raw: unknown) => T): T {
    try { return parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { try { fs.renameSync(this.file, `${this.file}.bad`); } catch { /* nothing to keep */ } }
      return this.fallback();
    }
  }
  set(v: T, now = false): void { this.value = v; if (now) this.flush(); else { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 200); } }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* a read-only folder: settings just do not persist */ }
  }
}

export class PrefsStore extends EventEmitter {
  private f: JsonFile<DesktopPrefs>;
  constructor(file: string) { super(); this.f = new JsonFile(file, () => structuredClone(DEFAULT_PREFS), (raw) => mergePrefs(DEFAULT_PREFS, raw)); }
  get(): DesktopPrefs { return this.f.value; }
  set(patch: Partial<DesktopPrefs>): DesktopPrefs {
    this.f.set(mergePrefs(this.f.value, patch));
    this.emit('change', this.f.value);
    return this.f.value;
  }
  flush(): void { this.f.flush(); }
}
