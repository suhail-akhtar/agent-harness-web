import type { Registry } from '../kernel/registry.ts';
import type { GateResult } from '../plugins/api.ts';
import type { ToolHost } from '../runtime/host.ts';
import type { Tool, ToolServices } from '../tools/types.ts';

// Quality gates are verifiers registered by plugins. The harness runs them in
// three places: a workflow's gate nodes, the agent's own `quality_gates` tool
// (so it can check its work before saying it is done), and optionally a Stop
// hook that will not let the agent finish while a blocking gate fails.

export interface GateRun extends GateResult { name: string; ms: number }

export async function runGates(reg: Registry, host: ToolHost, names: string[] | 'applicable', signal: AbortSignal, services?: ToolServices): Promise<GateRun[]> {
  const out: GateRun[] = [];
  // The gates are bash commands. Under PowerShell their probes fail, so every gate
  // would read as "does not apply" and an unchecked workspace would pass.
  if (host.shell === 'powershell' && reg.gates.size) {
    return [{ name: 'gates', pass: false, ms: 0, summary: 'the quality gates need bash, and this host runs PowerShell', details: 'Install Git for Windows (it brings Git Bash) and restart the harness, or set HARNESS_SHELL to the path of bash.exe.' }];
  }
  const all = [...reg.gates.values()];
  const chosen = names === 'applicable' ? all : all.filter((g) => names.includes(g.name));
  if (names !== 'applicable') for (const n of names) if (!reg.gates.has(n)) out.push({ name: n, pass: false, summary: 'no such gate', ms: 0 });
  for (const g of chosen) {
    if (signal.aborted) break;
    try {
      if (names === 'applicable' && g.applies && !(await g.applies(host, signal))) continue;
      const t0 = Date.now();
      const r = await g.run({ host, signal, services });
      out.push({ ...r, name: g.name, ms: Date.now() - t0 });
    } catch (err) {
      out.push({ name: g.name, pass: false, summary: `gate crashed: ${(err as Error).message}`, ms: 0 });
    }
  }
  return out;
}

export function formatGates(results: GateRun[]): string {
  if (!results.length) return 'No quality gates apply to this workspace.';
  const failed = results.filter((r) => !r.pass && r.severity !== 'advisory');
  const head = failed.length ? `${failed.length} blocking gate(s) FAILED.` : 'All blocking gates passed.';
  return [head, ...results.map((r) => {
    const tag = r.pass ? 'PASS' : r.severity === 'advisory' ? 'WARN' : 'FAIL';
    return `${tag} ${r.name} (${(r.ms / 1000).toFixed(1)}s): ${r.summary}${!r.pass && r.details ? `\n${r.details.slice(0, 3000)}` : ''}`;
  })].join('\n');
}

export function makeGatesTool(reg: Registry): Tool {
  const names = [...reg.gates.keys()];
  return {
    kind: 'exec', parallelSafe: false, remoteable: false,
    spec: {
      name: 'quality_gates',
      description: `Run the project's quality gates (tests, type checks, linters, builds, security scans - whichever apply) and get PASS/FAIL with the evidence. Run them before you report work as done, and fix what fails. Available: ${names.join(', ')}.`,
      input_schema: { type: 'object', properties: { gates: { type: 'array', items: { type: 'string' }, description: 'Gate names; omit for every gate that applies.' } } },
    },
    summarize: (i) => `quality gates${Array.isArray(i.gates) && i.gates.length ? `: ${i.gates.join(', ')}` : ''}`,
    async run(input, ctx) {
      const chosen = Array.isArray(input.gates) && input.gates.length ? input.gates.map(String) : 'applicable';
      const results = await runGates(reg, ctx.host, chosen, ctx.signal, ctx.services);
      return { content: formatGates(results), is_error: results.some((r) => !r.pass && r.severity !== 'advisory') };
    },
  };
}
