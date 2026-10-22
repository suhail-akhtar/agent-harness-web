/** core.chat's manifest: plain data (tests read it as the app does). Its guide is GUIDE.md (skill core.chat-guide). */

export const meta = { name: 'core.chat', version: '0.1.0', description: 'Conversations: the home page, the composer, the transcript and the attention bar.' };

export const ui = {
  apiVersion: 1, displayName: 'Chat', icon: 'chat', trust: 'native', capabilities: [], required: true,
  guide: 'GUIDE.md',
  contributes: {
    navItems: [
      { id: 'new', title: 'New chat', icon: 'edit', view: 'home', order: 1 },
      { id: 'search', title: 'Search', icon: 'search', view: 'search', order: 2 },
    ],
    views: [
      { id: 'home', title: 'New chat', description: 'The home page: the composer, prompts, home cards.', kind: 'native', component: 'Home' },
      { id: 'session', title: 'Conversation', description: 'One conversation (params: id).', kind: 'native', component: 'Session' },
      { id: 'search', title: 'Search conversations', kind: 'native', component: 'Search' },
    ],
    commands: [
      {
        id: 'new', title: 'New chat', category: 'Chat', icon: 'edit', keybinding: 'Mod+N', handler: 'newChat',
        agent: { description: 'Open a new chat, optionally with a prompt typed in for the person (it is never sent without them).', inputSchema: { type: 'object', properties: { prompt: { type: 'string', maxLength: 4000 } } } },
      },
      { id: 'search', title: 'Search conversations', category: 'Chat', icon: 'search', keybinding: 'Mod+Shift+F', action: { type: 'open-view', view: 'search' } },
      { id: 'workflow', title: 'Run a workflow…', category: 'Chat', icon: 'workflow', handler: 'workflow' },
    ],
    slashCommands: [
      { name: 'new', description: 'Start a new chat', action: { type: 'command', command: 'core.chat:new' } },
      { name: 'workflow', description: 'Run a workflow in this conversation', action: { type: 'command', command: 'core.chat:workflow' } },
      { name: 'plan', description: 'Plan before changing anything', action: { type: 'prompt', prompt: 'Before changing anything, make a short plan for: {args}' } },
    ],
    homeCards: [{ id: 'recent', title: 'Recent conversations', kind: 'native', component: 'RecentCard', order: 20 }],
    prompts: [
      { id: 'explain', title: 'Explain this project', prompt: 'Read this project and explain how it is organised, then suggest three improvements.', icon: 'book', home: true },
      { id: 'tests', title: 'Write tests', prompt: 'Find the least tested part of this project and write tests for it.', icon: 'flask', home: true },
      { id: 'fix', title: 'Fix a bug', prompt: 'Here is a bug I am seeing: ', icon: 'bug', home: true },
    ],
  },
};
