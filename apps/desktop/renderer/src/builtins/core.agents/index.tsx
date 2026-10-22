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
import { AgentsHome } from './Home';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

export const coreAgents: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { AgentsHome, AgentsPanel, AgentsPage, ProposalCard, LinkCard, ChapterDivider },
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
