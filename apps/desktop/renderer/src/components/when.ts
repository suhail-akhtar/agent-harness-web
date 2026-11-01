/**
 * When a schedule runs, as the person picks it (once, every few minutes, hourly, daily, weekdays,
 * weekly on some days, monthly, or a cron of their own), and the cron or one-time it becomes. Pure:
 * the schedule dialog's picker and tests use it.
 */

export type Freq = 'once' | 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export interface When {
  freq: Freq;
  /** minutes: every this many minutes. */
  every: number;
  /** hourly: at this minute. */
  minute: number;
  /** daily, weekdays, weekly, monthly: at this time ("09:00"). */
  time: string;
  /** weekly: on these days (0 Sunday .. 6 Saturday). */
  days: number[];
  /** monthly: on this day of the month. */
  dom: number;
  /** custom: a cron of the person's own. */
  cron: string;
  /** once: in so many minutes, hours or days from now, or at a date and time ("2026-11-02T09:00"). */
  onceMode: 'in' | 'at';
  inAmount: number;
  inUnit: 'minutes' | 'hours' | 'days';
  at: string;
}

export const DEFAULT_WHEN: When = { freq: 'weekdays', every: 15, minute: 0, time: '09:00', days: [1], dom: 1, cron: '', onceMode: 'in', inAmount: 30, inUnit: 'minutes', at: '' };

export const EVERY_MINUTES = [5, 10, 15, 20, 30];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const hm = (time: string): [number, number] | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return undefined;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? [h, mi] : undefined;
};

/** The cron a repeating choice makes (undefined: once, or not complete yet). */
export function toCron(w: When): string | undefined {
  const t = hm(w.time);
  switch (w.freq) {
    case 'minutes': return EVERY_MINUTES.includes(w.every) || (w.every >= 5 && w.every <= 59) ? `*/${w.every} * * * *` : undefined;
    case 'hourly': return w.minute >= 0 && w.minute <= 59 ? `${w.minute} * * * *` : undefined;
    case 'daily': return t ? `${t[1]} ${t[0]} * * *` : undefined;
    case 'weekdays': return t ? `${t[1]} ${t[0]} * * 1-5` : undefined;
    case 'weekly': return t && w.days.length ? `${t[1]} ${t[0]} * * ${[...new Set(w.days)].sort((a, b) => a - b).join(',')}` : undefined;
    case 'monthly': return t && w.dom >= 1 && w.dom <= 31 ? `${t[1]} ${t[0]} ${w.dom} * *` : undefined;
    case 'custom': return w.cron.trim() || undefined;
    default: return undefined;
  }
}

/** What a one-time choice sends: minutes from now, or a time (undefined: not once, or not complete). */
export function toOnce(w: When): { inMinutes: number } | { at: string } | undefined {
  if (w.freq !== 'once') return undefined;
  if (w.onceMode === 'at') {
    const t = Date.parse(w.at);
    return Number.isNaN(t) ? undefined : { at: new Date(t).toISOString() };
  }
  const n = Number(w.inAmount);
  if (!(n > 0)) return undefined;
  return { inMinutes: Math.round(n * (w.inUnit === 'days' ? 1440 : w.inUnit === 'hours' ? 60 : 1)) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A schedule's timing as the picker shows it: the simple shapes it makes, else its cron as custom. */
export function fromTiming(t: { cron?: string; at?: number | null }): When {
  if (!t.cron) {
    if (!t.at) return { ...DEFAULT_WHEN, freq: 'once' };
    const d = new Date(t.at);
    return { ...DEFAULT_WHEN, freq: 'once', onceMode: 'at', at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  const c = t.cron.trim();
  let m = /^\*\/(\d+) \* \* \* \*$/.exec(c);
  if (m) return { ...DEFAULT_WHEN, freq: 'minutes', every: Number(m[1]) };
  m = /^(\d+) \* \* \* \*$/.exec(c);
  if (m) return { ...DEFAULT_WHEN, freq: 'hourly', minute: Number(m[1]) };
  m = /^(\d+) (\d+) (\*|\d+) \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(c);
  if (m && Number(m[1]) <= 59 && Number(m[2]) <= 23) {
    const time = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
    if (m[3] === '*' && m[4] === '*') return { ...DEFAULT_WHEN, freq: 'daily', time };
    if (m[3] === '*' && m[4] === '1-5') return { ...DEFAULT_WHEN, freq: 'weekdays', time };
    if (m[3] === '*') return { ...DEFAULT_WHEN, freq: 'weekly', time, days: m[4]!.split(',').map(Number) };
    if (m[4] === '*') return { ...DEFAULT_WHEN, freq: 'monthly', time, dom: Number(m[3]) };
  }
  return { ...DEFAULT_WHEN, freq: 'custom', cron: c };
}
