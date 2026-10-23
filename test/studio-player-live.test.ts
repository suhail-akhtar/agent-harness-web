// Live check of the AI player (spends money; skipped unless HARNESS_LIVE_STUDIO=1): a real model
// plays the 2D platformer fixture with game_play toward its goal (five coins, then the exit), each
// under a hard spend cap. Keys come from the environment (node --env-file=../.env); only their
// names are printed.
//   HARNESS_LIVE_STUDIO=1 node --env-file=<.env> scripts/test.mjs test/studio-player-live.test.ts
//   HARNESS_LIVE_MODELS=claude-sonnet-5-5:1.00,deepseek-flash:0.30,gpt-6-luna:0.30 (the default)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const live = process.env.HARNESS_LIVE_STUDIO === '1';
const models = (process.env.HARNESS_LIVE_MODELS ?? 'claude-sonnet-5-5:1.00,deepseek-flash:0.30,gpt-6-luna:0.30').split(',').map((x) => { const [id, cap] = x.split(':'); return { id: id!, cap: Number(cap) || 0.3 }; });
const KEYS: Record<string, string[]> = { 'claude-sonnet-5-5': ['ANTHROPIC_API_KEY', 'GW_ANTHROPIC_API_KEY'], 'deepseek-flash': ['DEEPSEEK_API_KEY'], 'gpt-6-luna': ['OPENAI_API_KEY'] };
const has = (names: string[]) => names.some((n) => !!process.env[n]?.trim());

const BRIEF = [
  'Load the game-playing skill, then play the game in this folder (index.html, a small 2D platformer) with the game_play tool.',
  'Goal: collect all five coins, then reach the exit door on the right (it opens after the last coin).',
  'Use frameWidth 384 when you start. Play in short steps and use the state (player position, targets) to aim. At most 50 steps.',
  'When you reach the goal (or run out of steps), record a verdict about what you see with game_play verdict (goal: true if reached), then game_play stop.',
  'Finish with: coins collected, goal reached yes/no, steps used, and one sentence on anything odd you saw.',
].join('\n');

for (const m of models) {
  test(`live: ${m.id} plays the platformer toward its goal (cap $${m.cap.toFixed(2)})`, { skip: !live ? 'set HARNESS_LIVE_STUDIO=1 (spends money)' : !has(KEYS[m.id] ?? []) ? `no ${KEYS[m.id]?.join(' or ')} in the environment` : false, timeout: 20 * 60_000 }, async () => {
    console.log(`keys for ${m.id}: ${(KEYS[m.id] ?? []).map((k) => `${k} ${process.env[k]?.trim() ? 'present' : 'absent'}`).join(', ')}`);
    const ws = await tempDir('studio-live-');
    await fs.cp(path.join(here, 'fixtures', 'games', 'platformer'), ws, { recursive: true });
    process.env.HARNESS_MAX_COST_USD = String(m.cap);
    process.env.HARNESS_PLUGIN_LOOPS = 'off';
    const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'games3d')], search: null, memory: 'off', backgroundWork: false, scheduler: false });
    const t0 = Date.now();
    try {
      const s = await h.sessions.create({ title: `studio live ${m.id}`, model: m.id, effort: 'low', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
      let calls = 0;
      let stopped = false;
      const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => {
        if (event.kind === 'tool_call' && (event as { name?: string }).name === 'game_play') calls++;
        // A second guard besides the session's own cap: stop before the next call would pass it.
        if (!stopped && s.meta.cost > m.cap * 0.95) { stopped = true; console.log(`stopping ${m.id}: cost $${s.meta.cost.toFixed(4)} is near the cap`); s.abort(); }
        if (event.kind === 'turn_end' && !event.agent) r();
      }));
      await s.send(BRIEF);
      await Promise.race([done, new Promise((r) => setTimeout(r, 18 * 60_000))]);
      const recDir = path.join(ws, '.studio', 'recordings');
      const recs = (await fs.readdir(recDir).catch(() => [] as string[])).filter((f) => f.startsWith('play-') && f.endsWith('.json'));
      const saved = recs.length ? JSON.parse(await fs.readFile(path.join(recDir, recs[0]!), 'utf8')) : null;
      const pickups = saved?.summary.events.filter((e: { type: string }) => e.type === 'pickup').length ?? null;
      const last = [...s.history].reverse().find((x) => x.role === 'assistant' && x.content.some((b) => b.type === 'text' && (b as { text: string }).text.trim()));
      const answer = (last?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ') ?? '').replace(/\s+/g, ' ').slice(0, 400);
      const result = {
        model: m.id, cap: m.cap, cost: Number(s.meta.cost.toFixed(4)), turns: s.meta.turns, gamePlayCalls: calls, seconds: Math.round((Date.now() - t0) / 1000),
        steps: saved?.summary.steps ?? null, gameSeconds: saved?.summary.durationS ?? null, coins: pickups, goalReached: saved?.summary.goalReached ?? false,
        verdicts: saved?.summary.verdicts?.map((v: { claim: string; pass: boolean }) => `${v.pass ? 'PASS' : 'FAIL'} ${v.claim}`) ?? [], stoppedByCap: stopped, answer,
      };
      console.log(`LIVE RESULT ${JSON.stringify(result)}`);
      await fs.appendFile(path.join(process.env.HARNESS_LIVE_OUT ?? path.join(ws, '..'), 'studio-live-results.jsonl'), `${JSON.stringify(result)}\n`).catch(() => {});
      assert.ok(s.meta.cost <= m.cap * 1.1, `spent $${s.meta.cost} over the cap $${m.cap}`);
      assert.ok(calls > 0, 'the model used game_play');
    } finally { await h.close(); }
  });
}
