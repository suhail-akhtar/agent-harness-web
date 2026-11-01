import type { InboxItem } from './inbox.ts';

// When unattended work may interrupt the person. Every update lands in their inbox; whether it also
// interrupts them (a toast, a system notification) depends on what the schedule says to do with its
// results, on their quiet hours, and on how many times they have been interrupted today. What does not
// interrupt waits in the inbox and, if they want one, in a daily digest. Nothing here ever makes a
// schedule act more on its own: that stays the person's choice.

/** What a schedule's results do: interrupt every time, only when it matters, go to the digest, or stay in its history. */
export type NotifyPolicy = 'always' | 'important' | 'digest' | 'silent';
export const NOTIFY_POLICIES: NotifyPolicy[] = ['always', 'important', 'digest', 'silent'];

/** A person's limits on interruptions (times on their clock: "22:00"). */
export interface Interruptions {
  /** Quiet hours: nothing interrupts from `quietFrom` to `quietTo` (over midnight when `from` is later). */
  quietFrom?: string;
  quietTo?: string;
  /** Their time zone for the times above (IANA); absent: the server's. */
  timeZone?: string;
  /** Interruptions a day at most; more wait in the inbox. Errors still interrupt (not in quiet hours). */
  maxPerDay?: number;
  /** A digest of what waited, at this time each day ("08:30"). */
  digestAt?: string;
}

/** Why an update did not interrupt. */
export type Held = 'policy' | 'digest' | 'quiet' | 'budget';

const clock = (t: number, tz?: string): { minutes: number; day: string } => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(t)) p[x.type] = x.value;
  return { minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), day: `${p.year}-${p.month}-${p.day}` };
};
const hm = (s?: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? ''); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : undefined; };

/** The person's limits, checked ("25:00" and the like are refused). */
export function checkInterruptions(x: unknown): Interruptions {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const out: Interruptions = {};
  for (const k of ['quietFrom', 'quietTo', 'digestAt'] as const) {
    const v = o[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || hm(v) === undefined) throw new Error(`${k} is a time like 22:00`);
    out[k] = v;
  }
  if (!!out.quietFrom !== !!out.quietTo) throw new Error('quiet hours need both quietFrom and quietTo');
  if (o.timeZone !== undefined && o.timeZone !== null && o.timeZone !== '') {
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(o.timeZone) }); } catch { throw new Error(`"${String(o.timeZone)}" is not a time zone`); }
    out.timeZone = String(o.timeZone);
  }
  if (o.maxPerDay !== undefined && o.maxPerDay !== null && o.maxPerDay !== '') {
    const n = Number(o.maxPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('maxPerDay is a whole number from 0 to 1000');
    out.maxPerDay = n;
  }
  return out;
}

/** Whether `t` falls in the quiet hours. */
export function inQuietHours(p: Interruptions, t: number): boolean {
  const from = hm(p.quietFrom), to = hm(p.quietTo);
  if (from === undefined || to === undefined || from === to) return false;
  const m = clock(t, p.timeZone).minutes;
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** The person's day (on their clock) a moment falls in: "2026-11-01". */
export const dayOf = (t: number, tz?: string) => clock(t, tz).day;

/**
 * Whether a new update interrupts the person, or waits (and why). `policy` is its schedule's (updates
 * not from a schedule: always); `alertsToday` how many updates interrupted them today already.
 */
export function decideAlert(item: Pick<InboxItem, 'kind' | 'level'>, policy: NotifyPolicy, p: Interruptions, alertsToday: number, now = Date.now()): { alert: boolean; held?: Held } {
  const important = item.level !== 'info' || item.kind === 'message' || item.kind === 'suggestion';
  if (policy === 'silent' && !important) return { alert: false, held: 'policy' };
  if (policy === 'important' && !important) return { alert: false, held: 'policy' };
  if (policy === 'digest' && item.level === 'info') return { alert: false, held: 'digest' };
  if (inQuietHours(p, now)) return { alert: false, held: 'quiet' };
  if (p.maxPerDay !== undefined && alertsToday >= p.maxPerDay && item.level !== 'error') return { alert: false, held: 'budget' };
  return { alert: true };
}

/** Whether the digest is due: today's digest time has passed (on their clock) and none was made since. */
export function digestDue(p: Interruptions, lastAt: number | undefined, now = Date.now()): boolean {
  const at = hm(p.digestAt);
  if (at === undefined) return false;
  const c = clock(now, p.timeZone);
  if (c.minutes < at) return false;
  return !lastAt || dayOf(lastAt, p.timeZone) !== c.day || clock(lastAt, p.timeZone).minutes < at;
}

/** The digest's text: what waited, a line each, newest first. */
export function digestBody(items: Array<Pick<InboxItem, 'kind' | 'title' | 'body' | 'level'>>): string {
  const lines = items.slice(0, 15).map((i) => `- ${i.level !== 'info' ? '(!) ' : ''}${i.title}: ${i.body.replace(/\s+/g, ' ').slice(0, 160)}`);
  return `${items.length} update${items.length === 1 ? '' : 's'} waited for you:\n${lines.join('\n')}${items.length > 15 ? `\n- and ${items.length - 15} more in the Inbox` : ''}`;
}
