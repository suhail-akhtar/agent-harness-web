/**
 * core.chat: home, conversations, search. A built-in plugin: everything below is contributed through
 * the same manifest a third-party plugin writes (trust native: its components ship with the app).
 */

import type { BuiltinPlugin } from '../../state/data';
import { Home, RecentCard, Search, Session } from './Views';
import { navigate, useApp } from '../../state/app';

export const coreChat: BuiltinPlugin = {
  name: 'core.chat', version: '0.1.0', description: 'Conversations: the home page, the composer, the transcript and the attention bar.',
  ui: {
    apiVersion: 1, displayName: 'Chat', icon: 'chat', trust: 'native', capabilities: [], required: true,
    contributes: {
      navItems: [
        { id: 'new', title: 'New chat', icon: 'edit', view: 'home', order: 1 },
        { id: 'search', title: 'Search', icon: 'search', view: 'search', order: 2 },
      ],
      views: [
        { id: 'home', title: 'New chat', kind: 'native', component: 'Home' },
        { id: 'session', title: 'Conversation', kind: 'native', component: 'Session' },
        { id: 'search', title: 'Search conversations', kind: 'native', component: 'Search' },
      ],
      commands: [
        { id: 'new', title: 'New chat', category: 'Chat', icon: 'edit', keybinding: 'Mod+N', handler: 'newChat' },
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
  },
  components: { Home, Session, Search, RecentCard },
  handlers: {
    newChat: () => navigate({ view: 'core.chat:home' }),
    workflow: () => {
      const r = useApp.getState().route;
      useApp.setState({ workflowDialog: { sessionId: r.view === 'core.chat:session' ? r.params?.id : undefined } });
    },
  },
};
