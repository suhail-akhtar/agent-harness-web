import fs from 'node:fs/promises';
import path from 'node:path';
import { MIRROR_SKIP, MIRROR_SKIP_FILE } from '../companion/handler.ts';
import { mirrorPath } from '../runtime/companion.ts';
import type { SessionManager } from './manager.ts';
import type { Session, SessionMeta } from './session.ts';
import type { Message, Todo } from './types.ts';

// A session as one portable bundle - its conversation, todos and workspace files -
// to move it between servers, or between the web app and the desktop app (Claude
// Code's "teleport"). Heavy folders and secret files never go in. Importing makes
// a new session that continues where the old one stopped; it never brings a looser
// permission mode, and a conversation that held untrusted content still counts as
// tainted.

export interface SessionBundle {
  format: 'harness-session';
  version: 1;
  exportedAt: number;
  source: { id: string; title: string; model: string; effort: string; mode: string; tainted: boolean; todos: Todo[]; contextStart: number; compactions: number; lastPromptTokens: number; cost: number };
  history: Message[];
  files: { path: string; data: string }[];
  /** Files left out (too big for the bundle). */
  skipped: string[];
}

export class BundleError extends Error {}

const FILE_MAX = 20 * 1024 * 1024;

/** The bundle for a session; workspace files up to maxBytes in all (the rest is listed as skipped). */
export async function exportSession(s: Session, maxBytes = Number(process.env.HARNESS_EXPORT_MAX_MB ?? 50) * 1024 * 1024): Promise<SessionBundle> {
  const files: SessionBundle['files'] = [];
  const skipped: string[] = [];
  let total = 0;
  if (s.meta.runtime.kind !== 'companion') {
    const root = s.workspace;
    const walk = async (rel: string): Promise<void> => {
      for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!MIRROR_SKIP.has(e.name)) await walk(r); continue; }
        if (!e.isFile() || MIRROR_SKIP_FILE.test(e.name)) continue;
        const st = await fs.stat(path.join(root, r));
        if (st.size > FILE_MAX || total + st.size > maxBytes) { skipped.push(r); continue; }
        total += st.size;
        files.push({ path: r, data: (await fs.readFile(path.join(root, r))).toString('base64') });
      }
    };
    await walk('');
  }
  const m = s.meta;
  return {
    format: 'harness-session', version: 1, exportedAt: Date.now(),
    source: { id: m.id, title: m.title, model: m.model, effort: m.effort, mode: m.mode, tainted: !!m.tainted, todos: m.todos, contextStart: m.contextStart, compactions: m.compactions, lastPromptTokens: m.lastPromptTokens, cost: m.cost },
    history: s.history, files, skipped,
  };
}

const BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'image', 'reasoning']);

/** Checks a bundle's shape before anything is written from it. */
export function validateBundle(b: unknown): SessionBundle {
  const x = b as SessionBundle;
  if (!x || x.format !== 'harness-session' || x.version !== 1) throw new BundleError('not a harness session bundle (format harness-session, version 1)');
  if (!Array.isArray(x.history) || !Array.isArray(x.files) || !x.source || typeof x.source.title !== 'string') throw new BundleError('the bundle is incomplete');
  for (const m of x.history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || !Array.isArray(m.content)) throw new BundleError('the conversation in the bundle is not valid');
    for (const b2 of m.content) if (!b2 || !BLOCKS.has((b2 as { type: string }).type)) throw new BundleError(`unknown block type in the conversation: ${(b2 as { type?: string })?.type}`);
  }
  for (const f of x.files) if (typeof f?.path !== 'string' || typeof f.data !== 'string') throw new BundleError('a file in the bundle is not valid');
  return x;
}

/** Tools whose results are outside content (a conservative reading of an imported history). */
const outside = (name: string) => /^(web_fetch|web_search|tool_call|sources|check_citations)$/.test(name) || name.startsWith('mcp__');

/** A new session from a bundle, in the runtime the importer chose. */
export async function importSession(mgr: SessionManager, raw: unknown, opts: { owner?: string; runtime: SessionMeta['runtime']; model?: string }): Promise<Session> {
  const b = validateBundle(raw);
  const model = opts.model ?? (mgr.registry.listModels().some((m) => m.id === b.source.model && m.available) ? b.source.model : mgr.registry.listModels().find((m) => m.available)?.id);
  if (!model) throw new BundleError('no model is available on this server');
  // Never a looser mode than asking: the person importing chooses that again here.
  const s = await mgr.create({ title: b.source.title, model, mode: 'default', runtime: opts.runtime, owner: opts.owner });
  try {
    if (opts.runtime.kind !== 'companion') {
      const root = s.workspace;
      for (const f of b.files) {
        // The same rule as a companion's mirror: plain relative paths, never outside the folder.
        const target = mirrorPath(root, f.path);
        if (!target) continue;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.from(f.data, 'base64'));
      }
    }
    const tainted = b.source.tainted || b.history.some((m) => m.content.some((x) => x.type === 'tool_use' && outside((x as { name: string }).name)));
    await s.adoptHistory({ history: b.history, todos: Array.isArray(b.source.todos) ? b.source.todos : [], tainted, contextStart: Number(b.source.contextStart) || 0, compactions: Number(b.source.compactions) || 0, lastPromptTokens: Number(b.source.lastPromptTokens) || 0, from: `${b.source.title} (${b.source.id})` });
    return s;
  } catch (e) {
    await mgr.remove(s.meta.id).catch(() => {});
    throw e;
  }
}
