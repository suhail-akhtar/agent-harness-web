import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../util/shared-file.ts';

// The change journal: one timeline of what changed on the systems the harness
// operates - deploys, rollouts, Terraform applies, CI runs, commits, restarts,
// runbooks - kept by the framework at <data>/changes.jsonl, outside every
// workspace. Tools record into it (ToolServices.changes), plugin server code too
// (api.changes: CI/CD webhooks), and incident correlation reads it ("what changed
// in the two hours before this started?").
//
// One JSON line per change. Appends take the file's lock (several servers may share
// the data folder) and write the whole line at once, so a reader never sees half of
// one; a line that does not parse is skipped. Old entries are trimmed when the file
// grows past its cap (the newest are kept).

export const CHANGE_KINDS = ['deploy', 'k8s-apply', 'rollout', 'rollback', 'iac-apply', 'ci-run', 'commit', 'config', 'restart', 'runbook', 'scale', 'other'] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];

export interface ChangeInput {
  kind: ChangeKind;
  /** What changed: a host, a cluster/namespace/workload, a compose project, a Terraform module, a repository. */
  target: string;
  service?: string;
  env?: string;
  summary: string;
  /** Who made it: an account, "operator", a CI system's actor, a plugin. */
  by: string;
  /** When it happened (ms); default now. */
  at?: number;
  /** A link or an identifier: a commit sha, a run URL, a plan hash. */
  ref?: string;
  /** Where the record came from: "session:<id>", "github-webhook", "git:<repo>", a plugin. */
  source?: string;
}

export interface ChangeEvent extends Required<Pick<ChangeInput, 'kind' | 'target' | 'summary' | 'by' | 'at'>> {
  id: string;
  service?: string;
  env?: string;
  ref?: string;
  source?: string;
  /** When it was recorded (may be later than `at`: a webhook delivered late, commits imported). */
  recordedAt: number;
}

export interface ChangeQuery { since: number; until?: number; service?: string; env?: string; target?: string; limit?: number }

/** What a session's tools and plugin code get: `by` defaults to the caller where the harness knows it. */
export interface ChangeService {
  record(c: ChangeInput): Promise<void>;
  query(q: ChangeQuery): Promise<ChangeEvent[]>;
}

const MAX_BYTES = Number(process.env.HARNESS_CHANGES_MAX_MB ?? 20) * 1024 * 1024;
const text = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

export class ChangeError extends Error {}

/** Checks and normalises one change; throws ChangeError with what is wrong. */
export function normaliseChange(c: ChangeInput, now = Date.now()): ChangeEvent {
  if (!c || typeof c !== 'object') throw new ChangeError('a change must be an object');
  if (!(CHANGE_KINDS as readonly string[]).includes(String(c.kind))) throw new ChangeError(`kind must be one of ${CHANGE_KINDS.join(', ')} (got "${c.kind}")`);
  const target = text(c.target, 300);
  const summary = text(c.summary, 2000);
  const by = text(c.by, 200);
  if (!target) throw new ChangeError('a change needs a target (what changed)');
  if (!summary) throw new ChangeError('a change needs a summary');
  if (!by) throw new ChangeError('a change needs by (who made it)');
  const at = c.at === undefined ? now : Number(c.at);
  if (!Number.isFinite(at) || at <= 0) throw new ChangeError(`at must be a time in milliseconds (got "${c.at}")`);
  const opt = (v: unknown, max: number) => { const s = text(v, max); return s ? s : undefined; };
  const service = opt(c.service, 120); const env = opt(c.env, 60); const ref = opt(c.ref, 1000); const source = opt(c.source, 200);
  return {
    id: `chg_${crypto.randomBytes(6).toString('hex')}`, kind: c.kind, target, summary, by, at: Math.round(at), recordedAt: now,
    ...(service ? { service } : {}), ...(env ? { env } : {}), ...(ref ? { ref } : {}), ...(source ? { source } : {}),
  };
}

export class ChangeJournal implements ChangeService {
  readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'changes.jsonl'); }

  async record(c: ChangeInput): Promise<void> {
    const e = normaliseChange(c);
    await withFileLock(this.file, async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, `${JSON.stringify(e)}\n`);
      const st = await fs.stat(this.file).catch(() => null);
      if (st && st.size > MAX_BYTES) {
        // Keep the newest half: a journal for correlation, not an archive.
        const lines = (await fs.readFile(this.file, 'utf8')).split('\n').filter(Boolean);
        const keep = lines.slice(Math.floor(lines.length / 2));
        const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fs.writeFile(tmp, `${keep.join('\n')}\n`);
        await fs.rename(tmp, this.file);
      }
    }, { staleMs: 30_000, waitMs: 120_000 });
  }

  /** Changes in [since, until] (by `at`), filtered, newest first. */
  async query(q: ChangeQuery): Promise<ChangeEvent[]> {
    const raw = await fs.readFile(this.file, 'utf8').catch(() => '');
    const until = q.until ?? Number.MAX_SAFE_INTEGER;
    const want = (v: string | undefined, f: string | undefined) => !f || (v ?? '').toLowerCase() === f.toLowerCase();
    const out: ChangeEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e: ChangeEvent;
      try { e = JSON.parse(line) as ChangeEvent; } catch { continue; }
      if (!e || typeof e.at !== 'number' || e.at < q.since || e.at > until) continue;
      if (!want(e.service, q.service) || !want(e.env, q.env)) continue;
      if (q.target && !e.target.toLowerCase().includes(q.target.toLowerCase())) continue;
      out.push(e);
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, Math.max(1, Math.min(q.limit ?? 500, 5000)));
  }
}
