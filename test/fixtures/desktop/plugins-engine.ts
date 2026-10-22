// The harness server as the desktop starts it, with the sdlc, quality-gates and aiops plugins on
// fixture data and a scripted model, for the plugins journey (test/desktop-plugins-e2e.test.ts):
// nothing is spent, everything else is real - the workflows, the quality gates (npm test in the
// feature's folder), the aiops tools against a fake Prometheus and a fake health endpoint, the
// plugin routes, the desktop's frames.
//
// The script plays every role by what it is asked:
//   build-feature's agents   write the requirements, an ADR, a plan, a slugify module whose first
//                            version fails one test (the gates fail, the fix agent repairs it),
//                            reviews that approve, the README and the delivery report;
//   "Run the quality gate"   calls quality_gates (the Quality gates panel's Run again);
//   /gates                   calls quality_gates;
//   /incident                reads the alerts, the SLOs and the topology (evidence ids), opens an
//                            incident, records evidence, a refuter verdict and the root cause,
//                            writes the runbook, resolves it and writes the postmortem;
//   anything else            a short reply.
import fs from 'node:fs';
import path from 'node:path';
import { createHarness } from '../../../src/kernel/harness.ts';
import { createApp } from '../../../src/server/app.ts';
import { SpendLedger, UserStore } from '../../../src/server/users.ts';
import { startOpsFixture } from './ops-fixture.ts';
import { ScriptedProvider } from './plugins-script.ts';

const DATA = path.resolve(process.env.HARNESS_DATA ?? '.harness-e2e');
const PORT = Number(process.env.HARNESS_PORT ?? 4399);
const TOKEN = process.env.HARNESS_TOKEN ?? 'e2e-token';
const ROOTS = (process.env.HARNESS_LOCAL_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const PLUGINS = (process.env.HARNESS_PLUGINS ?? '').split(path.delimiter).filter(Boolean);


// Fixture monitoring (a Prometheus, health URLs) and the operator inventory that uses it.
const ops = await startOpsFixture(DATA);
process.env.HARNESS_OPS_INVENTORY ??= ops.inventory;
const PROM = ops.prom;

const users = await new UserStore(DATA).load();
const spend = await new SpendLedger(DATA).load();
const harness = await createHarness({ dataDir: DATA, plugins: PLUGINS, search: null, spend, memory: 'off', log: (m) => console.log(m) });
harness.registry.setProviderInstance('deepseek', new ScriptedProvider());
const { server } = createApp({ harness, token: TOKEN, loopback: true, localRoots: ROOTS, uiDir: path.join(DATA, 'ui'), appRoot: path.resolve(import.meta.dirname, '..', '..', '..'), users, spend, messageRateLimit: 0, rateLimit: 0, routeRateLimit: 0 });
server.listen(PORT, '127.0.0.1', () => {
  // Where monitoring reaches the engine directly (the app's proxy never forwards a route token).
  if (process.env.HARNESS_E2E_ORIGIN_FILE) fs.writeFileSync(process.env.HARNESS_E2E_ORIGIN_FILE, `http://127.0.0.1:${PORT}`);
  console.log(`plugins engine listening on http://127.0.0.1:${PORT} (plugins: ${harness.registry.plugins.map((p) => p.name).join(', ') || 'none'}; prometheus ${PROM})`);
});
const stop = () => { server.close(); ops.close(); void harness.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
