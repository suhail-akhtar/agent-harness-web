import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileWatch, readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';

// The agent inbox: what work done without the person watching left for them, in one queue they own.
// A scheduled or triggered run's outcome (result), what an agent told them (message), and work an agent
// offered to do while nobody was watching (suggestion: a proposal they start or dismiss). Each item is
// read, snoozed or dismissed with a reason; every response is written to a feedback log, so how useful
// each kind of item is can be measured (which items get opened, which dismissed, and why).

export type InboxKind = 'result' | 'message' | 'suggestion';
export type DismissReason = 'not_useful' | 'wrong' | 'bad_timing' | 'other';
export const DISMISS_REASONS: DismissReason[] = ['not_useful', 'wrong', 'bad_timing', 'other'];

export interface InboxItem {
  id: string;
  owner?: string;
  kind: InboxKind;
  title: string;
  body: string;
  at: number;
  /** How it reads: a result that failed or stopped is a warning. */
  level: 'info' | 'warn' | 'error';
  /** new: not seen; read; dismissed (by the person, or a suggestion they declined or that expired); done (a suggestion started). */
  status: 'new' | 'read' | 'dismissed' | 'done';
  sessionId?: string;
  scheduleId?: string;
  runId?: string;
  proposalId?: string;
  readAt?: number;
  /** Hidden from the open list until then. */
  snoozedUntil?: number;
  resolvedAt?: number;
  reason?: DismissReason;
  note?: string;
}

export type InboxAction = 'read' | 'unread' | 'open' | 'snooze' | 'dismiss' | 'done';

/** One response of the person's to an item (the feedback log). */
export interface InboxFeedback { at: number; itemId: string; kind: InboxKind; action: InboxAction; owner?: string; scheduleId?: string; sessionId?: string; reason?: DismissReason; note?: string; latencyMs: number }

const MAX_PER_OWNER = Number(process.env.HARNESS_INBOX_MAX ?? 500);

export class InboxError extends Error {}

