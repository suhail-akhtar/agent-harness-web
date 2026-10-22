// A harness server with the showcase dashboard built and published (for screenshots and manual
// checks):  node test/fixtures/dashboards/demo-server.ts [port] [--shots <dir>]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../../../src/kernel/harness.ts';
import { createApp } from '../../../src/server/app.ts';
import { writeSalesFiles } from './sales.ts';
import { dashboardOps, detailOps, modelOps, morePagesOps } from './seed.ts';

export async function demo(port = 0, o: { dataDir?: string } = {}) {
  const data = o.dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'bi-demo-'));
  const files = path.join(data, 'files');
  const paths = await writeSalesFiles(files);
  process.env.HARNESS_LOCAL_ROOTS = files;
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off', backgroundWork: false });
  const token = 'demo-token';
  const { server } = createApp({ harness, token, loopback: true, localRoots: [files], uiDir: path.join(data, 'ui'), appRoot: path.resolve(import.meta.dirname, '..', '..', '..'), rateLimit: 0, messageRateLimit: 0 });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ops = async (list: unknown[]) => {
    const r = await fetch(`${base}/api/data/ops`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-harness': '1' }, body: JSON.stringify({ ops: list }) });
    const b = await r.json() as { results: Array<{ op: string; data?: { id?: string; slug?: string; token?: string; url?: string } }>; error?: string };
    if (!r.ok) throw new Error(b.error);
    return b;
  };
  await ops(modelOps(paths));
  const d = await ops(dashboardOps());
  const doc = d.results[0]!.data!.id!;
  const [drill, tip] = [d.results[1]!.data!.id!, d.results[2]!.data!.id!];
  const det = await ops(detailOps(doc, { drill, tip }));
  const [details, insights] = det.results.filter((x) => x.op === 'add_page').map((x) => x.data!.id!);
  await ops(morePagesOps(doc, { details: details!, insights: insights! }));
  await ops([{ op: 'set_narrative', doc, visual: 'v-narr', text: 'Revenue reached **{{Revenue}}** at a margin of **{{Margin %}}**. EMEA brought {{Revenue[countries.region=EMEA]}}, the Americas {{Revenue[countries.region=Americas]}} and APAC {{Revenue[countries.region=APAC]}}.' }]);
  const pub = await ops([{ op: 'publish', doc, access: 'token' }]);
  const { slug, token: share } = pub.results[0]!.data as { slug: string; token: string };
  return { harness, server, base, token, doc, slug, share, ops, data, files, paths, pages: { drill, tip, details: details!, insights: insights! }, close: async () => { server.closeAllConnections(); server.close(); await harness.close(); } };
}

if (import.meta.main) {
  const d = await demo(Number(process.argv[2] ?? 0));
  console.log(`published: ${d.base}/p/${d.slug}#t=${d.share}`);
  const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : undefined;
  if (shots) {
    const pw = await import('playwright-core');
    const b = await pw.chromium.launch();
    const page = await b.newPage({ viewport: { width: 1360, height: 900 } });
    page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
    page.on('pageerror', (e) => console.log('pageerror:', e.message));
    for (const [name, tab] of [['overview', 'p-1'], ['details', d.pages.details], ['insights', d.pages.insights]] as const) {
      await page.goto(`${d.base}/p/${d.slug}#t=${d.share}`);
      await page.waitForSelector('[data-bi-ready="1"]', { timeout: 60_000 });
      if (tab !== 'p-1') { await page.click(`[data-bi-tab="${tab}"]`); await page.waitForSelector(`[data-bi-page="${tab}"][data-bi-ready="1"]`, { timeout: 60_000 }); }
      await page.waitForTimeout(1200);
      await fs.mkdir(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
    }
    await b.close();
    await d.close();
  }
}
