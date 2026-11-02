import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, setupServer, waitFor } from './multi-helpers.ts';
// @ts-expect-error a plugin's own JavaScript
import { aggregate, brier, calibration, logLoss, refitExtremize, scores } from '../plugins/forecasting/lib/aggregate.mjs';

// The forecasting ledger (docs/swarm/SWARM.md, phase 5): forecasters on several models, aggregated in code, live
// questions only, kept until resolved, scored; the extremizing factor refitted from resolved questions.

const here = path.dirname(fileURLToPath(import.meta.url));

test('the aggregate in code: a trimmed mean in log-odds, extremized, capped; one wild forecaster trimmed away', () => {
  assert.equal(aggregate([]), undefined);
  assert.ok(Math.abs(aggregate([0.5, 0.5, 0.5]) - 0.5) < 1e-9, 'agreement on a coin stays a coin');
  // Three at 0.7: log-odds 0.847, times sqrt(3) = 1.467: 0.8126.
  assert.ok(Math.abs(aggregate([0.7, 0.7, 0.7]) - 0.8126) < 1e-3);
  assert.ok(Math.abs(aggregate([0.7, 0.7, 0.7], { extremize: 1 }) - 0.7) < 1e-9);
  // Six forecasters: the highest and the lowest are dropped (trim 0.2, while 4 remain), so a 0.99 outlier does not drag
  // the rest; with fewer, nothing is trimmed.
  const six = aggregate([0.3, 0.32, 0.35, 0.33, 0.34, 0.99], { extremize: 1 });
  const mean4 = (Math.log(0.32 / 0.68) + Math.log(0.33 / 0.67) + Math.log(0.34 / 0.66) + Math.log(0.35 / 0.65)) / 4;
  assert.ok(Math.abs(six - 1 / (1 + Math.exp(-mean4))) < 1e-9, String(six));
  assert.ok(aggregate([0.3, 0.32, 0.99], { extremize: 1 }) > 0.5, 'three: none trimmed');
  assert.equal(aggregate([0.999, 0.999, 0.999]), 0.98, 'capped');
  assert.equal(aggregate([0, 0.001]), 0.02);
});

test('scores, calibration and the extremizing factor refitted from resolved questions (and not from fewer than 20)', () => {
  assert.ok(Math.abs(brier(0.8, 1) - 0.04) < 1e-12);
  assert.ok(Math.abs(logLoss(0.5, 0) - Math.log(2)) < 1e-9);
  // Synthetic resolved questions: forecasters who are right but timid (0.65 when it happens, 0.35 when not).
  const qs = Array.from({ length: 30 }, (_, i) => {
    const o = i % 3 === 0 ? 0 : 1;
    const ps = o ? [0.62, 0.66, 0.68] : [0.32, 0.35, 0.38];
    return { id: `Q${i}`, resolution: o, forecasts: [{ model: 'a', p: ps[0] }, { model: 'b', p: ps[1] }, { model: 'c', p: ps[2] }], aggregate: aggregate(ps), market: o ? 0.6 : 0.4 };
  });
  const s = scores(qs);
  assert.equal(s[0].who, 'aggregate', `extremizing timid but right forecasters helps (${JSON.stringify(s)})`);
  assert.ok(s.find((x: { who: string }) => x.who === 'market').brier > s[0].brier);
  const fit = refitExtremize(qs);
  assert.ok(fit && fit.a > Math.sqrt(3), `timid forecasters want more extremizing (${JSON.stringify(fit)})`);
  assert.equal(refitExtremize(qs.slice(0, 19)), undefined, 'fewer than 20 resolved say nothing');
  const cal = calibration(qs);
  assert.deepEqual(cal.filter((r: { n: number }) => r.n).map((r: { n: number; rate: number }) => [r.n, r.rate]), [[10, 0], [20, 1]]);
  assert.deepEqual(scores([{ id: 'open', forecasts: [{ model: 'a', p: 0.4 }], aggregate: 0.4 }]), [], 'open questions are not scored');
});

test('in a conversation: forecasters on two models, each from its own brief, the aggregate computed here; live questions only; resolved and scored', async () => {
  const t = await setupServer({ plugins: [path.join(here, '..', 'plugins', 'forecasting')] });
  try {
    assert.equal((await t.call(OPERATOR, 'PUT', '/api/me/settings', { delegation: { allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'] } })).status, 200);
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: await tempDir('hw-fc-'), mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const ev: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => ev.push(event));
    const ends = () => ev.filter((e) => e.kind === 'turn_end' && (!('agent' in e) || !e.agent)).length;
    const turn = async (text: string) => { const n = ends(); await s.send(text); await waitFor(() => ends() > n, 'the turn', 60_000); };
    const result = (name: string) => ev.filter((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === name).at(-1)!;
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const q = { question: 'Will the city council approve the new bike lanes by the end of next month?', resolve_by: later, criteria: 'The council\'s published minutes record a vote approving them.', models: ['claude-sonnet-5-5', 'claude-haiku-5-5'] };

    // A question already decided is refused: live questions only.
    t.ds.scripts.lead = [{ calls: [{ name: 'forecast', input: { ...q, resolve_by: '2020-01-01' } }] }, { text: 'No.' }];
    await turn('[[lead]] Forecast it.');
    assert.match(result('forecast').content, /live questions only/);

    // Each forecaster answers on its own model (both Claude here): 0.6 and 0.7, aggregated in code.
    t.an.scripts.main = [
      (req) => ({ text: `Base rate about 50%.\n{"probability": ${req.model.id === 'claude-haiku-5-5' ? 0.7 : 0.6}, "base_rate": 0.5, "rationale": "council agendas"}` }),
      (req) => ({ text: `Base rate about 50%.\n{"probability": ${req.model.id === 'claude-haiku-5-5' ? 0.7 : 0.6}, "base_rate": 0.5, "rationale": "council agendas"}` }),
    ];
    t.ds.scripts.lead = [{ calls: [{ name: 'forecast', input: q }] }, { text: 'Forecast.' }];
    await turn('[[lead]] Forecast it.');
    const f = result('forecast');
    const want = 1 / (1 + Math.exp(-Math.sqrt(3) * ((Math.log(0.6 / 0.4) + Math.log(0.7 / 0.3)) / 2)));
    assert.equal(f.is_error, false, f.content);
    assert.match(f.content, new RegExp(`^Q1: aggregate ${want.toFixed(2)} from 2 of 2 forecasters[\\s\\S]*- claude-sonnet-5-5: 0\\.60\\n- claude-haiku-5-5: 0\\.70`));
    assert.equal(t.an.requests.length, 2);
    assert.ok(t.an.requests.every((r) => JSON.stringify(r.messages).includes('outside view')), 'each forecaster gets the brief, not the conversation');
    assert.ok(t.an.requests.every((r) => !JSON.stringify(r.messages).includes('[[lead]]')));

    // Resolved with its source, then scored.
    t.ds.scripts.lead = [{ calls: [{ name: 'resolve_forecast', input: { id: 'Q1', outcome: 'yes', source: 'https://council.example/minutes' } }, { name: 'forecast_scores', input: {} }] }, { text: 'Scored.' }];
    await turn('[[lead]] It passed.');
    assert.match(result('resolve_forecast').content, /^Q1 resolved yes; the aggregate had said/);
    assert.match(result('forecast_scores').content, /Questions: 1; open 0; resolved 1\.[\s\S]*- aggregate: Brier [\d.]+[\s\S]*- claude-haiku-5-5: Brier 0\.09[\s\S]*- claude-sonnet-5-5: Brier 0\.16/);
  } finally { await t.close(); }
});
