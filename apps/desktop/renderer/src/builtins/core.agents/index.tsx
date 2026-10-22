/**
 * core.agents: the multi-agent platform in the window. The Agents panel (a live tree of a
 * conversation's sub-agents, background tasks, linked sessions and proposals, with its todo list
 * and cost per model), the Agents page (everything working across conversations, with Stop), and
 * what the transcript draws for proposals, linked sessions and chapters (renderers for those item
 * kinds). A linked conversation opens beside the current one (the shell's split view).
 */

import { useData, type BuiltinPlugin } from '../../state/data';
import { navigate, openPluginPanel, useApp } from '../../state/app';
import { AgentsPanel } from './Panel';
import { AgentsPage, watchLinkedNews } from './Page';
import { ChapterDivider, LinkCard, ProposalCard } from './Cards';

export const coreAgents: BuiltinPlugin = {
  name: 'core.agents', version: '0.1.0', description: 'Agents: sub-agents, background work, linked sessions and proposals, live; split view and chapters.',
  ui: {
    apiVersion: 1, displayName: 'Agents', icon: 'bot', trust: 'native', capabilities: [],
    contributes: {
      navItems: [{ id: 'agents', title: 'Agents', icon: 'bot', view: 'agents', order: 22, badge: 'core.agents.working' }],
      views: [{ id: 'agents', title: 'Agents', kind: 'native', component: 'AgentsPage' }],
      panels: [{ id: 'agents', title: 'Agents', icon: 'bot', kind: 'native', component: 'AgentsPanel', where: 'session' }],
      renderers: [
        { id: 'proposal', for: { event: 'proposal' }, kind: 'native', component: 'ProposalCard' },
        { id: 'link', for: { event: 'link' }, kind: 'native', component: 'LinkCard' },
        { id: 'chapter', for: { event: 'chapter' }, kind: 'native', component: 'ChapterDivider' },
      ],
      commands: [
        { id: 'page', title: 'Show every agent at work', category: 'Agents', icon: 'bot', action: { type: 'open-view', view: 'agents' }, agent: { description: 'Open the Agents page: every conversation, sub-agent, background task and linked session at work, with Stop.' } },
        { id: 'panel', title: 'Show this conversation\'s agents', category: 'Agents', icon: 'bot', keybinding: 'Mod+Shift+E', handler: 'panel' },
        { id: 'close-split', title: 'Close the conversation beside', category: 'View', icon: 'x', handler: 'closeSplit' },
      ],
    },
  },
  components: { AgentsPanel, AgentsPage, ProposalCard, LinkCard, ChapterDivider },
  handlers: {
    panel: () => {
      const r = useApp.getState().route;
      if (r.view !== 'core.chat:session' || !r.params?.id) { navigate({ view: 'core.agents:agents' }); return; }
      const p = useApp.getState().panel;
      if (p?.kind === 'plugin' && p.panel === 'core.agents:agents') useApp.setState({ panel: null });
      else openPluginPanel('core.agents:agents', { id: r.params.id });
    },
    closeSplit: () => useApp.setState({ split: null }),
  },
  activate: () => {
    watchLinkedNews();
    // The sidebar badge: linked sessions working now (started by an agent, not typed by the person).
    const set = () => useApp.getState().setBadge('core.agents.working', useData.getState().sessions.filter((s) => s.status === 'running' && s.parent).length);
    set();
    useData.subscribe((s, p) => { if (s.sessions !== p.sessions) set(); });
  },
};
