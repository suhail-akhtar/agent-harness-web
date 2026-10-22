import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionManager } from '../core/manager.ts';
import type { Session } from '../core/session.ts';
import type { HarnessEvent } from '../core/types.ts';
import { fenceOutside } from '../core/untrusted.ts';
import type { Registry } from '../kernel/registry.ts';
import { ChangeJournal, type ChangeService } from '../ops/changes.ts';
import type { Leases } from '../util/lease.ts';
import { readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import { Redactor } from '../vault/redact.ts';
import type { VaultEntryInfo, VaultStore } from '../vault/store.ts';
import type { PluginRoute, PluginSessions, PluginSessionStart } from './api.ts';

// What trusted plugin code reaches of the running harness, beyond tools: HTTP routes,
// every session's events, starting and answering sessions, the change journal, leases
// and its declared vault entries. The loader hands each plugin a view of this bridge
// limited to what its manifest declared ("permissions": {"sessions": true, "routes": true}).
//
// Sessions a plugin may send to or answer for: the operator's own (no owner), the ones
// a plugin started (an alert investigation, a chat request), and those of the accounts
// the operator lists for it in HARNESS_PLUGIN_SESSION_OWNERS ({"plugin": ["usr_...", "*"]}).
// Every start, message and answer is appended to <data>/plugin-actions.jsonl with the plugin
// and, for answers, who answered (`by`); the session shows the answer as a notice too.
//
// The vault from server code (api.vault): operator-scope entries only, those the manifest's
// permissions.vault covers and an administrator granted the plugin ("plugin:<name>" on the
// entry's allow list). Every value a plugin read this way is hidden as [vault:name] in
// whatever it passes on to a session (start, send, an answer's feedback).

export const ROUTE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}$/;
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Per-route secrets, kept as hashes in <data>/plugin-routes.json (several servers may share it). */
export class RouteTokens {
  readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'plugin-routes.json'); }

  private async read(): Promise<Record<string, { hash: string; createdAt: number }>> {
    return (await readJson<{ routes?: Record<string, { hash: string; createdAt: number }> }>(this.file, {})).routes ?? {};
  }

  /** Whether a token was ever issued for the route. */
  async issued(key: string): Promise<{ createdAt: number } | undefined> {
    const r = (await this.read())[key];
    return r ? { createdAt: r.createdAt } : undefined;
  }

  /** A new token for the route (replacing any earlier one), returned once; only its hash is kept. */
  async issue(key: string): Promise<string> {
    const token = `hwr_${crypto.randomBytes(24).toString('base64url')}`;
    await withFileLock(this.file, async () => {
      const routes = await this.read();
      routes[key] = { hash: hash(token), createdAt: Date.now() };
      await writeFileAtomic(this.file, JSON.stringify({ routes }, null, 2), { mode: 0o600 });
    });
    return token;
  }

  /** The token is the route's (constant time). */
  async verify(key: string, token: string): Promise<boolean> {
    const r = (await this.read())[key];
    if (!r || !token) return false;
    const a = Buffer.from(hash(token), 'hex');
    const b = Buffer.from(r.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

export interface PluginBridge {
  changes: ChangeService;
  routeTokens: RouteTokens;
  sessionsFor(plugin: string): PluginSessions;
  dispatch(s: Session, event: HarnessEvent): void;
  lease(plugin: string, name: string): Promise<boolean>;
  hasVault(): boolean;
  vaultReveal(plugin: string, grants: string[], name: string, purpose: string): Promise<string>;
  vaultList(plugin: string, grants: string[]): Promise<(VaultEntryInfo & { granted: boolean })[]>;
  /** Set by the HTTP server: refuses (with why) a new running session for an owner over the per-account limits. */
  mayRun?: (owner: string | undefined) => string | undefined;
  /** The route a request names (plugin, path, method). */
  route(plugin: string, p: string): (PluginRoute & { plugin: string })[];
}

export function createBridge(o: { registry: Registry; dataDir: string; sessions: () => SessionManager | undefined; leases?: Leases; vault?: VaultStore; log: (m: string) => void; /** Plugins' server-side loops run here (lease() is false when not). */ loops?: boolean }): PluginBridge {
  const changes = new ChangeJournal(o.dataDir);
  const routeTokens = new RouteTokens(o.dataDir);
  const actions = path.join(o.dataDir, 'plugin-actions.jsonl');
  const audit = (entry: Record<string, unknown>) => withFileLock(actions, async () => {
    await fs.appendFile(actions, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }).catch((e: Error) => o.log(`plugin actions log: ${e.message}`));

  const need = (): SessionManager => {
    const m = o.sessions();
    if (!m) throw new Error('sessions are not ready yet (the harness is starting)');
    return m;
  };
  const operatorOwners = (plugin: string): string[] => {
    const raw = process.env.HARNESS_PLUGIN_SESSION_OWNERS?.trim();
    if (!raw) return [];
    try { const v = (JSON.parse(raw) as Record<string, unknown>)[plugin]; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  /** Why the plugin may not drive this session, or undefined when it may. */
  const outOfReach = (plugin: string, s: Session): string | undefined => {
    if (s.meta.owner === undefined || s.meta.startedBy) return undefined;
    const owners = operatorOwners(plugin);
    if (owners.includes('*') || owners.includes(s.meta.owner)) return undefined;
    return `session ${s.meta.id} belongs to an account the operator has not given ${plugin} (HARNESS_PLUGIN_SESSION_OWNERS)`;
  };
  const source = (plugin: string) => `the ${plugin} plugin`;
  /** Values each plugin read from the vault: never passed on to a session. */
  const redactors = new Map<string, Redactor>();
  const redactorOf = (plugin: string) => { let r = redactors.get(plugin); if (!r) { r = new Redactor(); redactors.set(plugin, r); } return r; };
  const clean = (plugin: string, t: string) => redactorOf(plugin).redact(t);

  function sessionsFor(plugin: string): PluginSessions {
    return {
      async start(st: PluginSessionStart) {
        const mgr = need();
        await mgr.sync(true);
        const title = clean(plugin, String(st.title ?? '')).replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!title) throw new Error('sessions.start needs a title');
        if (st.workflow && st.prompt) throw new Error('sessions.start takes a prompt or a workflow, not both');
        const model = st.model ?? o.registry.listModels().find((m) => m.available)?.id;
        if (!model) throw new Error('no model is available on this server');
        const runtime = st.runtime ?? { kind: 'local' as const, network: 'none' as const };
        if (runtime.kind === 'companion') throw new Error('a plugin cannot start a session on someone\'s computer (companion)');
        const why = bridge.mayRun?.(st.owner);
        if (why) throw new Error(why);
        const s = await mgr.create({ title, model, mode: st.mode ?? 'dontAsk', runtime, owner: st.owner });
        s.meta.startedBy = plugin;
        await s.saveMeta();
        if (st.untrusted) s.markUntrusted();
        await audit({ plugin, action: 'start', session: s.meta.id, owner: st.owner, title, ...(st.workflow ? { workflow: st.workflow.name } : {}), untrusted: !!st.untrusted });
        if (st.workflow) {
          const input = Object.fromEntries(Object.entries(st.workflow.input ?? {}).map(([k, v0]) => { const v = clean(plugin, String(v0 ?? '')); return [k, st.untrusted && v.trim() ? fenceOutside(v, source(plugin)) : v]; }));
          await s.startWorkflow(st.workflow.name, input);
        } else if (st.prompt?.trim()) {
          const prompt = clean(plugin, st.prompt);
          await s.send(st.untrusted ? `${clean(plugin, st.instructions?.trim() ?? '') || `This request arrived through ${source(plugin)}. Handle it as the user's request, within your rules.`}\n\n${fenceOutside(prompt, source(plugin))}` : prompt);
        }
        return { id: s.meta.id };
      },
      async send(id, text, so) {
        const mgr = need();
        await mgr.sync();
        const s = mgr.get(id);
        if (!s) throw new Error(`no session ${id}`);
        const refused = outOfReach(plugin, s);
        if (refused) throw new Error(refused);
        if (!String(text ?? '').trim()) throw new Error('empty message');
        text = clean(plugin, String(text));
        if (so?.untrusted) s.markUntrusted();
        await s.send(so?.untrusted ? `A note from ${source(plugin)} (outside data):\n${fenceOutside(text, source(plugin))}` : text);
        await audit({ plugin, action: 'send', session: id, untrusted: !!so?.untrusted, chars: text.length });
      },
      async respond(id, requestId, d) {
        const mgr = need();
        const s = mgr.get(id);
        if (!s) return false;
        const by = String(d?.by ?? '').trim().slice(0, 200);
        if (!by) throw new Error('respond needs by: who answered');
        const refused = outOfReach(plugin, s);
        if (refused) { await audit({ plugin, action: 'respond', session: id, requestId, decision: d.decision, by, result: 'refused', reason: refused }); throw new Error(refused); }
        const ev = s.pendingRequests().find((e) => (e as { requestId?: string }).requestId === requestId);
        if (!ev) return false;
        const allowed: Record<string, string[]> = { permission_request: ['allow', 'deny'], approval_request: ['approve', 'reject'], plan_proposed: ['approve', 'reject'], question: ['answer', 'deny'] };
        if (!(allowed[ev.kind] ?? []).includes(d.decision)) throw new Error(`a ${ev.kind} is answered with ${(allowed[ev.kind] ?? []).join(' or ')}, not "${d.decision}"`);
        if (ev.kind === 'permission_request' && d.decision === 'allow') {
          const denied = s.deniedByRules(requestId);
          if (denied) {
            await audit({ plugin, action: 'respond', session: id, requestId, kind: ev.kind, tool: ev.tool, decision: d.decision, by, result: 'refused', reason: denied });
            throw new Error(`not allowed: ${denied}`);
          }
        }
        const ok = s.respond(requestId, { decision: d.decision, ...(d.feedback ? { feedback: clean(plugin, String(d.feedback)).slice(0, 4000) } : {}), ...(d.answer !== undefined ? { answer: clean(plugin, String(d.answer)).slice(0, 4000) } : {}) });
        if (ok) s.emit({ kind: 'notice', level: 'info', text: `${ev.kind === 'question' ? 'Answered' : d.decision === 'allow' || d.decision === 'approve' ? 'Approved' : 'Refused'} by ${by} through ${source(plugin)}.` });
        await audit({ plugin, action: 'respond', session: id, requestId, kind: ev.kind, ...(ev.kind === 'permission_request' ? { tool: ev.tool } : {}), decision: d.decision, by, result: ok ? 'ok' : 'gone' });
        return ok;
      },
      get(id) {
        const m = o.sessions();
        const s = m?.get(id);
        return s ? { id: s.meta.id, title: s.meta.title, ...(s.meta.owner ? { owner: s.meta.owner } : {}), status: m!.statusOf(id) } : undefined;
      },
    };
  }

  const bridge: PluginBridge = {
    changes,
    routeTokens,
    sessionsFor,
    dispatch(s, event) {
      if (event.kind === 'text_delta' || event.kind === 'reasoning_delta' || !o.registry.eventHandlers.length) return;
      const e = { sessionId: s.meta.id, ...(s.meta.owner ? { owner: s.meta.owner } : {}), title: s.meta.title, event };
      for (const h of o.registry.eventHandlers) {
        try {
          const r = h.handler(e);
          if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((err: Error) => o.log(`[${h.plugin}] event handler failed: ${err?.message ?? err}`));
        } catch (err) { o.log(`[${h.plugin}] event handler failed: ${(err as Error)?.message ?? err}`); }
      }
    },
    async lease(plugin, name) {
      if (o.loops === false) return false;
      if (!o.leases) return true;
      return (await o.leases.acquire(`plugin-${plugin}-${name}`.replace(/[^\w.-]/g, '_'))).ok;
    },
    hasVault: () => !!o.vault,
    async vaultReveal(plugin: string, grants: string[], name: string, purpose: string) {
      if (!o.vault) throw new Error('the key vault is turned off on this server');
      const v = await o.vault.pluginReveal(plugin, grants, name, purpose);
      redactorOf(plugin).add(name, v);
      return v;
    },
    async vaultList(plugin: string, grants: string[]) {
      if (!o.vault) throw new Error('the key vault is turned off on this server');
      return o.vault.pluginList(plugin, grants);
    },
    route(plugin, p) {
      return o.registry.routes.filter((r) => r.plugin === plugin && r.path === p);
    },
  };
  return bridge;
}
