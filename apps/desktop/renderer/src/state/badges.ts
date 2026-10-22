/**
 * Badge sources (`ui.badges` in a plugin's manifest): the host keeps a plugin's sidebar badges and
 * status items current while none of its pages is open, by reading the plugin's own signed-in route
 * as the person - every `every` seconds (at least 15), paused while the window is hidden, and at
 * once when the plugin's server half signals (a `plugins` event {type: 'signal', plugin}).
 *
 * The plan and the reading of answers are pure (unit-tested); the timers are the thin part below.
 */

import { BADGE_MIN_SECONDS } from '@harness/plugin-ui';
import type { Registry } from '../registry/registry.ts';

export interface BadgePoll { plugin: string; route: string; method: 'GET' | 'POST'; everyMs: number; names: string[]; signal: boolean }

/** One poll per plugin route (several badges share a read), at the shortest interval any of them asks. */
export function badgePlan(r: Registry): BadgePoll[] {
  const out = new Map<string, BadgePoll>();
  for (const p of r.active) {
    if (!p.ui?.capabilities.includes('routes.call')) continue;
    for (const b of p.ui.badges ?? []) {
      const method = b.method ?? 'GET';
      const k = `${p.name}\n${method}\n${b.route}`;
      const everyMs = Math.max(BADGE_MIN_SECONDS, b.every ?? 60) * 1000;
      const cur = out.get(k);
      if (cur) { cur.names.push(b.name); cur.everyMs = Math.min(cur.everyMs, everyMs); cur.signal ||= !!b.signal; }
      else out.set(k, { plugin: p.name, route: b.route, method, everyMs, names: [b.name], signal: !!b.signal });
    }
  }
  return [...out.values()];
}

const value = (v: unknown): number | string | null | undefined => (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? v.slice(0, 20) : undefined);

/** What a route's answer sets: the value itself (one badge), or each badge's value by its name. Anything else sets nothing. */
export function badgeValues(names: string[], answer: unknown): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  const direct = value(answer);
  if (direct !== undefined && names.length === 1) { out[names[0]!] = direct; return out; }
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    for (const n of names) { const v = value((answer as Record<string, unknown>)[n]); if (v !== undefined) out[n] = v; }
  }
  return out;
}

export interface BadgeHost {
  call(plugin: string, route: string, method: 'GET' | 'POST'): Promise<unknown>;
  set(key: string, v: number | string | null): void;
  hidden(): boolean;
  onVisibility(fn: () => void): () => void;
}

/** Runs a plan: reads at once, then on each interval while visible; `signal(plugin)` reads that plugin's sources now. */
export function runBadges(plan: BadgePoll[], host: BadgeHost): { signal(plugin: string): void; stop(): void } {
  const timers = new Map<BadgePoll, ReturnType<typeof setInterval>>();
  const inFlight = new Set<BadgePoll>();
  const read = async (p: BadgePoll) => {
    if (inFlight.has(p) || host.hidden()) return;
    inFlight.add(p);
    try {
      const vals = badgeValues(p.names, await host.call(p.plugin, p.route, p.method));
      for (const [n, v] of Object.entries(vals)) host.set(`${p.plugin}.${n}`, v);
    } catch { /* the plugin's server half is down or refuses: keep the last value */ } finally { inFlight.delete(p); }
  };
  const start = () => { for (const p of plan) { if (!timers.has(p)) timers.set(p, setInterval(() => void read(p), p.everyMs)); void read(p); } };
  const pause = () => { for (const t of timers.values()) clearInterval(t); timers.clear(); };
  const offVis = host.onVisibility(() => { if (host.hidden()) pause(); else start(); });
  if (!host.hidden()) start();
  return {
    signal(plugin) { for (const p of plan) if (p.plugin === plugin && p.signal) void read(p); },
    stop() { pause(); offVis(); },
  };
}
