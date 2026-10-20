import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalHost } from '../runtime/host.ts';
import { toolByName } from '../tools/index.ts';
import { resolveIn } from '../tools/paths.ts';
import type { FileStamp, ToolContext } from '../tools/types.ts';

// What a companion does with each job from the server, kept apart from the
// network loop so it can be tested. Everything is confined to the folder the
// companion was started in.

export type CompanionJob =
  | { id: string; kind: 'tool'; sessionId: string; name: string; input: Record<string, unknown> }
  | { id: string; kind: 'exec'; sessionId: string; command: string; timeoutMs: number; stdin?: string }
  | { id: string; kind: 'pull'; sessionId: string; known: Record<string, [number, number]>; maxBytes: number }
  | { id: string; kind: 'push'; sessionId: string; path: string; data: string };

/** Folders never copied to the server: big, regenerated, or private to tools. */
export const MIRROR_SKIP = new Set(['node_modules', '.git', '.harness', '.venv', 'venv', '__pycache__', '.next', 'target', 'dist', 'build', 'coverage']);
const FILE_MAX = 20 * 1024 * 1024;

export function createCompanionHandler(dir: string, opts: { allowHooks?: boolean; log?: (m: string) => void } = {}) {
  const host = new LocalHost(dir);
  const readFiles = new Map<string, Map<string, FileStamp>>();

  /** Files that changed since the server's copy (by size and mtime), and the ones that are gone. */
  async function pull(known: Record<string, [number, number]>, maxBytes: number) {
    const files: { path: string; size: number; mtime: number; data?: string }[] = [];
    let bytes = 0;
    const walk = async (rel: string) => {
      for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!MIRROR_SKIP.has(e.name)) await walk(r); continue; }
        if (!e.isFile()) continue;
        const st = await fs.stat(path.join(dir, r));
        if (st.size > FILE_MAX) continue;
        const mtime = Math.floor(st.mtimeMs);
        const k = known[r];
        if (k && k[0] === st.size && k[1] === mtime) { files.push({ path: r, size: st.size, mtime }); continue; }
        bytes += st.size;
        if (bytes > maxBytes) throw new Error(`the folder has more than ${Math.round(maxBytes / 1048576)} MB to copy for this tool (node_modules, .git and build output are skipped)`);
        files.push({ path: r, size: st.size, mtime, data: (await fs.readFile(path.join(dir, r))).toString('base64') });
      }
    };
    await walk('');
    return { files };
  }

  return async function handle(job: CompanionJob): Promise<{ ok: boolean; value: unknown }> {
    try {
      if (job.kind === 'exec') {
        if (!opts.allowHooks) throw new Error('hooks are disabled on this companion (start it with --allow-hooks)');
        return { ok: true, value: await host.exec(job.command, { timeoutMs: job.timeoutMs, stdin: job.stdin }) };
      }
      if (job.kind === 'pull') {
        opts.log?.('copying changed files for a server-side tool');
        return { ok: true, value: await pull(job.known ?? {}, job.maxBytes) };
      }
      if (job.kind === 'push') {
        const real = await resolveIn(host, job.path);
        await fs.mkdir(path.dirname(real), { recursive: true });
        await fs.writeFile(real, Buffer.from(job.data, 'base64'));
        opts.log?.(`wrote ${job.path}`);
        return { ok: true, value: { ok: true } };
      }
      if (job.kind === 'tool') {
        const tool = toolByName(job.name);
        if (!tool || !tool.remoteable) throw new Error(`tool ${job.name} does not run on the companion`);
        const files = readFiles.get(job.sessionId) ?? new Map<string, FileStamp>();
        readFiles.set(job.sessionId, files);
        const ctx: ToolContext = { host, signal: new AbortController().signal, readFiles: files, todos: [], setTodos() {}, emit() {} };
        opts.log?.(tool.summarize(job.input));
        try { return { ok: true, value: await tool.run(job.input, ctx) }; } catch (err) { return { ok: true, value: { content: (err as Error).message, is_error: true } }; }
      }
      throw new Error(`this companion does not know the job "${(job as { kind: string }).kind}": update it (download it again from the web app)`);
    } catch (err) {
      return { ok: false, value: { error: (err as Error).message } };
    }
  };
}
