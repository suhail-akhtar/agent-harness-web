import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock, writeFileAtomic } from '../util/shared-file.ts';

// A plugin's own data, versioned (api.store): one JSON document per name in the plugin's data folder,
// written atomically under a lock (several servers may share the folder), stamped with the version of
// its shape. A newer plugin that changed the shape says how to bring old data forward (migrations, one
// step per version); the document is upgraded the first time it is read, and the old file is kept
// beside it (<name>.v<old>.json) so an upgrade can be undone by hand.

export interface StoreOptions<T> {
  /** The version of the data's shape this code reads and writes (a whole number, 1 and up; default 1). */
  version?: number;
  /** The document when nothing is stored yet. */
  initial: () => T;
  /**
   * How to bring data forward: migrations[n] turns version n-1's document into version n's. A
   * version with no step is refused (the data is left as it was), as is data newer than this code.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  migrations?: Record<number, (old: any) => unknown>;
}

export interface PluginStore<T> {
  /** The document (upgraded to this version first when it is older). */
  read(): Promise<T>;
  /** Replaces the document. */
  write(doc: T): Promise<void>;
  /** Reads, changes and writes it under the lock: `fn` edits the draft in place or returns a new one. */
  update(fn: (draft: T) => T | void | Promise<T | void>): Promise<T>;
  /** The file it lives in (inside the plugin's data folder). */
  readonly file: string;
}

interface Stored { version: number; data: unknown }

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function makeStore<T>(plugin: string, dataDir: string, name: string, o: StoreOptions<T>): PluginStore<T> {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`${plugin}: a store's name is letters, digits, . _ - (got "${name}")`);
  if (typeof o?.initial !== 'function') throw new Error(`${plugin}: api.store("${name}") needs initial: () => <the empty document>`);
  const version = o.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error(`${plugin}: api.store("${name}"): version is a whole number, 1 or more`);
  const file = path.join(dataDir, `${name}.json`);

  const parse = (raw: string): Stored => {
    let j: unknown;
    try { j = JSON.parse(raw); } catch (e) { throw new Error(`${plugin}: ${file} is not JSON (${(e as Error).message}); fix or remove it`); }
    // Data written before the plugin used api.store (a bare document): version 1.
    if (j && typeof j === 'object' && !Array.isArray(j) && 'version' in j && 'data' in j && Number.isInteger((j as Stored).version)) return j as Stored;
    return { version: 1, data: j };
  };

  /** The stored document at this version, upgrading it on disk when it was older. Call under the lock. */
  const load = async (): Promise<T> => {
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return o.initial(); throw e; }
    const s = parse(raw);
    if (s.version === version) return s.data as T;
    if (s.version > version) throw new Error(`${plugin}: the "${name}" data is version ${s.version}, newer than this plugin's (${version}): a newer version of the plugin wrote it. Install that version again, or restore ${name}.v${version}.json if an upgrade kept one.`);
    let data = s.data;
    for (let v = s.version + 1; v <= version; v++) {
      const step = o.migrations?.[v];
      if (typeof step !== 'function') throw new Error(`${plugin}: the "${name}" data is version ${s.version} and this plugin reads version ${version}, but it has no migration to version ${v} (migrations[${v}]). The data was left as it was.`);
      try { data = await step(data); } catch (e) { throw new Error(`${plugin}: migrating the "${name}" data to version ${v} failed: ${(e as Error).message}. The data was left as it was.`); }
    }
    // The old file stays beside it, so an upgrade can be undone by hand.
    await fs.copyFile(file, path.join(dataDir, `${name}.v${s.version}.json`));
    await save(data as T);
    return data as T;
  };
  const save = async (doc: T) => {
    await fs.mkdir(dataDir, { recursive: true });
    await writeFileAtomic(file, JSON.stringify({ version, data: doc }, null, 1));
  };
  const locked = <R>(fn: () => Promise<R>) => fs.mkdir(dataDir, { recursive: true }).then(() => withFileLock(file, fn));

  return {
    file,
    read: () => locked(load),
    write: (doc) => locked(() => save(doc)),
    update: (fn) => locked(async () => {
      const draft = await load();
      const out = await fn(draft);
      const next = (out === undefined ? draft : out) as T;
      await save(next);
      return next;
    }),
  };
}
