// The plugin's own state on the server (api.dataDir, outside every workspace):
// which chat message is each incident's or session's thread, the approval
// requests posted and how they were decided, the tickets and pages made per
// incident, and the Slack event ids already handled. Plus an append-only audit
// log of every decision, refusal and write to another system.

import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ threads: {}, sessions: {}, incidents: {}, pending: {}, seen: {} });

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.auditFile = path.join(dir, 'audit.jsonl');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { this.data = EMPTY(); }
    this.timer = undefined;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.prune();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  prune(now = Date.now()) {
    const d = this.data;
    for (const [k, t] of Object.entries(d.seen)) if (now - t > 24 * 3600_000) delete d.seen[k];
    for (const [k, p] of Object.entries(d.pending)) if (p.status !== 'pending' && now - (p.decidedAt ?? p.at) > 7 * 24 * 3600_000) delete d.pending[k];
    const limit = (obj, n) => { const keys = Object.keys(obj); if (keys.length > n) for (const k of keys.slice(0, keys.length - n)) delete obj[k]; };
    limit(d.sessions, 5000); limit(d.threads, 5000); limit(d.incidents, 5000);
  }

  /** Whether an inbound event id was handled already (Slack retries with X-Slack-Retry-Num). Marks it seen. */
  firstTime(id) {
    if (this.data.seen[id]) return false;
    this.data.seen[id] = Date.now();
    this.save();
    return true;
  }

  audit(record) {
    fs.appendFileSync(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  }

  readAudit() {
    try { return fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }
}
