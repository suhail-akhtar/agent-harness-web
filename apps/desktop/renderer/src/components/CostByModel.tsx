/** What a conversation cost, per model (its own and the ones agents delegated to): calls, tokens, cost. */

import React from 'react';
import type { SessionMeta } from '@harness/client';
import { costByModel } from '../state/agents';

export const money = (c: number) => (c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function CostByModel({ meta }: { meta: SessionMeta }): React.ReactElement {
  const rows = costByModel(meta.byModel);
  if (!rows.length) return <p className="px-1 text-[12px] text-hx-muted">Nothing spent yet.</p>;
  return (
    <table data-cost-by-model className="w-full text-[12px]">
      <thead><tr className="text-left text-hx-muted"><th className="px-1 font-normal">Model</th><th className="px-1 text-right font-normal">Calls</th><th className="px-1 text-right font-normal">In / out</th><th className="px-1 text-right font-normal">Cost</th></tr></thead>
      <tbody>
        {rows.map((r) => <tr key={r.model} data-model-cost={r.model} className="border-t border-hx-border-subtle"><td className="px-1 py-1 font-mono">{r.model}{r.model === meta.model ? <span className="ml-1 font-sans text-hx-muted">(this chat)</span> : null}</td><td className="px-1 text-right tabular-nums">{r.requests}</td><td className="px-1 text-right tabular-nums">{fmtK(r.input + r.cacheRead)} / {fmtK(r.output)}</td><td className="px-1 text-right tabular-nums">{money(r.cost)}</td></tr>)}
        {rows.length > 1 && <tr className="border-t border-hx-border"><td className="px-1 py-1 font-medium">All models</td><td /><td /><td className="px-1 text-right font-medium tabular-nums">{money(rows.reduce((n, r) => n + r.cost, 0))}</td></tr>}
      </tbody>
    </table>
  );
}
