// Hands a stopped workflow run to another model: the same session, workspace and run, its next
// steps on the new model, from the step it stopped in (the steps before are not run again).
//   node scripts/run.mjs scripts/handoff-run.ts --data <data dir> --session <id> --run <runId> --model <id> [--effort medium]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { printEvent } from '../src/cli.ts';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [data, id, runId, model] = [arg('data'), arg('session'), arg('run'), arg('model')];
if (!data || !id || !runId || !model) { console.error('usage: --data dir --session id --run runId --model id [--effort e]'); process.exit(2); }

const plugins = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins');
const h = await createHarness({ dataDir: data, plugins: [plugins], shippedPlugins: [plugins], backgroundWork: false, releaseHosts: true });
const s = h.sessions.get(id);
if (!s) { console.error(`no session ${id} in ${data}`); process.exit(2); }
s.update({ model, ...(arg('effort') ? { effort: arg('effort') as never } : {}) });
console.log(`session ${id}: ${s.meta.model} from here, run ${runId} resumes`);
const done = new Promise<void>((resolve) => {
  s.subscribe(0, ({ event }) => {
    printEvent(event, true);
    if (event.kind === 'permission_request') s.respond(event.requestId, { decision: 'allow' });
    if (event.kind === 'question') s.respond(event.requestId, { decision: 'answer', answer: 'Use your best judgement.' });
    if (event.kind === 'plan_proposed' || event.kind === 'approval_request') s.respond(event.requestId, { decision: 'approve' });
    if (event.kind === 'workflow' && ['succeeded', 'failed', 'aborted'].includes(event.run.status)) resolve();
  });
});
await s.resumeRun(runId);
await done;
const run = (await s.listRuns()).find((r) => r.id === runId);
console.log(`\nrun ${runId}: ${run?.status} ($${run?.cost.toFixed(2)} in all) ${run?.error ?? ''}`);
await h.close();
