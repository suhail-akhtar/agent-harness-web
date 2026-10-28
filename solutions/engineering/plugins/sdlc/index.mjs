// The server half of the SDLC plugin's desktop pages: it follows the sessions' events (the runs
// of this plugin's workflows, the quality gates, the tests the agents ran) into a small index in
// the plugin's data folder, and serves it to the person's own pages through routes that need a
// signed-in caller (auth "user"): each person sees their own features, an administrator all.
//
//   GET deliveries              the board: every feature with its stage, gates, tests and cost
//   delivery {id: run_...}      one feature: its steps, every gate result, the review verdicts
//   gates {session: <id>}       a conversation's gate results, and whether gates are running now
// (the last two: GET with a query, or POST with a JSON body - what a frame's routes.call sends)
//
// No model runs here and nothing is inferred: the index is what the harness reported.

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeFileAtomic } from '@harness/plugin-sdk/runtime';
import { applyEvent, card, emptyState, STAGES, STAGE_TITLES, visible } from './lib/delivery.mjs';

let flushIndex;
const ok = (body) => ({ status: 200, body });
const no = (status, error) => ({ status, body: { error } });
const argsOf = (req) => {
  if (req.method === 'GET') return req.query ?? {};
  try { const b = JSON.parse(req.body.toString('utf8') || '{}'); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { return {}; }
};

export default {
  name: 'sdlc',
  async setup(api) {
    const file = path.join(api.dataDir, 'deliveries.json');
    const workflows = (await fs.readdir(path.join(api.pluginDir, 'workflows')).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    let state = await readJson(file, emptyState());
    if (!state || typeof state !== 'object' || !state.deliveries) state = emptyState();
    const pending = new Map();
    let dirty = false;
    let timer;
    const flush = async () => {
      timer = undefined;
      if (!dirty) return;
      dirty = false;
      await fs.mkdir(api.dataDir, { recursive: true });
      await writeFileAtomic(file, JSON.stringify(state)).catch((e) => api.log(`sdlc: the delivery index could not be saved: ${e.message}`));
    };
    const later = () => { dirty = true; timer ??= setTimeout(() => { void flush(); }, 400); timer.unref?.(); };

    api.events.subscribe((e) => {
      try { if (applyEvent(state, e, { workflows, pending })) later(); } catch (err) { api.log(`sdlc: an event could not be indexed: ${err.message}`); }
    });

    api.registerRoute({
      method: 'GET', path: 'deliveries', auth: 'user',
      async handler(req) {
        const list = Object.values(state.deliveries).filter((d) => visible(d, req.user)).sort((a, b) => b.updatedAt - a.updatedAt).map(card);
        return ok({ stages: STAGES.map((id) => ({ id, title: STAGE_TITLES[id] })), deliveries: list, workflows });
      },
    });
    // A read with arguments: GET with a query, or POST with a JSON body (a frame's routes.call sends the body).
    const read = (p, handler) => {
      for (const method of ['GET', 'POST']) api.registerRoute({ method, path: p, auth: 'user', handler: (req) => handler(req, argsOf(req)) });
    };
    read('delivery', async (req, a) => {
      const d = state.deliveries[String(a.id ?? '')];
      if (!d || !visible(d, req.user)) return no(404, 'no such feature');
      return ok({ ...card(d), nodes: d.nodes ?? [], gateResults: Object.values(d.gates ?? {}).sort((x, y) => x.name.localeCompare(y.name)), error: d.error, sessionTitle: d.sessionTitle });
    });
    read('gates', async (req, a) => {
      const id = String(a.session ?? '');
      if (!/^[a-f0-9]{16}$/.test(id)) return no(400, 'session is a conversation id');
      const s = state.sessions[id];
      // A conversation the index has not seen: no gate ran there yet (and whose it is is not said).
      if (!s) return ok({ session: id, gates: [], running: null, tests: null, deliveries: [] });
      const owner = s.owner ?? state.deliveries[s.runs[0]]?.owner;
      if (!visible({ owner }, req.user)) return no(404, 'no such conversation');
      const order = ['fail', 'warn', 'pass'];
      return ok({
        session: id, running: s.running, updatedAt: s.updatedAt, tests: s.tests ?? null,
        gates: Object.values(s.gates).sort((x, y) => (x.status === y.status ? x.name.localeCompare(y.name) : order.indexOf(x.status) - order.indexOf(y.status))),
        deliveries: s.runs.map((r) => state.deliveries[r]).filter(Boolean).map(card),
      });
    });
    api.log(`sdlc: delivery index of ${Object.keys(state.deliveries).length} feature(s); workflows ${workflows.join(', ')}`);
    flushIndex = flush;
  },
  async close() { await flushIndex?.(); },
};
