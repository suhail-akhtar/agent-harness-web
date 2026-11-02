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
import { RecordPanel } from './Record';
import { AgentsPage, watchLinkedNews } from './Page';
import { ChapterDivider, LinkCard, ProposalCard } from './Cards';
import { AgentsHome } from './Home';
import { useAgentEditor, YourAgents } from './Mine';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

export const coreAgents: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { AgentsHome, AgentsPanel, RecordPanel, AgentsPage, YourAgents, ProposalCard, LinkCard, ChapterDivider },
  handlers: {
    panel: () => {
      const r = useApp.getState().route;
      if (r.view !== 'core.chat:session' || !r.params?.id) { navigate({ view: 'core.agents:agents' }); return; }
      const p = useApp.getState().panel;
      if (p?.kind === 'plugin' && p.panel === 'core.agents:agents') useApp.setState({ panel: null });
      else openPluginPanel('core.agents:agents', { id: r.params.id });
    },
    closeSplit: () => useApp.setState({ split: null }),
    // The run record beside the conversation: whether it verifies, and its steps.
    record: () => {
      const r = useApp.getState().route;
      if (r.view !== 'core.chat:session' || !r.params?.id) return;
      const p = useApp.getState().panel;
      if (p?.kind === 'plugin' && p.panel === 'core.agents:record') useApp.setState({ panel: null });
      else openPluginPanel('core.agents:record', { id: r.params.id });
    },
    // Prefilled from the command's arguments (an agent's proposal): the person checks it and saves.
    newAgent: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const tools = Array.isArray(a.tools) ? a.tools.filter((t): t is string => typeof t === 'string') : undefined;
      const mode = ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'].includes(String(a.permissionMode)) ? a.permissionMode as 'plan' : undefined;
      navigate({ view: 'core.agents:mine' });
      useAgentEditor.getState().open({ draft: { ...(str(a.name) ? { name: str(a.name) } : {}), ...(str(a.description) ? { description: str(a.description) } : {}), ...(str(a.prompt) ? { prompt: str(a.prompt) } : {}), ...(tools?.length ? { tools } : {}), ...(str(a.model) ? { model: str(a.model) } : {}), ...(mode ? { permissionMode: mode } : {}) } });
    },
  },
  activate: () => {
    watchLinkedNews();
    // The sidebar badge: linked sessions working now (started by an agent, not typed by the person).
    const set = () => useApp.getState().setBadge('core.agents.working', useData.getState().sessions.filter((s) => s.status === 'running' && s.parent).length);
    set();
    useData.subscribe((s, p) => { if (s.sessions !== p.sessions) set(); });
  },
};
