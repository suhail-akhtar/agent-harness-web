/**
 * core.artifacts: what agents make for the person to keep. A panel per conversation (preview, code,
 * versions and the changes between them, copy, download, full window), the cards in the transcript
 * (a renderer for the "artifact" event kind) and the Library page across conversations.
 */

import type { BuiltinPlugin } from '../../state/data';
import { navigate, openPluginPanel, useApp } from '../../state/app';
import { ArtifactRefCard, ArtifactsPanel } from './Panel';
import { Library } from './Library';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

function currentSession(): string | undefined {
  const r = useApp.getState().route;
  return r.view === 'core.chat:session' ? r.params?.id : undefined;
}

export const coreArtifacts: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { Library, ArtifactsPanel, ArtifactRefCard },
  handlers: {
    panel: () => {
      const id = currentSession();
      if (!id) { navigate({ view: 'core.artifacts:library' }); return; }
      const p = useApp.getState().panel;
      if (p?.kind === 'plugin' && p.panel === 'core.artifacts:artifacts') useApp.setState({ panel: null });
      else openPluginPanel('core.artifacts:artifacts', { id });
    },
  },
};
