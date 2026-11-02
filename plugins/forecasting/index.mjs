// A forecasting ledger (docs/swarm/SWARM.md, phase 5): live questions only, each forecast by several forecasters on
// different models (an outside view first, then the evidence), aggregated in code, kept with its resolution criteria
// until it is resolved, and scored. No claim of skill without resolved questions to show it.

import { aggregate, calibration, refitExtremize, scores } from './lib/aggregate.mjs';

const DEFAULT_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'grok-4.7'];

async function load(api) {
  const fs = await import('node:fs/promises');
  try { return JSON.parse(await fs.readFile(`${api.dataDir}/forecasts.json`, 'utf8')); } catch { return { questions: [] }; }
}
async function save(api, ledger) {
  const fs = await import('node:fs/promises');
  await fs.mkdir(api.dataDir, { recursive: true });
  await fs.writeFile(`${api.dataDir}/forecasts.json`, JSON.stringify(ledger, null, 2));
}
/** A forecaster's probability from its report's last JSON line: {"probability": 0.37, ...}. */
// The last JSON object with a probability anywhere in the reply, on one line or several (seen live: Grok 4.7 put it
// across lines, before a closing remark).
function probabilityOf(report) {
  const blocks = [...String(report).matchAll(/\{[^{}]*"probability"[^{}]*\}/g)].map((m) => m[0]).reverse();
  for (const b of blocks) {
    try { const p = Number(JSON.parse(b).probability); if (p >= 0 && p <= 1) return p; if (p > 1 && p <= 100) return p / 100; } catch { /* the next */ }
  }
  return undefined;
}

