// How much of every request the tool list is: the tools a session declares and their schema
// size (characters / 4 as tokens), with all bundled plugins on, for a plain session (as eval
// runs make) and a desktop session (the client's tools too). No model is called.
//   node scripts/run.mjs scripts/tool-schema-size.ts [--json]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import type { ToolSpec } from '../src/providers/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = (specs: ToolSpec[]) => Math.ceil(specs.reduce((a, s) => a + JSON.stringify({ name: s.name, description: s.description, input_schema: s.input_schema }).length, 0) / 4);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-schema-size-'));
const out: Record<string, unknown> = {};
try {
  const h = await createHarness({ dataDir, plugins: [path.join(root, 'plugins')], shippedPlugins: [path.join(root, 'plugins')], backgroundWork: false, scheduler: false });
  try {
    for (const [label, client] of [
      ['plain', undefined],
      ['desktop', { kind: 'desktop', version: '1', renderers: [], tools: ['desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open'] }],
    ] as const) {
      const s = await h.sessions.create({ model: 'claude-sonnet-5-5', runtime: { kind: 'local', network: 'none' }, ...(client ? { client: client as never } : {}) });
      const probe = s as unknown as { sentToolSpecs(): Promise<{ all: ToolSpec[]; sent: ToolSpec[]; groups: { id: string; tools: string[] }[] }> };
      const { all, sent, groups } = await probe.sentToolSpecs();
      const owner = (n: string) => groups.find((g) => g.tools.includes(n))?.id ?? 'core';
      const byOwner = new Map<string, { tools: number; tokens: number }>();
      for (const t of all) { const o = byOwner.get(owner(t.name)) ?? { tools: 0, tokens: 0 }; o.tools++; o.tokens += tokens([t]); byOwner.set(owner(t.name), o); }
      out[label] = {
        all: { tools: all.length, tokens: tokens(all) },
        sent: { tools: sent.length, tokens: tokens(sent) },
        byOwner: Object.fromEntries([...byOwner].sort((a, b) => b[1].tokens - a[1].tokens)),
      };
    }
  } finally { await h.close(); }
} finally { await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const [k, v] of Object.entries(out)) {
  const x = v as { all: { tools: number; tokens: number }; sent: { tools: number; tokens: number }; byOwner: Record<string, { tools: number; tokens: number }> };
  console.log(`${k}: ${x.all.tools} tools, ~${x.all.tokens} schema tokens in full; sent now: ${x.sent.tools} tools, ~${x.sent.tokens} tokens`);
  for (const [o, n] of Object.entries(x.byOwner)) console.log(`  ${o.padEnd(20)} ${String(n.tools).padStart(3)} tools ~${n.tokens} tokens`);
}
