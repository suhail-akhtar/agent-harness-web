/**
 * What an agent sees of the window and may do in it (the desktop tools): the live registry as a
 * compact description (desktop_describe), and the checks before an agent opens something or runs
 * a command (desktop_open, desktop_command). Pure: unit-tested in test/desktop-agents-ui.test.ts.
 */

import { validateValue, type JsonSchema } from '@harness/plugin-ui';
import type { Registry } from './registry.ts';

export interface WindowNow { view: string; panel?: string | null; split?: string | null; sessionId?: string }

/**
 * The live registry for desktop_describe: enabled plugins, views, panels, agent-callable commands
 * (with their argument schemas), settings sections, renderers and themes, and what is on screen.
 * Compact on purpose (it is a tool result the model reads): ids and short titles only.
 */
export function describeForAgent(r: Registry, now: WindowNow, app?: { name: string; version: string }) {
  const titleOf = (name: string) => r.active.find((p) => p.name === name)?.ui?.displayName ?? name;
  return {
    ...(app ? { app: `${app.name} ${app.version}` } : {}),
    now: { view: now.view, ...(now.panel ? { panel: now.panel } : {}), ...(now.split ? { beside: now.split } : {}) },
    plugins: r.active.map((p) => ({ name: p.name, title: titleOf(p.name) })),
    off: r.plugins.filter((p) => !r.active.includes(p)).map((p) => p.name),
    views: [...r.views.values()].filter((v) => !/^onboard/.test(v.id)).map((v) => `${v.qid}${v.title ? ` (${v.title})` : ''}`),
    panels: [...r.panels.values()].map((p) => `${p.qid}${p.where === 'session' ? ' [conversation]' : ''}`),
    commands: r.commands.filter((c) => c.agent).map((c) => ({ id: c.qid, does: c.agent!.description, ...(c.agent!.inputSchema ? { args: c.agent!.inputSchema } : {}) })),
    settings: r.settings.map((s) => s.qid),
    renderers: { fence: [...r.renderers.fence.keys()], artifact: [...r.renderers.artifact.keys()], tool: [...r.renderers.tool.keys()], event: [...r.renderers.event.keys()] },
    themes: ['light', 'dark', 'system', ...r.themes.map((t) => t.qid)],
  };
}

/** Why an agent may not run this command with these args (undefined: it may). The server checked too; the app checks again. */
export function commandRefusal(r: Registry, id: string, args: unknown): string | undefined {
  const cmd = r.commands.find((c) => c.qid === id);
  if (!cmd) return `No command ${id} in the app now (its plugin may be off). desktop_describe lists the agent-callable ones.`;
  if (!cmd.agent) return `${id} is not agent-callable: its plugin does not mark it "agent". Ask the person to run it.`;
  const problems = cmd.agent.inputSchema ? validateValue(cmd.agent.inputSchema as JsonSchema, args ?? {}, 'args') : (args && typeof args === 'object' && Object.keys(args).length ? ['args: this command takes none'] : []);
  return problems.length ? `Invalid args for ${id}: ${problems.slice(0, 8).join('; ')}` : undefined;
}

export type OpenTarget =
  | { target: 'view'; view: string; params?: Record<string, string> }
  | { target: 'panel'; panel: string; params?: Record<string, string> }
  | { target: 'file'; path: string }
  | { target: 'artifact'; id: string }
  | { target: 'url'; url: string };

/** Reads desktop_open's input into what to open, or the reason it cannot be (a view or panel resolved against the registry; only http(s) URLs). */
export function resolveOpen(r: Registry, input: Record<string, unknown>): OpenTarget | { error: string } {
  const target = String(input.target ?? '');
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
    ? Object.fromEntries(Object.entries(input.params as Record<string, unknown>).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, String(v)]))
    : undefined;
  const find = <T extends { qid: string; id: string }>(list: T[], want: string): T | undefined => list.find((x) => x.qid === want) ?? (want.includes(':') ? undefined : list.filter((x) => x.id === want).length === 1 ? list.find((x) => x.id === want) : undefined);
  switch (target) {
    case 'view': {
      const want = str('id') || str('view');
      const v = find([...r.views.values()], want) ?? (() => { const n = r.navItems.find((x) => x.qid === want); return n ? r.views.get(n.view) : undefined; })();
      if (!v) return { error: `No view "${want}". Views: ${[...r.views.keys()].filter((k) => !/:onboard/.test(k)).slice(0, 30).join(', ')}` };
      return { target: 'view', view: v.qid, ...(params ? { params } : {}) };
    }
    case 'panel': {
      const want = str('id') || str('panel');
      const p = find([...r.panels.values()], want);
      if (!p) return { error: `No panel "${want}". Panels: ${[...r.panels.keys()].join(', ') || 'none'}` };
      return { target: 'panel', panel: p.qid, ...(params ? { params } : {}) };
    }
    case 'file': {
      const p = str('path');
      if (!p) return { error: 'desktop_open file needs path (a file in this conversation\'s workspace)' };
      return { target: 'file', path: p };
    }
    case 'artifact': {
      const id = str('id');
      if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(id)) return { error: 'desktop_open artifact needs id (as the artifact tool gave it)' };
      return { target: 'artifact', id };
    }
    case 'url': {
      const url = str('url');
      let u: URL;
      try { u = new URL(url); } catch { return { error: 'desktop_open url needs a full http(s) URL' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http(s) URLs are opened (in the system browser).' };
      return { target: 'url', url: u.toString() };
    }
    default: return { error: 'target is view, panel, file, artifact or url' };
  }
}