export default {
  name: 'forecasting',
  setup(api) {
    api.registerTool({
      name: 'forecast',
      description: 'Forecast a live yes/no question: several forecasters on different models (each from the outside view first, then the evidence) give a probability, the harness aggregates them in code (a trimmed mean in log-odds, extremized, capped) and keeps the question with its resolution criteria in the forecasting ledger until it is resolved. Only questions not yet decided.',
      parameters: { type: 'object', properties: {
        question: { type: 'string', description: 'A yes/no question about the future, precise enough to resolve' },
        resolve_by: { type: 'string', description: 'The date it resolves (YYYY-MM-DD)' },
        criteria: { type: 'string', description: 'Exactly what counts as yes, and the source that will tell' },
        models: { type: 'array', items: { type: 'string' }, description: `The forecasters' models (each one the person allows; default ${DEFAULT_MODELS.join(', ')})` },
        market: { type: 'number', description: 'A prediction market\'s or a reference forecast\'s probability, if known (for comparison)' },
      }, required: ['question', 'resolve_by', 'criteria'] },
      kind: 'network', parallelSafe: false,
      summarize: (i) => `forecast: ${String(i.question ?? '').slice(0, 100)}`,
      async run(input, ctx) {
        if (!ctx.services?.crossAgent) return { content: 'Forecasters cannot run in this session.', is_error: true };
        const by = String(input.resolve_by ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(by) || by <= new Date().toISOString().slice(0, 10)) return { content: 'resolve_by must be a date after today (YYYY-MM-DD): live questions only.', is_error: true };
        const models = (Array.isArray(input.models) && input.models.length ? input.models : DEFAULT_MODELS).map(String).slice(0, 8);
        const brief = [
          'Forecast this question. It has not been decided yet.', '', '<question>', String(input.question), '</question>', '',
          `Resolves on ${by}. Counts as yes when: ${String(input.criteria)}`, '',
          `Today is ${new Date().toISOString().slice(0, 10)}. First the outside view: the base rate for questions of this kind (how often have similar things happened?). Then the inside view: search for the latest evidence, and move from the base rate only as far as it justifies. Say what would change your mind.`,
          'End with exactly one line of JSON and nothing after it: {"probability": <0 to 1>, "base_rate": <0 to 1>, "rationale": "<one sentence>"}',
        ].join('\n');
        const forecasts = await Promise.all(models.map(async (model) => {
          try {
            let r = await ctx.services.crossAgent({ type: 'forecaster', prompt: brief, description: 'forecast', model }, ctx.signal);
            let p = probabilityOf(r.report);
            let cost = r.cost;
            // No probability the harness can read: asked once more, briefly, with its own reasoning to go on.
            if (p === undefined) {
              r = await ctx.services.crossAgent({ type: 'forecaster', prompt: `${brief}\n\nYour earlier answer, which ended without the JSON line:\n<earlier>\n${r.report.slice(-4000)}\n</earlier>\nGive the JSON line now: it is the only part of your reply that is read.`, description: 'forecast (the probability line)', model }, ctx.signal);
              p = probabilityOf(r.report); cost += r.cost;
            }
            const json = [...r.report.matchAll(/\{[^{}]*"probability"[^{}]*\}/g)].at(-1)?.[0];
            return { model: r.model, p, at: new Date().toISOString(), cost, rationale: (json ?? r.report.trim().split('\n').at(-1) ?? '').replace(/\s+/g, ' ').slice(0, 400) };
          } catch (e) { return { model, error: e.message.slice(0, 200), at: new Date().toISOString() }; }
        }));
        const ps = forecasts.map((f) => f.p).filter((p) => typeof p === 'number');
        const ledger = await load(api);
        const fit = refitExtremize(ledger.questions);
        const agg = aggregate(ps, fit ? { extremize: fit.a } : {});
        const id = `Q${ledger.questions.length + 1}`;
        ledger.questions.push({ id, question: String(input.question), resolveBy: by, criteria: String(input.criteria), createdAt: new Date().toISOString(), forecasts, aggregate: agg, extremize: fit?.a ?? +Math.sqrt(3).toFixed(3), ...(typeof input.market === 'number' ? { market: input.market } : {}) });
        await save(api, ledger);
        const lines = forecasts.map((f) => `- ${f.model}: ${typeof f.p === 'number' ? f.p.toFixed(2) : `no forecast (${f.error ?? 'no probability line'})`}`);
        return { content: `${id}: ${typeof agg === 'number' ? `aggregate ${agg.toFixed(2)}` : 'no aggregate (no forecaster gave a probability)'} from ${ps.length} of ${forecasts.length} forecasters (trimmed mean in log-odds, extremized by ${fit?.a ?? '1.73'}${fit ? ', refitted on resolved questions' : ''}, capped to 2-98%).${typeof input.market === 'number' ? ` Market: ${input.market}.` : ''}\n${lines.join('\n')}\nKept in the ledger until ${by}; resolve it then with resolve_forecast.`, is_error: typeof agg !== 'number' };
      },
    });

    api.registerTool({
      name: 'resolve_forecast',
      description: 'Resolve a question in the forecasting ledger, yes or no, with the source that settled it.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, outcome: { type: 'string', enum: ['yes', 'no'] }, source: { type: 'string', description: 'Where the outcome is stated (a URL or a document)' } }, required: ['id', 'outcome', 'source'] },
      kind: 'edit', parallelSafe: false,
      summarize: (i) => `resolve ${i.id}: ${i.outcome}`,
      async run(input) {
        const ledger = await load(api);
        const q = ledger.questions.find((x) => x.id === input.id);
        if (!q) return { content: `No question ${input.id} in the ledger.`, is_error: true };
        if (q.resolution === 0 || q.resolution === 1) return { content: `${q.id} was resolved already (${q.resolution ? 'yes' : 'no'}).`, is_error: true };
        if (new Date().toISOString().slice(0, 10) < q.resolveBy.slice(0, 10) && input.outcome === 'no') return { content: `${q.id} resolves on ${q.resolveBy}: a "no" is only known then.`, is_error: true };
        q.resolution = input.outcome === 'yes' ? 1 : 0; q.resolvedAt = new Date().toISOString(); q.source = String(input.source ?? '');
        await save(api, ledger);
        return `${q.id} resolved ${input.outcome}; the aggregate had said ${typeof q.aggregate === 'number' ? q.aggregate.toFixed(2) : '-'}.`;
      },
    });

    api.registerTool({
      name: 'forecast_scores',
      description: 'The forecasting ledger: open questions, and on resolved ones the Brier and log scores of each forecaster, the aggregate and any market, a calibration table, and the extremizing factor refitted from them.',
      parameters: { type: 'object', properties: {} },
      kind: 'read', parallelSafe: true,
      summarize: () => 'forecast scores',
      async run() {
        const ledger = await load(api);
        const open = ledger.questions.filter((q) => !(q.resolution === 0 || q.resolution === 1));
        const resolved = ledger.questions.length - open.length;
        const s = scores(ledger.questions);
        const fit = refitExtremize(ledger.questions);
        return [
          `Questions: ${ledger.questions.length}; open ${open.length}; resolved ${resolved}.`,
          ...open.map((q) => `- ${q.id} (resolves ${q.resolveBy}): ${q.question} - aggregate ${typeof q.aggregate === 'number' ? q.aggregate.toFixed(2) : '-'}`),
          '', resolved ? 'Scores (Brier: 0 perfect, 0.25 a coin; log: 0.693 a coin):' : 'No resolved questions yet: no score says anything about skill until some resolve.',
          ...s.map((r) => `- ${r.who}: Brier ${r.brier}, log ${r.log} over ${r.n}`),
          ...(resolved ? ['', 'Calibration (aggregate):', ...calibration(ledger.questions).filter((r) => r.n).map((r) => `- ${Math.round(r.from * 100)}-${Math.round(r.to * 100)}%: ${r.n} question(s), mean forecast ${r.meanP}, happened ${r.rate}`)] : []),
          fit ? `Extremizing refitted on ${resolved} resolved: ${fit.a} (Brier ${fit.brier}).` : `Extremizing: ${Math.sqrt(3).toFixed(2)} (refitted once 20 questions are resolved).`,
        ].join('\n');
      },
    });
  },
};
