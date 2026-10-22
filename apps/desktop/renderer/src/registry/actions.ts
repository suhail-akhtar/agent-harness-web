/**
 * Running what a contribution says to do: a command, a slash command, a prompt chip, a status item,
 * a form's submit. Every action type of the contract; none sends anything without the person.
 */

import { qualify, type UiAction } from '@harness/plugin-ui';
import { toast } from '@harness/ui';
import { navigate, prefill, useApp } from '../state/app';
import { client, useData } from '../state/data';
import { desktop } from '../bridge';

export async function runAction(action: UiAction, plugin: string, args?: unknown): Promise<void> {
  const text = typeof args === 'string' ? args : '';
  switch (action.type) {
    case 'prompt': prefill(action.prompt.replace(/\{args\}/g, text).trim(), action.newChat); return;
    case 'open-view': navigate({ view: qualify(plugin, action.view), ...(action.params ? { params: action.params } : {}) }); return;
    case 'open-panel': useApp.setState({ panel: { kind: 'plugin', panel: qualify(plugin, action.panel) } }); return;
    case 'open-url':
    case 'browse': await desktop.openExternal(action.url).catch((e: Error) => toast(e.message, { kind: 'error' })); return;
    case 'terminal': {
      // There is no terminal in this edition: the command is shown, never run unseen.
      const ok = await useApp.getState().ask({ title: `${plugin} suggests a command`, body: `${action.command}${action.cwd ? `\n\nin ${action.cwd}` : ''}\n\nThere is no terminal plugin here; copy it to run it yourself.`, confirmLabel: 'Copy command' });
      if (ok) { await navigator.clipboard.writeText(action.command).catch(() => desktop.clipboard(action.command)); toast('Command copied'); }
      return;
    }
    case 'workflow': {
      const route = useApp.getState().route;
      useApp.setState({ workflowDialog: { sessionId: route.view === 'core.chat:session' ? route.params?.id : undefined, workflow: action.workflow, input: { ...(action.input ?? {}), ...(text ? { request: text } : {}) } } });
      return;
    }
    case 'command': await runCommand(qualify(plugin, action.command), action.args ?? args); return;
    case 'theme': useApp.getState().setPrefs({ theme: ['light', 'dark', 'system'].includes(action.theme) ? action.theme : qualify(plugin, action.theme) }); return;
    case 'route': {
      try {
        const r = await client.plugins.route<unknown>(plugin, action.path, action.method ?? 'GET', action.body ?? args);
        const msg = typeof r === 'string' ? r : r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : JSON.stringify(r);
        toast(msg?.slice(0, 280) || 'Done', { source: plugin });
      } catch (e) { toast((e as Error).message, { kind: 'error', source: plugin }); }
      return;
    }
  }
}

/** Runs a command by its qualified id ("<plugin>:<id>"). */
export async function runCommand(qid: string, args?: unknown): Promise<void> {
  const { registry } = useData.getState();
  const cmd = registry.commands.find((c) => c.qid === qid);
  if (!cmd) { toast(`No command ${qid}`, { kind: 'warning' }); return; }
  if (cmd.action) return runAction(cmd.action, cmd.plugin, args);
  const entry = registry.active.find((p) => p.name === cmd.plugin);
  const fn = cmd.handler ? entry?.native?.handlers?.[cmd.handler] : undefined;
  if (!fn) { toast(`${cmd.title} is not available`, { kind: 'warning' }); return; }
  try { await fn(args); } catch (e) { toast((e as Error).message, { kind: 'error' }); }
}
