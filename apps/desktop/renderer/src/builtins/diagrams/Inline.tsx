/**
 * Diagrams where they appear: a ```diagram block, an artifact of kind "diagram" (in a card or the
 * side panel), and the `artifact` tool's call that made or changed one (shown under the turn's
 * folded steps, so a new diagram is seen without opening them). Each is the light static drawing
 * with "Open interactive", which opens the full-page view.
 */

import React, { useEffect, useState } from 'react';
import type { ToolItem } from '@harness/client';
import { validateDiagram } from '@harness/plugin-ui';
import { Artifact, DiagramBlock, DiagramCanvas, Icon, type ArtifactOrigin } from '@harness/ui';
import { navigate, useApp } from '../../state/app';
import { changedBetween, getArtifact, type Changed } from './api';
import { stashDiagram } from './store';

const VIEW = 'core.diagrams:diagram';
const currentSession = () => { const r = useApp.getState().route; return r.view === 'core.chat:session' ? r.params?.id : undefined; };

export function openStored(sessionId: string, id: string, from?: number): void {
  navigate({ view: VIEW, params: { session: sessionId, artifact: id, ...(from ? { from: String(from) } : {}) } });
}

/** A ```diagram block: the artifact card (Preview / Code), drawn by the artifact renderer below. */
export function FenceDiagram({ source }: { source: string; lang: string }): React.ReactElement {
  return <Artifact kind="diagram" source={source} language="json" />;
}

/** The artifact kind "diagram": static in a card, the canvas in the side panel. */
export function ArtifactDiagram({ source, title, fill, origin }: { kind: string; source: string; title: string; fill?: boolean; origin?: ArtifactOrigin }): React.ReactElement {
  const open = () => {
    if (origin) { openStored(origin.sessionId, origin.id); return; }
    const sessionId = currentSession();
    navigate({ view: VIEW, params: { key: stashDiagram({ source, title, ...(sessionId ? { sessionId } : {}) }) } });
  };
  if (fill) {
    const parsed = validateDiagram(source);
    if (parsed.spec) return <div className="h-full min-h-[420px]" data-diagram-fill=""><DiagramCanvas spec={parsed.spec} title={title} stableKey={origin ? `${origin.sessionId}/${origin.id}` : undefined} /></div>;
  }
  return <DiagramBlock source={source} title={title} bare onOpen={open} stableKey={origin ? `${origin.sessionId}/${origin.id}` : undefined} />;
}

const RESULT = /^(Created artifact|Updated|Rewrote) ([a-z0-9][a-z0-9-]{2,60}) v(\d+) diagram\b/;

/** The `artifact` tool's call, when it made or changed a diagram: the drawing (an update shows what it changed). */
export function ToolDiagram({ item, sessionId }: { item: ToolItem; sessionId: string }): React.ReactElement | null {
  const m = !item.isError && item.result ? RESULT.exec(item.result) : null;
  if (!m) return null;
  const id = m[2]!; const version = Number(m[3]);
  const created = m[1] === 'Created artifact';
  const inline = created && typeof item.input.content === 'string' ? item.input.content : undefined;
  return <StoredDiagram sessionId={sessionId} id={id} version={version} inline={inline} title={typeof item.input.title === 'string' ? item.input.title : undefined} compare={!created} />;
}

function StoredDiagram({ sessionId, id, version, inline, title, compare }: { sessionId: string; id: string; version: number; inline?: string; title?: string; compare: boolean }) {
  const [doc, setDoc] = useState<{ content: string; title: string } | null>(inline ? { content: inline, title: title ?? 'Diagram' } : null);
  const [changed, setChanged] = useState<Changed | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const now = inline ? null : await getArtifact(sessionId, id, version);
        if (now && alive) setDoc({ content: now.content, title: now.meta.title });
        if (compare && version > 1) {
          const before = await getArtifact(sessionId, id, version - 1);
          const content = now?.content ?? inline!;
          if (alive) setChanged(changedBetween(before.content, content, version));
        }
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    return () => { alive = false; };
  }, [sessionId, id, version, inline, compare]);
  if (error && !doc) return <div className="text-[12px] text-hx-muted">The diagram {id} v{version} could not be read: {error}</div>;
  if (!doc) return null;
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-hx-border bg-hx-bg" data-diagram-artifact={id} data-version={version}>
      <div className="flex items-center gap-2 border-b border-hx-border-subtle px-2.5 py-1.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hx-accent-soft text-hx-accent-text"><Icon name="layers" size={14} /></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-hx-primary">{doc.title}</span><span className="block text-[11px] text-hx-muted">Diagram · v{version}{compare ? ' · updated' : ''}</span></span>
      </div>
      <DiagramBlock source={doc.content} title={doc.title} bare changed={changed} stableKey={`${sessionId}/${id}`} onOpen={() => openStored(sessionId, id, compare && version > 1 ? version - 1 : undefined)} />
    </div>
  );
}
