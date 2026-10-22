/**
 * The details of what is selected on a diagram: a node (every field, its columns, links to files
 * and pages, findings, what it connects to) or an edge (its ends, label, kind, the flows that use it).
 * Used inside the canvas and, in the desktop, in the side panel.
 */

import React from 'react';
import type { DiagramLink, DiagramSpec } from '@harness/plugin-ui';
import { NODE_CAPTIONS } from '@harness/plugin-ui';
import { Icon } from '../../icons.tsx';
import { safeHref } from '../safe.ts';

export type DiagramSelection = { type: 'node' | 'edge'; id: string };

const SEV_COLOR: Record<string, string> = { critical: 'text-hx-danger', high: 'text-hx-danger', medium: 'text-hx-warning', low: 'text-hx-secondary', info: 'text-hx-muted' };
const STATUS: Record<string, [string, string]> = { done: ['Done', 'text-hx-success'], 'in-progress': ['In progress', 'text-hx-warning'], failing: ['Failing', 'text-hx-danger'], planned: ['Planned', 'text-hx-muted'] };

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex gap-3 py-1 text-[12.5px]"><span className="w-24 shrink-0 text-hx-muted">{k}</span><span className="min-w-0 flex-1 break-words text-hx-primary">{children}</span></div>;
}

export function DiagramDetails({ spec, selection, changed, onSelect, onOpenLink, onNeighbourhood, onClose }: {
  spec: DiagramSpec;
  selection: DiagramSelection | null;
  changed?: ReadonlySet<string>;
  onSelect?: (s: DiagramSelection) => void;
  onOpenLink?: (l: DiagramLink) => void;
  onNeighbourhood?: (id: string) => void;
  onClose?: () => void;
}): React.ReactElement {
  const title = (id: string) => spec.nodes.find((n) => n.id === id)?.title ?? id;
  const header = (icon: string, caption: string, name: string) => (
    <div className="flex items-start gap-2 border-b border-hx-border-subtle px-3 py-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-hx-accent-soft text-hx-accent-text"><Icon name={icon} size={15} /></span>
      <span className="min-w-0 flex-1"><span className="block text-[10.5px] font-semibold uppercase tracking-wider text-hx-muted">{caption}</span><span className="block break-words text-[14px] font-semibold text-hx-primary" data-details-title>{name}</span></span>
      {onClose && <button type="button" aria-label="Close the details" onClick={onClose} className="rounded-md p-1 text-hx-muted hover:bg-hx-hover hover:text-hx-primary"><Icon name="x" size={14} /></button>}
    </div>
  );
  if (!selection) return <div data-diagram-details="" className="p-4 text-[12.5px] text-hx-muted">Select a box or a line to see its details. Arrow keys move the selection; Enter opens it here.</div>;
  if (selection.type === 'edge') {
    const e = spec.edges?.find((x) => x.id === selection.id);
    if (!e) return <div data-diagram-details="" className="p-4 text-[12.5px] text-hx-muted">That line is not in this version.</div>;
    const flows = (spec.flows ?? []).filter((f) => f.steps.some((s) => s.edge === e.id || (s.from === e.from && s.to === e.to) || (s.from === e.to && s.to === e.from)));
    return (
      <div data-diagram-details="edge">
        {header('arrow-right', e.async ? 'Asynchronous relation' : 'Relation', e.label ?? `${title(e.from)} → ${title(e.to)}`)}
        <div className="px-3 py-2">
          <Row k="From"><button type="button" className="text-hx-accent-text hover:underline" onClick={() => onSelect?.({ type: 'node', id: e.from })}>{title(e.from)}</button></Row>
          <Row k="To"><button type="button" className="text-hx-accent-text hover:underline" onClick={() => onSelect?.({ type: 'node', id: e.to })}>{title(e.to)}</button></Row>
          {e.label && <Row k="Label">{e.label}</Row>}
          {e.kind && <Row k="Kind">{e.kind}</Row>}
          {e.cardinality && <Row k="Cardinality">{e.cardinality}</Row>}
          {e.count !== undefined && <Row k="Count">{e.count}</Row>}
          <Row k="Style">{e.async ? 'asynchronous (dashed)' : 'synchronous'}</Row>
          {e.description && <Row k="Notes"><span className="whitespace-pre-wrap">{e.description}</span></Row>}
          {flows.length > 0 && <Row k="In flows">{flows.map((f) => f.title).join(', ')}</Row>}
        </div>
      </div>
    );
  }
  const n = spec.nodes.find((x) => x.id === selection.id);
  if (!n) return <div data-diagram-details="" className="p-4 text-[12.5px] text-hx-muted">That box is not in this version.</div>;
  const group = spec.groups?.find((g) => g.id === n.group);
  const out = (spec.edges ?? []).filter((e) => e.from === n.id);
  const inn = (spec.edges ?? []).filter((e) => e.to === n.id);
  const linkRow = (l: DiagramLink, i: number) => {
    const href = l.url ? safeHref(l.url) : undefined;
    const label = l.label ?? l.file ?? l.url ?? '';
    return (
      <li key={i}>
        <button type="button" data-diagram-link={l.file ?? l.url} onClick={() => onOpenLink?.(l)} disabled={!onOpenLink && !href} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] text-hx-accent-text hover:bg-hx-hover">
          <Icon name={l.file ? 'file' : 'external'} size={13} className="shrink-0" /><span className="min-w-0 flex-1 truncate">{label}{l.line ? `:${l.line}` : ''}</span>
        </button>
      </li>
    );
  };
  return (
    <div data-diagram-details="node" data-node={n.id}>
      {header('layers', NODE_CAPTIONS[n.kind], n.title)}
      <div className="px-3 py-2">
        {changed?.has(n.id) && <div className="mb-2 rounded-md bg-amber-500/12 px-2 py-1 text-[12px] font-medium text-hx-warning">Changed in this version</div>}
        {n.tech && <Row k="Technology">{n.tech}</Row>}
        {n.status && <Row k="Status"><span className={STATUS[n.status]?.[1]}>{STATUS[n.status]?.[0] ?? n.status}</span></Row>}
        <Row k="Built or bought">{n.integrated ? 'Integrated / bought' : n.kind === 'person' ? 'A person' : 'Built here'}</Row>
        {group && <Row k="In">{group.label}{group.subtitle ? ` · ${group.subtitle}` : ''}</Row>}
        {n.size && <Row k="Size">{n.size}</Row>}
        {n.address && <Row k="Address"><span className="font-mono text-[12px]">{n.address}</span></Row>}
        {n.files !== undefined && <Row k="Files">{n.files}</Row>}
        {n.tags?.length ? <Row k="Tags">{n.tags.join(', ')}</Row> : null}
        <Row k="Id"><span className="font-mono text-[11.5px] text-hx-muted">{n.id}</span></Row>
        {n.description && <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-5 text-hx-secondary">{n.description}</p>}
        {n.fields?.length ? (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-hx-muted">Columns ({n.fields.length})</div>
            <table className="w-full text-[12px]" data-details-fields>
              <tbody>
                {n.fields.map((f, i) => (
                  <tr key={i} className="border-t border-hx-border-subtle">
                    <td className="w-8 py-1 text-[10px] font-bold text-hx-warning">{f.pk ? 'PK' : f.fk ? 'FK' : f.uk ? 'UK' : ''}</td>
                    <td className="py-1">{f.name}{f.pii && <span className="ml-1.5 rounded-full bg-rose-500/12 px-1.5 text-[10px] font-bold text-rose-600">pii</span>}{typeof f.fk === 'string' && <span className="ml-1.5 text-[11px] text-hx-muted">→ {f.fk}</span>}</td>
                    <td className="py-1 text-right font-mono text-[11.5px] text-hx-muted">{f.type}{f.nullable ? '?' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {n.links?.length ? (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-hx-muted">Links</div>
            <ul data-details-links>{n.links.map(linkRow)}</ul>
          </div>
        ) : null}
        {n.findings?.length ? (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-hx-muted">Findings ({n.findings.length})</div>
            <ul className="space-y-1.5" data-details-findings>
              {n.findings.map((f, i) => (
                <li key={i} className="rounded-md border border-hx-border-subtle px-2 py-1.5 text-[12.5px]">
                  <span className={`mr-1.5 text-[10.5px] font-bold uppercase ${SEV_COLOR[f.severity] ?? ''}`}>{f.severity}</span>{f.title}
                  {f.detail && <p className="mt-1 whitespace-pre-wrap text-[12px] text-hx-secondary">{f.detail}</p>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {(out.length > 0 || inn.length > 0) && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-hx-muted">Connections</div>
            <ul className="text-[12.5px]">
              {out.map((e) => <li key={`o${e.id}`}><button type="button" className="flex w-full gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-hx-hover" onClick={() => onSelect?.({ type: 'edge', id: e.id })}><span className="text-hx-muted">→</span><span className="flex-1 truncate">{title(e.to)}</span>{e.label && <span className="truncate text-hx-muted">{e.label}</span>}</button></li>)}
              {inn.map((e) => <li key={`i${e.id}`}><button type="button" className="flex w-full gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-hx-hover" onClick={() => onSelect?.({ type: 'edge', id: e.id })}><span className="text-hx-muted">←</span><span className="flex-1 truncate">{title(e.from)}</span>{e.label && <span className="truncate text-hx-muted">{e.label}</span>}</button></li>)}
            </ul>
          </div>
        )}
        {onNeighbourhood && <button type="button" onClick={() => onNeighbourhood(n.id)} className="mt-3 rounded-md border border-hx-border px-2 py-1 text-[12px] text-hx-secondary hover:bg-hx-hover">Show its neighbourhood</button>}
      </div>
    </div>
  );
}