export class InboxStore {
  readonly file: string;
  readonly feedbackFile: string;
  private items = new Map<string, InboxItem>();
  private watch: FileWatch;
  /** Told of every item added or changed (the server's event stream). */
  onChange?: (type: 'added' | 'changed', item: InboxItem) => void;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'inbox.json');
    this.feedbackFile = path.join(dataDir, 'inbox-feedback.jsonl');
    this.watch = new FileWatch(this.file);
  }

  async load(): Promise<this> { await this.reload(); return this; }
  private async reload(): Promise<void> {
    const list = await readJson<InboxItem[]>(this.file, []);
    this.items = new Map((Array.isArray(list) ? list : []).map((i) => [i.id, i]));
    await this.watch.mark();
  }
  /** Reads the file again when another server changed it. */
  async sync(force = false): Promise<void> { if (await this.watch.changed(force)) await this.reload(); }

  private async mutate<T>(fn: () => T): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    return withFileLock(this.file, async () => {
      await this.reload();
      const r = fn();
      await writeFileAtomic(this.file, JSON.stringify([...this.items.values()], null, 1));
      await this.watch.mark();
      return r;
    });
  }

  private tell(type: 'added' | 'changed', item: InboxItem | undefined): void {
    if (!item) return;
    try { this.onChange?.(type, item); } catch { /* a listener never breaks the inbox */ }
  }

  async add(spec: Omit<InboxItem, 'id' | 'at' | 'status' | 'level'> & { level?: InboxItem['level']; at?: number }): Promise<InboxItem> {
    const item: InboxItem = {
      id: `in_${crypto.randomBytes(6).toString('hex')}`, at: spec.at ?? Date.now(), status: 'new', level: spec.level ?? 'info',
      ...Object.fromEntries(Object.entries(spec).filter(([k, v]) => v !== undefined && k !== 'at' && k !== 'level')),
      title: (spec.title || 'Untitled').slice(0, 160), body: (spec.body ?? '').slice(0, 4000),
    } as InboxItem;
    const made = await this.mutate(() => {
      this.items.set(item.id, item);
      // Past the limit, the oldest items the person is done with go first, then the oldest of all.
      const mine = [...this.items.values()].filter((i) => i.owner === item.owner);
      if (mine.length > MAX_PER_OWNER) {
        const drop = mine.sort((a, b) => Number(a.status === 'new') - Number(b.status === 'new') || Number(a.status === 'read') - Number(b.status === 'read') || a.at - b.at).slice(0, mine.length - MAX_PER_OWNER);
        for (const d of drop) this.items.delete(d.id);
      }
      return item;
    });
    this.tell('added', made);
    return made;
  }

  get(id: string): InboxItem | undefined { return this.items.get(id); }

  /** An owner's items, newest first: open ones (not dismissed or done, not snoozed now), or all. */
  list(owner: string | undefined, o: { view?: 'open' | 'all'; now?: number; all?: boolean } = {}): InboxItem[] {
    const now = o.now ?? Date.now();
    return [...this.items.values()]
      .filter((i) => (o.all || i.owner === owner) && (o.view === 'all' || ((i.status === 'new' || i.status === 'read') && !(i.snoozedUntil && i.snoozedUntil > now))))
      .sort((a, b) => b.at - a.at);
  }

  /** Items not seen yet (and not snoozed). */
  unread(owner: string | undefined, now = Date.now()): number {
    return this.list(owner, { now }).filter((i) => i.status === 'new').length;
  }

  /** The person's response to an item; written to the feedback log. */
  async act(id: string, action: InboxAction, o: { reason?: string; note?: string; until?: number; now?: number } = {}): Promise<InboxItem | undefined> {
    const now = o.now ?? Date.now();
    if (action === 'dismiss' && o.reason !== undefined && !DISMISS_REASONS.includes(o.reason as DismissReason)) throw new InboxError(`reason is one of ${DISMISS_REASONS.join(', ')}`);
    if (action === 'snooze' && !(typeof o.until === 'number' && o.until > now)) throw new InboxError('snooze needs a time in the future (until)');
    const done = await this.mutate(() => {
      const i = this.items.get(id);
      if (!i) return undefined;
      if (action === 'read' || action === 'open') { if (i.status === 'new') { i.status = 'read'; i.readAt = now; } }
      else if (action === 'unread') { if (i.status === 'read') { i.status = 'new'; delete i.readAt; } }
      else if (action === 'snooze') { i.snoozedUntil = o.until; if (i.status === 'new') { i.status = 'read'; i.readAt = now; } }
      else if (action === 'dismiss') { i.status = 'dismissed'; i.resolvedAt = now; if (o.reason) i.reason = o.reason as DismissReason; if (o.note) i.note = o.note.slice(0, 500); delete i.snoozedUntil; }
      else if (action === 'done') { i.status = 'done'; i.resolvedAt = now; delete i.snoozedUntil; }
      return { ...i };
    });
    if (!done) return undefined;
    await this.feedback({ at: now, itemId: id, kind: done.kind, action, owner: done.owner, ...(done.scheduleId ? { scheduleId: done.scheduleId } : {}), ...(done.sessionId ? { sessionId: done.sessionId } : {}), ...(action === 'dismiss' && o.reason ? { reason: o.reason as DismissReason } : {}), ...(action === 'dismiss' && o.note ? { note: o.note.slice(0, 500) } : {}), latencyMs: Math.max(0, now - done.at) });
    this.tell('changed', done);
    return done;
  }

  /** Marks every new item of the owner's read. */
  async readAll(owner: string | undefined, now = Date.now()): Promise<number> {
    const ids = this.list(owner, { now }).filter((i) => i.status === 'new').map((i) => i.id);
    for (const id of ids) await this.act(id, 'read', { now });
    return ids.length;
  }

  /** The item of a proposal (a suggestion), to follow what became of it. */
  byProposal(proposalId: string): InboxItem | undefined {
    return [...this.items.values()].find((i) => i.proposalId === proposalId);
  }

  /** The feedback log, oldest first (for measuring; Phase 4 reads it). */
  async feedbackLog(): Promise<InboxFeedback[]> {
    const text = await fs.readFile(this.feedbackFile, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as InboxFeedback]; } catch { return []; } });
  }

  private async feedback(f: InboxFeedback): Promise<void> {
    await fs.appendFile(this.feedbackFile, JSON.stringify(f) + '\n').catch(() => {});
  }
}
