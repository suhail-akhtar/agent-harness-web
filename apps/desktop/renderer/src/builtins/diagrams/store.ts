/**
 * core.diagrams' own state: diagrams opened from a ```diagram block (kept here by a key, as a route
 * carries only short params), their dragged positions, and what the details panel shows.
 */

import { create } from 'zustand';
import type { DiagramLink, DiagramSpec } from '@harness/plugin-ui';
import type { DiagramSelection } from '@harness/ui';

export interface Stashed { source: string; sessionId?: string; title?: string; positions?: Record<string, { x: number; y: number }> }
const stash = new Map<string, Stashed>();

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

/** Keeps a diagram's source for the full-page view; returns its key (the same source, the same key). */
export function stashDiagram(d: Stashed): string {
  const key = hash(`${d.sessionId ?? ''}\u0000${d.source}`);
  const was = stash.get(key);
  stash.set(key, { ...was, ...d });
  if (stash.size > 50) stash.delete(stash.keys().next().value!);
  return key;
}
export function stashed(key: string): Stashed | undefined { return stash.get(key); }
export function stashPositions(key: string, positions: Record<string, { x: number; y: number }>): void { const s = stash.get(key); if (s) stash.set(key, { ...s, positions }); }

export interface DetailsState {
  spec: DiagramSpec | null;
  selection: DiagramSelection | null;
  changed: ReadonlySet<string>;
  open: boolean;
  /** The page that owns the panel now. */
  owner: string | null;
  select?: (s: DiagramSelection) => void;
  openLink?: (l: DiagramLink) => void;
  close?: () => void;
}

export const useDetails = create<DetailsState>(() => ({ spec: null, selection: null, changed: new Set(), open: false, owner: null }));
