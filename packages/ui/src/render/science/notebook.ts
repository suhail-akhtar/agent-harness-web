/**
 * Jupyter notebooks (.ipynb, nbformat 4): cells and their outputs, read into a shape the renderer
 * draws. Pure; outputs are classified, never executed: HTML outputs go to a script-less sandboxed
 * frame, images must be PNG/JPEG/GIF/SVG base64, ANSI colour codes are stripped from text.
 */

export type NbOutput =
  | { kind: 'text'; text: string; stream?: 'stdout' | 'stderr' }
  | { kind: 'image'; mime: string; data: string }
  | { kind: 'html'; html: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'json'; json: string }
  | { kind: 'error'; name: string; value: string; traceback: string };
export interface NbCell { kind: 'markdown' | 'code' | 'raw'; source: string; count?: number | null; outputs: NbOutput[] }
export interface Notebook { language: string; cells: NbCell[] }

const text = (v: unknown): string => (Array.isArray(v) ? v.map(String).join('') : typeof v === 'string' ? v : '');
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

export function parseNotebook(source: string): { nb?: Notebook; error?: string } {
  let j: Record<string, unknown>;
  try { j = JSON.parse(source) as Record<string, unknown>; } catch (e) { return { error: `not valid JSON: ${(e as Error).message}` }; }
  if (!j || !Array.isArray(j.cells)) return { error: 'not a notebook: no "cells"' };
  const meta = (j.metadata ?? {}) as { language_info?: { name?: string }; kernelspec?: { language?: string } };
  const language = String(meta.language_info?.name ?? meta.kernelspec?.language ?? 'python').toLowerCase().replace(/[^a-z0-9+#-]/g, '') || 'python';
  const cells: NbCell[] = (j.cells as Array<Record<string, unknown>>).slice(0, 500).map((c) => {
    const kind = c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'code' ? 'code' : 'raw';
    const outputs: NbOutput[] = [];
    for (const o of (Array.isArray(c.outputs) ? c.outputs : []) as Array<Record<string, unknown>>) {
      if (o.output_type === 'stream') { outputs.push({ kind: 'text', text: stripAnsi(text(o.text)), stream: o.name === 'stderr' ? 'stderr' : 'stdout' }); continue; }
      if (o.output_type === 'error') { outputs.push({ kind: 'error', name: String(o.ename ?? 'Error'), value: String(o.evalue ?? ''), traceback: stripAnsi(text(Array.isArray(o.traceback) ? (o.traceback as unknown[]).join('\n') : '')) }); continue; }
      const data = (o.data ?? {}) as Record<string, unknown>;
      const img = ['image/png', 'image/jpeg', 'image/gif'].find((m) => typeof data[m] === 'string' || Array.isArray(data[m]));
      if (img) { outputs.push({ kind: 'image', mime: img, data: text(data[img]).replace(/\s+/g, '') }); continue; }
      if (data['image/svg+xml']) { outputs.push({ kind: 'image', mime: 'image/svg+xml', data: typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(text(data['image/svg+xml'])))) : '' }); continue; }
      if (data['text/html']) { outputs.push({ kind: 'html', html: text(data['text/html']) }); continue; }
      if (data['text/markdown']) { outputs.push({ kind: 'markdown', text: text(data['text/markdown']) }); continue; }
      if (data['application/json']) { outputs.push({ kind: 'json', json: JSON.stringify(data['application/json'], null, 2) }); continue; }
      if (data['text/plain']) outputs.push({ kind: 'text', text: stripAnsi(text(data['text/plain'])) });
    }
    return { kind, source: text(c.source), ...(kind === 'code' ? { count: typeof c.execution_count === 'number' ? c.execution_count : null } : {}), outputs };
  });
  return { nb: { language, cells } };
}
