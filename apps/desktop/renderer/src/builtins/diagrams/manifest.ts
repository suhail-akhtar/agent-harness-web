/** core.diagrams' manifest: plain data (tests read it as the app does). Its guide is GUIDE.md (skill core.diagrams-guide). */

export const meta = { name: 'core.diagrams', version: '0.1.0', description: 'Interactive architecture, deployment, data, code and flow diagrams: drag, explore, play flows, export, and ask the agent to change them.' };

export const ui = {
  apiVersion: 1, displayName: 'Diagrams', icon: 'layers', trust: 'native', capabilities: [],
  guide: 'GUIDE.md',
  tools: ['artifact'],
  contributes: {
    views: [{ id: 'diagram', title: 'Diagram', description: 'The interactive canvas (params: session and artifact, or code = a conversation id for its code map).', kind: 'native', component: 'Page' }],
    panels: [{ id: 'details', title: 'Details', kind: 'native', component: 'Details', where: 'any' }],
    renderers: [
      { id: 'fence', for: { fence: 'diagram' }, kind: 'native', component: 'Fence' },
      { id: 'artifact', for: { artifact: 'diagram' }, kind: 'native', component: 'Artifact' },
      { id: 'tool', for: { tool: 'artifact' }, kind: 'native', component: 'Tool' },
    ],
    commands: [{ id: 'code-map', title: 'Show code map', category: 'Diagrams', icon: 'map', handler: 'codeMap', agent: { description: 'Opens the code map of the conversation on screen (its workspace by folder, TS/JS/Python imports) as an interactive diagram.' } }],
    slashCommands: [{ name: 'codemap', description: 'Show the code map of this conversation\'s workspace', action: { type: 'command', command: 'code-map' } }],
  },
};
