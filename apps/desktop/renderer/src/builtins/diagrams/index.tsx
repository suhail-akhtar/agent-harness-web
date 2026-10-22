/**
 * core.diagrams: interactive architecture and flow diagrams (DESIGN section 16). A built-in plugin on
 * the public contract: a renderer for the `diagram` fence, one for the `diagram` artifact kind and one
 * for the `artifact` tool's results (a diagram made or changed), a full-page view, a details panel,
 * and the "Show code map" command. Switched off, all of it goes and diagrams draw as static pictures.
 */

import React from 'react';
import { DiagramDetails, EmptyState, toast } from '@harness/ui';
import type { BuiltinPlugin } from '../../state/data';
import { navigate, useApp } from '../../state/app';
import { useData } from '../../state/data';
import { DiagramPage } from './Page';
import { ArtifactDiagram, FenceDiagram, ToolDiagram } from './Inline';
import { useDetails } from './store';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

function DetailsPanel(): React.ReactElement {
  const d = useDetails();
  if (!d.spec) return <EmptyState icon="layers" title="No diagram open">Open a diagram and select a box or a line.</EmptyState>;
  return <div data-diagram-details-side=""><DiagramDetails spec={d.spec} selection={d.selection} changed={d.changed} onSelect={d.select} onOpenLink={d.openLink} /></div>;
}

/** The conversation the window shows now, or the most recent one. */
function sessionForCodeMap(): string | undefined {
  const r = useApp.getState().route;
  if (r.view === 'core.chat:session' && r.params?.id) return r.params.id;
  if (r.view === 'core.diagrams:diagram') return r.params?.code ?? r.params?.session;
  return useData.getState().sessions.find((s) => s.runtime?.kind === 'local' || !s.runtime)?.id;
}

export const coreDiagrams: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { Page: DiagramPage, Details: DetailsPanel, Fence: FenceDiagram, Artifact: ArtifactDiagram, Tool: ToolDiagram },
  handlers: {
    codeMap: () => {
      const id = sessionForCodeMap();
      if (!id) { toast('Open a conversation in a project folder first: the code map draws its workspace', { kind: 'info' }); return; }
      navigate({ view: 'core.diagrams:diagram', params: { code: id } });
    },
  },
};
