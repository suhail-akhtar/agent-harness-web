/** core.agents' manifest: plain data (tests read it as the app does). Its guide is GUIDE.md (skill core.agents-guide). */

export const meta = { name: 'core.agents', version: '0.1.0', description: 'Agents: sub-agents, background work, linked sessions and proposals, live; split view and chapters.' };

export const ui = {
  apiVersion: 1, displayName: 'Agents', icon: 'bot', trust: 'native', capabilities: [],
  // The Library (core.artifacts) sits in this module: what agents made, next to what they are doing.
  menu: { title: 'Agents', icon: 'bot', order: 20, items: ['agents', 'mine', 'core.artifacts:library'] },
  home: 'home',
  guide: 'GUIDE.md',
  tools: ['agent', 'start_session', 'list_sessions', 'send_message', 'hand_off', 'dismiss_proposal', 'mark_chapter', 'workflow'],
  contributes: {
    navItems: [{ id: 'agents', title: 'Working now', icon: 'activity', view: 'agents', order: 22, badge: 'core.agents.working' }, { id: 'mine', title: 'Your agents', icon: 'bot', view: 'mine', order: 23 }],
    views: [
      { id: 'home', title: 'Agents', icon: 'bot', description: 'Agents at work, proposals waiting, what they made lately, and ways to start.', kind: 'native', component: 'AgentsHome' },
      { id: 'agents', title: 'Agents', description: 'Everything working across conversations: sub-agents, background tasks, linked sessions under the one that started them, proposals, Stop.', kind: 'native', component: 'AgentsPage' },
      { id: 'mine', title: 'Your agents', icon: 'bot', description: 'Your own agents (role, instructions, model, tools, MCP servers, skills, autonomy, limits): make, generate, import, chat with them.', kind: 'native', component: 'YourAgents' },
    ],
    panels: [{ id: 'agents', title: 'Agents', icon: 'bot', kind: 'native', component: 'AgentsPanel', where: 'session' }, { id: 'record', title: 'Run record', icon: 'shield', kind: 'native', component: 'RecordPanel', where: 'session' }],
    renderers: [
      { id: 'proposal', for: { event: 'proposal' }, kind: 'native', component: 'ProposalCard' },
      { id: 'link', for: { event: 'link' }, kind: 'native', component: 'LinkCard' },
      { id: 'chapter', for: { event: 'chapter' }, kind: 'native', component: 'ChapterDivider' },
    ],
    commands: [
      { id: 'page', title: 'Show every agent at work', category: 'Agents', icon: 'bot', action: { type: 'open-view', view: 'agents' }, agent: { description: 'Open the Agents page: everything at work, with Stop.' } },
      { id: 'panel', title: 'Show this conversation\'s agents', category: 'Agents', icon: 'bot', keybinding: 'Mod+Shift+E', handler: 'panel' },
      { id: 'close-split', title: 'Close the conversation beside', category: 'View', icon: 'x', handler: 'closeSplit' },
      { id: 'record', title: 'Show the run record of this conversation', category: 'Agents', icon: 'shield', handler: 'record' },
      {
        id: 'new', title: 'New agent…', category: 'Agents', icon: 'plus', handler: 'newAgent',
        agent: {
          // Its arguments (name, description, prompt, tools, permissionMode) are in GUIDE.md, loaded when needed;
          // the handler checks them. Kept out of the declaration every desktop conversation carries (names and types only).
          description: 'Open the agent builder filled in (args: see the core.agents guide), to check and save.',
          inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, permissionMode: { type: 'string' } } },
        },
      },
    ],
  },
};
