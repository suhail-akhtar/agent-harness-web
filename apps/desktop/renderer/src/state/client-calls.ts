/**
 * The desktop tools, answered for real: an agent in a conversation this window is attached to asks
 * the app to describe itself, open something, notify the person or run an agent-callable command.
 * Each answer is the tool's result; a refusal is an error with what to do instead.
 */

import { toast } from '@harness/ui';
import { useApp, navigate, openPluginPanel } from './app';
import { client, useData, type ClientCallHandler } from './data';
import { desktop } from '../bridge';
import { runCommand } from '../registry/actions';
import { commandRefusal, describeForAgent, describePlugin, resolveOpen } from '../registry/agent-surface';

function now(sessionId: string) {
  const s = useApp.getState();
  return { view: s.route.view, panel: s.panel?.kind === 'plugin' ? s.panel.panel : s.panel?.kind ?? null, split: s.split?.view ?? null, sessionId };
}

const titleOf = (sessionId: string) => useData.getState().sessions.find((s) => s.id === sessionId)?.title ?? 'A conversation';

export const handleClientCall: ClientCallHandler = async (sessionId, tool, input) => {
  const { registry } = useData.getState();
  switch (tool) {
    case 'desktop_describe': {
      const info = useApp.getState().info;
      // {plugin}: one plugin in depth; {plugin, guide: true}: its whole guide (the server's skill <plugin>-guide asks for it).
      if (typeof input.plugin === 'string' && input.plugin.trim()) return { result: describePlugin(registry, input.plugin.trim(), { guide: input.guide === true }) };
      return { result: describeForAgent(registry, now(sessionId), info ? { name: info.product.name, version: info.version } : undefined) };
    }
    case 'desktop_open': {
      const t = resolveOpen(registry, input);
      if ('error' in t) throw new Error(t.error);
      switch (t.target) {
        case 'view': navigate({ view: t.view, ...(t.params ? { params: t.params } : {}) }); return { result: `Opened ${t.view}${t.params?.plugin && t.view === 'core.shell:plugin-home' ? ` (the home of ${t.params.plugin})` : ''}.` };
        case 'panel': {
          const def = registry.panels.get(t.panel)!;
          // A conversation's panel opens on the conversation that asked (unless the agent named another).
          openPluginPanel(t.panel, { ...(def.where === 'session' ? { id: sessionId } : {}), ...(t.params ?? {}) });
          return { result: `Opened the ${def.title} panel.` };
        }
        case 'file': {
          const f = await client.files.read(sessionId, t.path).catch((e: Error) => { throw new Error(`Could not read ${t.path}: ${e.message}`); });
          if (f.content === null) throw new Error(`${t.path} cannot be shown (${f.note ?? 'not text'}).`);
          useApp.setState({ panel: { kind: 'file', title: t.path.split(/[\\/]/).pop() ?? t.path, path: t.path, sessionId, content: f.content } });
          return { result: `Showing ${t.path}.` };
        }
        case 'artifact': {
          const list = await client.artifacts.list(sessionId);
          const a = list.find((x) => x.id === t.id);
          if (!a) throw new Error(`No artifact ${t.id} in this conversation (artifact list shows them).`);
          if (!registry.panels.has('core.artifacts:artifacts')) throw new Error('The Artifacts plugin is off in the app.');
          openPluginPanel('core.artifacts:artifacts', { id: sessionId, artifact: t.id });
          return { result: `Showing artifact "${a.title}" (v${a.version}).` };
        }
        case 'url': {
          await desktop.openExternal(t.url).catch((e: Error) => { throw new Error(`The system browser did not open it: ${e.message}`); });
          return { result: `Opened ${t.url} in the system browser.` };
        }
      }
      break;
    }
    case 'desktop_notify': {
      const title = String(input.title ?? '').slice(0, 120) || 'From your agent';
      const body = String(input.body ?? '').slice(0, 1000);
      toast(title, { kind: 'info', ...(body ? { detail: body } : {}), source: titleOf(sessionId), action: { label: 'Open', run: () => navigate({ view: 'core.chat:session', params: { id: sessionId } }) } });
      const shown = await desktop.notify({ title, body, route: `core.chat:session?id=${sessionId}`, force: true });
      return { result: shown ? 'Shown as a notification and in the app.' : 'Shown in the app (system notifications are off or unavailable).' };
    }
    case 'desktop_command': {
      const id = String(input.command ?? '');
      const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {};
      const why = commandRefusal(registry, id, args);
      if (why) throw new Error(why);
      const out = await runCommand(id, args, { throwErrors: true });
      return { result: out === undefined || out === null ? `Ran ${id}.` : typeof out === 'string' ? out : out };
    }
  }
  throw new Error(`${tool} is not a desktop tool this app serves`);
};
