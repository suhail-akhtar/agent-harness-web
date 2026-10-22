// The model-free watch loop against the real test stack (evals/aiops/stack, compose
// project hwtest-aiops): the server evaluates the inventory's PromQL and probe rules on
// its own timer, and starts nothing while the shop is healthy - the expired certificate
// the stack serves on purpose is a warning incident, below the minimum severity set
// here - then exactly one investigation when a fault is injected (the slow orders
// endpoint escalates the shop's incident to critical), with no model call before it.
// Skipped without Docker or the stack's images (HARNESS_TEST_AIOPS_STACK=1 runs it
// anyway and pulls them; =0 always skips). The stack is brought up and torn down here.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, type Harness } from '../src/kernel/harness.ts';
import { dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { FakeProvider, tempDir } from './helpers.ts';
// @ts-expect-error plain JS
const stack = await import('../evals/aiops/stack/stack.mjs');
// @ts-expect-error plain JS
const watch = await import('../plugins/aiops/lib/watch.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..', 'plugins', 'aiops');
const FIXTURE = path.join(here, '..', 'evals', 'aiops', 'fixtures');
const OPERATOR_INVENTORY = path.join(here, '..', 'evals', 'aiops', 'stack', 'operator-inventory.yaml');
const IMAGES = ['node:22-alpine', 'prom/prometheus:v2.54.1', 'prom/node-exporter:v1.8.2', 'lscr.io/linuxserver/openssh-server:latest'];
const want = process.env.HARNESS_TEST_AIOPS_STACK;
const run = want !== '0' && (await dockerAvailable()) && (want === '1' || (await Promise.all(IMAGES.map(imageExists))).every(Boolean));
const skip = run ? false : 'needs Docker and the stack images (HARNESS_TEST_AIOPS_STACK=1 pulls them)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENV: Record<string, string> = {};
let saved: Record<string, string | undefined> = {};
let h: Harness;
let fake: FakeProvider;
let dataDir: string;

async function waitFor(what: string, fn: () => Promise<boolean> | boolean, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(2000); }
  throw new Error(`timed out waiting for ${what}`);
}
const watchState = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'plugin-data', 'aiops', 'watch.json'), 'utf8').catch(() => '{}')) as { firing?: string[]; status?: { at: string; rules: number; firing: number; notEvaluated: string[] } };
const investigations = () => h.sessions.list().filter((m) => m.startedBy === 'aiops');

let release: (() => void) | undefined;
before(async () => {
  if (!run) return;
  release = await stack.hold();
  await stack.up();
  await stack.reset();
  const ws = await tempDir();
  await fs.cp(FIXTURE, ws, { recursive: true });
  dataDir = await tempDir();
  Object.assign(ENV, {
    HARNESS_OPS_INVENTORY: OPERATOR_INVENTORY, HARNESS_OPS_WATCH_PATH: ws, HARNESS_OPS_ALERTS_PATH: ws,
    HARNESS_OPS_WATCH_SECONDS: '5', HARNESS_PLUGIN_LOOPS: 'on',
    HARNESS_OPS_ALERTS_MODEL: 'deepseek-flash', HARNESS_OPS_ALERTS_WORKFLOW: 'none', HARNESS_OPS_ALERTS_MIN_SEVERITY: 'critical',
  });
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  h = await createHarness({ dataDir, plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
  fake = new FakeProvider(Array.from({ length: 100 }, () => ({ text: 'Investigating.' })));
  // Every provider answers with the script: no paid model, whatever keys the environment has.
  for (const id of h.registry.providers.keys()) h.registry.setProviderInstance(id, fake);
}, { timeout: 3_600_000 }); // may wait its turn for the stack (stack.hold)

after(async () => {
  if (!run) return;
  await h?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  stack.down();
  release?.();
}, { timeout: 300_000 });

test('stack watch loop: real PromQL on its own timer, nothing started while healthy, one investigation when a fault is injected', { skip, timeout: 600_000 }, async () => {
  // Healthy: rounds run on the timer (every 5 s here), evaluating every rule against the real Prometheus.
  await waitFor('the shop scraped and a few healthy rounds', async () => {
    const st = await watchState();
    return !!st.status && st.status.rules >= 7 && st.status.notEvaluated.length === 0 && Date.now() - Date.parse(st.status.at) < 10_000;
  });
  const healthyUntil = Date.now() + 20_000;
  while (Date.now() < healthyUntil) {
    const st = await watchState();
    assert.deepEqual((st.firing ?? []).filter((r) => r !== 'shop-api:tls'), [], `only the expired certificate fires while healthy (got ${st.firing})`);
    await sleep(2500);
  }
  assert.equal(investigations().length, 0, 'healthy: no investigation');
  assert.equal(fake.requests.length, 0, 'and no model call at all');
  const shared = watch.instances.get(path.join(dataDir, 'plugin-data', 'aiops'));
  const before = await shared.alerts.incidents();
  assert.equal(before.length, 1, 'the expired certificate is one (warning) incident');
  assert.equal(before[0].investigation, 'below-threshold');

  // The fault: the orders endpoint becomes slow; the latency rule fires after its "for".
  await stack.breakIt('slow');
  await waitFor('the latency rule firing in a watch round', async () => (await watchState()).firing?.includes('ShopOrdersLatencyHigh') ?? false, 240_000);
  await waitFor('one investigation', () => investigations().length === 1, 30_000);
  const g = (await shared.alerts.incidents()).find((x: { service: string }) => x.service === 'shop-api');
  assert.equal(g.alertSeverity, 'critical', 'escalated by the latency alert');
  assert.equal(g.sessionId, investigations()[0]!.id);
  assert.ok(g.alerts['watch:rule:ShopOrdersLatencyHigh']);
  const s = h.sessions.get(g.sessionId)!;
  assert.equal(s.meta.tainted, true);
  await waitFor('the brief delivered', () => s.history.length >= 1, 30_000);
  assert.match(JSON.stringify(s.history[0]), /ShopOrdersLatencyHigh/);
  // More rounds with the fault still there: still one investigation.
  const rounds = (await watchState()).status!.at;
  await waitFor('two more rounds', async () => Date.parse((await watchState()).status!.at) > Date.parse(rounds) + 9000, 60_000);
  assert.equal(investigations().length, 1);
  await stack.reset();
});
