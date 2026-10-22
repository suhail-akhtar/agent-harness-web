/**
 * core.artifacts: what agents make for the person to keep. A panel per conversation (preview, code,
 * versions and the changes between them, copy, download, full window), the cards in the transcript
 * (a renderer for the "artifact" event kind) and the Library page across conversations.
 */

import type { BuiltinPlugin } from '../../state/data';
import { navigate, openPluginPanel, useApp } from '../../state/app';
import { ArtifactRefCard, ArtifactsPanel } from './Panel';
import { Library } from './Library';

function currentSession(): string | undefined {
  const r = useApp.getState().route;
  return r.view === 'core.chat:session' ? r.params?.id : undefined;
}

export const coreArtifacts: BuiltinPlugin = {
  name: 'core.artifacts', version: '0.1.0', description: 'Artifacts: the documents, apps, diagrams and data agents make, with every version; and the Library.',
  ui: {
    apiVersion: 1, displayName: 'Artifacts', icon: 'layers', trust: 'native', capabilities: [],
    contributes: {
      navItems: [{ id: 'library', title: 'Library', icon: 'library', view: 'library', order: 25 }],
      views: [{ id: 'library', title: 'Library', kind: 'native', component: 'Library' }],
      panels: [{ id: 'artifacts', title: 'Artifacts', icon: 'layers', kind: 'native', component: 'ArtifactsPanel', where: 'session' }],
      renderers: [{ id: 'artifact-card', for: { event: 'artifact' }, kind: 'native', component: 'ArtifactRefCard' }],
      commands: [
        { id: 'library', title: 'Open the Library', category: 'Artifacts', icon: 'library', action: { type: 'open-view', view: 'library' }, agent: { description: 'Open the Library page: every artifact across the person\'s conversations.' } },
        { id: 'panel', title: 'Show this conversation\'s artifacts', category: 'Artifacts', icon: 'layers', keybinding: 'Mod+Shift+A', handler: 'panel' },
      ],
    },
  },
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
