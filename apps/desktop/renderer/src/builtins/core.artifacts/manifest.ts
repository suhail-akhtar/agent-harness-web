/** core.artifacts' manifest: plain data (tests read it as the app does). Its guide is GUIDE.md (skill core.artifacts-guide). */

export const meta = { name: 'core.artifacts', version: '0.1.0', description: 'Artifacts: the documents, apps, diagrams and data agents make, with every version; and the Library.' };

export const ui = {
  apiVersion: 1, displayName: 'Artifacts', icon: 'layers', trust: 'native', capabilities: [],
  guide: 'GUIDE.md',
  tools: ['artifact'],
  contributes: {
    navItems: [{ id: 'library', title: 'Library', icon: 'library', view: 'library', order: 25 }],
    views: [{ id: 'library', title: 'Library', description: 'Every artifact across the person\'s conversations: search, kind filter, grid or list.', kind: 'native', component: 'Library' }],
    panels: [{ id: 'artifacts', title: 'Artifacts', icon: 'layers', kind: 'native', component: 'ArtifactsPanel', where: 'session' }],
    renderers: [{ id: 'artifact-card', for: { event: 'artifact' }, kind: 'native', component: 'ArtifactRefCard' }],
    commands: [
      { id: 'library', title: 'Open the Library', category: 'Artifacts', icon: 'library', action: { type: 'open-view', view: 'library' }, agent: { description: 'Open the Library page: every artifact across the person\'s conversations.' } },
      { id: 'panel', title: 'Show this conversation\'s artifacts', category: 'Artifacts', icon: 'layers', keybinding: 'Mod+Shift+A', handler: 'panel' },
    ],
  },
};
