/**
 * The smaller built-in plugins:
 *  - core.shell: the window's own commands (palette, back/forward, sidebar, themes, setup), so even
 *    these go through the registry and are rebindable;
 *  - core.projects: open a folder, the project list, a project's conversations;
 *  - core.inbox: "Waiting for you", every pending request across conversations;
 *  - core.activity: what is running (conversations and their background tasks), with Stop.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { SessionMeta, TaskView } from '@harness/client';
import { Badge, Button, EmptyState, Icon, IconButton, Spinner, toast, cx } from '@harness/ui';
import type { BuiltinPlugin } from '../state/data';
import { useData, client } from '../state/data';
import { useApp, navigate, openSession, setCrumb, NARROW_PX } from '../state/app';
import { desktop } from '../bridge';
import { PendingCard, respondFor } from '../components/Pending';
import { fmtCost } from './core.chat/Transcript';

// ---------------- core.shell ----------------

export const coreShell: BuiltinPlugin = {
  name: 'core.shell', version: '0.1.0', description: 'The window\'s own commands: palette, navigation, sidebar, themes.',
  ui: {
    apiVersion: 1, displayName: 'Shell', icon: 'command', trust: 'native', capabilities: [], required: true,
    contributes: {
      commands: [
        { id: 'palette', title: 'Command palette', category: 'View', icon: 'command', keybinding: 'Mod+K', handler: 'palette' },
        { id: 'palette-alt', title: 'Command palette (alternative)', category: 'View', icon: 'command', keybinding: 'Mod+Shift+P', handler: 'palette' },
        { id: 'back', title: 'Go back', category: 'View', icon: 'arrow-left', keybinding: 'Alt+Left', handler: 'back' },
        { id: 'forward', title: 'Go forward', category: 'View', icon: 'arrow-right', keybinding: 'Alt+Right', handler: 'forward' },
        { id: 'sidebar', title: 'Toggle the sidebar', category: 'View', icon: 'sidebar', keybinding: 'Mod+B', handler: 'sidebar' },
        { id: 'close-panel', title: 'Close the side panel', category: 'View', icon: 'panel-right', handler: 'closePanel' },
        { id: 'theme-light', title: 'Light theme', category: 'Theme', icon: 'sun', action: { type: 'theme', theme: 'light' } },
        { id: 'theme-dark', title: 'Dark theme', category: 'Theme', icon: 'moon', action: { type: 'theme', theme: 'dark' } },
        { id: 'theme-system', title: 'Follow the system theme', category: 'Theme', icon: 'monitor', action: { type: 'theme', theme: 'system' } },
        {
          id: 'set-theme', title: 'Switch theme…', category: 'Theme', icon: 'palette', handler: 'setTheme',
          agent: { description: 'Switch the app\'s theme: light, dark, system, or a plugin theme id from desktop_describe.', inputSchema: { type: 'object', properties: { theme: { type: 'string', description: 'light, dark, system or a theme id', maxLength: 80 } }, required: ['theme'] } },
        },
        {
          id: 'open-view', title: 'Open a page…', category: 'View', icon: 'arrow-right', handler: 'openView',
          agent: { description: 'Show a page of the app (a view id from desktop_describe, e.g. core.artifacts:library).', inputSchema: { type: 'object', properties: { view: { type: 'string', maxLength: 140 } }, required: ['view'] } },
        },
        { id: 'shortcuts', title: 'Keyboard shortcuts', category: 'Help', icon: 'keyboard', keybinding: 'Mod+/', handler: 'shortcuts' },
        { id: 'setup', title: 'Set up (welcome wizard)', category: 'Help', icon: 'sparkles', handler: 'setup' },
        { id: 'reload-plugins', title: 'Reload plugins', category: 'Plugins', icon: 'refresh', handler: 'reloadPlugins' },
      ],
      themes: [
        { id: 'paper', label: 'Paper', mode: 'light', background: '#f7f3ea', foreground: '#2b2722', accent: '#b4532a' },
        { id: 'midnight', label: 'Midnight', mode: 'dark', background: '#0f1420', foreground: '#dfe6f3', accent: '#6c9cff' },
      ],
    },
  },
  components: {},
  handlers: {
    palette: () => useApp.setState({ paletteOpen: !useApp.getState().paletteOpen }),
    back: () => useApp.getState().goBack(),
    forward: () => useApp.getState().goForward(),
    // A narrow window floats the sidebar over the page (its own state); a wide one collapses it to a rail (a preference).
    sidebar: () => { if (window.innerWidth < NARROW_PX) { useApp.setState({ narrowSidebarOpen: !useApp.getState().narrowSidebarOpen }); return; } const p = useApp.getState().prefs; useApp.getState().setPrefs({ sidebar: { ...p.sidebar, collapsed: !p.sidebar.collapsed } }); },
    closePanel: () => useApp.setState({ panel: null }),
    shortcuts: () => useApp.setState({ shortcutsOpen: !useApp.getState().shortcutsOpen }),
    setTheme: (args) => {
      const theme = String((args as { theme?: unknown } | undefined)?.theme ?? '').trim();
      const known = ['light', 'dark', 'system', ...useData.getState().registry.themes.map((t) => t.qid)];
      if (!known.includes(theme)) throw new Error(`No theme "${theme}". Themes: ${known.join(', ')}`);
      useApp.getState().setPrefs({ theme });
      return `Theme set to ${theme}.`;
    },
    openView: (args) => {
      const view = String((args as { view?: unknown } | undefined)?.view ?? '').trim();
      if (!useData.getState().registry.views.has(view)) throw new Error(`No page ${view}. desktop_describe lists the views.`);
      navigate({ view });
      return `Opened ${view}.`;
    },
    setup: () => useApp.setState({ onboardingOpen: true }),
    reloadPlugins: async () => { await useData.getState().refreshPlugins(); toast('Plugins reloaded'); },
  },
};

// ---------------- core.projects ----------------

async function openFolder() {
  const dir = await desktop.openFolder('Open a project folder').catch((e: Error) => { toast(e.message, { kind: 'error' }); return null; });
  if (!dir) return;
  await desktop.addProject(dir);
  navigate({ view: 'core.projects:project', params: { path: dir } });
}

/** A new project made by the app: a folder of its own in the harness home's workspaces. */
function NewProject({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { const r = await desktop.createProject(name); toast(`Created ${r.path}`, { kind: 'success' }); onDone(); navigate({ view: 'core.projects:project', params: { path: r.path } }); }
    catch (e) { toast((e as Error).message, { kind: 'error' }); setBusy(false); }
  };
  return (
    <form className="mb-5 flex items-center gap-2 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3" data-new-project-form onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <Icon name="folder-plus" size={16} className="text-hx-muted" />
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" aria-label="Project name" data-new-project-name className="h-8 min-w-0 flex-1 rounded-lg border border-hx-border bg-hx-bg px-2 text-[13px] outline-none focus:border-hx-accent" />
      <span className="hidden text-[11.5px] text-hx-muted sm:inline">in the harness home's workspaces</span>
      <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!name.trim()}>Create</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
    </form>
  );
}

function Projects() {
  const projects = useApp((s) => s.prefs.projects);
  const sessions = useData((s) => s.sessions);
  const [making, setMaking] = useState(false);
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-projects>
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-5 flex items-center gap-3"><h1 className="flex-1 text-[20px] font-semibold">Projects</h1><Button icon="plus" onClick={() => setMaking(true)} data-new-project>New project</Button><Button variant="primary" icon="folder-plus" onClick={() => void openFolder()}>Open a folder</Button></div>
        {making && <NewProject onDone={() => setMaking(false)} />}
        {!projects.length ? <EmptyState icon="folder" title="No projects yet" action={<Button variant="primary" icon="folder-plus" onClick={() => void openFolder()}>Open a folder</Button>}>Open a folder and the agent can work in it. Each conversation started there runs in that folder.</EmptyState> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => {
              const n = sessions.filter((s) => s.runtime?.path === p.path).length;
              return (
                <button key={p.path} type="button" data-project={p.path} onClick={() => navigate({ view: 'core.projects:project', params: { path: p.path } })} className="flex items-start gap-3 rounded-xl border border-hx-border-subtle bg-hx-elevated p-4 text-left hover:border-hx-border">
                  <Icon name="folder" size={20} className="text-hx-accent-text" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{p.name}</span><span className="block truncate text-[11.5px] text-hx-muted">{p.path}</span><span className="mt-1 block text-[12px] text-hx-secondary">{n} conversation{n === 1 ? '' : 's'}</span></span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Project({ params }: { params: Record<string, string> }) {
  const path = params.path ?? '';
  const project = useApp((s) => s.prefs.projects.find((p) => p.path === path));
  const sessions = useData((s) => s.sessions);
  const mine = useMemo(() => sessions.filter((s) => s.runtime?.path === path || (s.runtime?.path ?? '').startsWith(`${path}\\`) || (s.runtime?.path ?? '').startsWith(`${path}/`)), [sessions, path]);
  useEffect(() => { if (project) setCrumb({ view: 'core.projects:project', title: project.name }); }, [project?.name]);
  if (!project) return <EmptyState icon="folder" title="This project is not in your list" action={<Button onClick={() => navigate({ view: 'core.projects:projects' })}>All projects</Button>} />;
  const newChat = () => { try { localStorage.setItem('harness.workIn', path); } catch { /* none */ } navigate({ view: 'core.chat:home' }); };
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-project-view={path}>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-3">
          <Icon name="folder-open" size={22} className="text-hx-accent-text" />
          <div className="min-w-0 flex-1"><h1 className="truncate text-[20px] font-semibold">{project.name}</h1><div className="truncate text-[12px] text-hx-muted">{path}</div></div>
          <Button icon="external" variant="ghost" onClick={() => void desktop.showItem(path)}>Show</Button>
          <Button variant="primary" icon="edit" onClick={newChat}>New chat here</Button>
        </div>
        <h2 className="mb-2 mt-6 text-[13px] font-medium text-hx-muted">Conversations</h2>
        {!mine.length ? <p className="text-[13px] text-hx-muted">No conversations in this folder yet.</p> : (
          <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
            {mine.map((s) => <SessionLine key={s.id} s={s} />)}
          </div>
        )}
        <div className="mt-8"><Button variant="ghost" icon="trash" onClick={() => void useApp.getState().ask({ title: 'Remove this project?', body: 'It leaves the list; the folder and its conversations stay.', confirmLabel: 'Remove' }).then(async (y) => { if (y) { await desktop.removeProject(path); navigate({ view: 'core.projects:projects' }); } })}>Remove from projects</Button></div>
      </div>
    </div>
  );
}

function SessionLine({ s }: { s: SessionMeta }) {
  return (
    <button type="button" onClick={() => openSession(s.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-hx-hover">
      <Icon name="chat" size={15} className="text-hx-muted" />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{s.title || 'New conversation'}</span>
      {s.status && s.status !== 'idle' && <Badge tone={s.status === 'waiting' ? 'warning' : 'accent'}>{s.status === 'waiting' ? 'Needs you' : 'Working'}</Badge>}
      <span className="text-[11.5px] text-hx-muted">{new Date(s.updatedAt).toLocaleDateString()}</span>
    </button>
  );
}

function OnboardFolder() {
  const projects = useApp((s) => s.prefs.projects);
  return (
    <div className="px-6 py-6">
      <p className="text-[13px] text-hx-secondary">The agent works inside a folder you choose. You can also start in a scratch space and add folders later.</p>
      <Button className="mt-4" variant="primary" icon="folder-plus" onClick={() => void desktop.openFolder('Open a project folder').then(async (d) => { if (d) { await desktop.addProject(d); toast(`Added ${d}`); } })}>Open a folder</Button>
      {projects.length > 0 && <ul className="mt-4 space-y-1">{projects.map((p) => <li key={p.path} className="flex items-center gap-2 text-[13px]"><Icon name="check" size={14} className="text-hx-success" />{p.path}</li>)}</ul>}
    </div>
  );
}

export const coreProjects: BuiltinPlugin = {
  name: 'core.projects', version: '0.1.0', description: 'Folders the agent works in, and their conversations.',
  ui: {
    apiVersion: 1, displayName: 'Projects', icon: 'folder', trust: 'native', capabilities: [],
    contributes: {
      navItems: [{ id: 'projects', title: 'Projects', icon: 'folder', view: 'projects', order: 40 }],
      views: [
        { id: 'projects', title: 'Projects', kind: 'native', component: 'Projects' },
        { id: 'project', title: 'Project', kind: 'native', component: 'Project' },
        { id: 'onboard-folder', title: 'Open a folder', kind: 'native', component: 'OnboardFolder' },
      ],
      commands: [{ id: 'open-folder', title: 'Open a folder…', category: 'Projects', icon: 'folder-plus', keybinding: 'Mod+O', handler: 'openFolder' }],
      onboarding: [{ id: 'folder', title: 'Open a folder to work in', description: 'Optional: a project the agent may read and change.', view: 'onboard-folder', order: 30 }],
    },
  },
  components: { Projects, Project, OnboardFolder },
  handlers: { openFolder },
};

// ---------------- core.inbox ----------------

function Inbox() {
  const approvals = useData((s) => s.approvals);
  const sessions = useData((s) => s.sessions);
  const groups = useMemo(() => {
    const by = new Map<string, typeof approvals>();
    for (const a of approvals) by.set(a.sessionId, [...(by.get(a.sessionId) ?? []), a]);
    return [...by.entries()];
  }, [approvals]);
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-inbox>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-5 flex items-center gap-3"><h1 className="flex-1 text-[20px] font-semibold">Waiting for you</h1><IconButton icon="refresh" label="Refresh" onClick={() => void useData.getState().refreshApprovals()} /></div>
        {!groups.length ? <EmptyState icon="inbox" title="Nothing is waiting for you">Permission requests, questions, plans and workflow approvals from every conversation land here.</EmptyState> : groups.map(([sid, list]) => (
          <section key={sid} className="mb-6" data-inbox-session={sid}>
            <button type="button" onClick={() => openSession(sid)} className="mb-2 flex items-center gap-2 text-[13px] font-medium text-hx-secondary hover:text-hx-primary"><Icon name="chat" size={14} />{list[0]!.title ?? sessions.find((s) => s.id === sid)?.title ?? sid}<Icon name="arrow-right" size={13} /></button>
            <div className="space-y-2">{list.map((a) => <InboxItem key={a.requestId} a={a} />)}</div>
          </section>
        ))}
      </div>
    </div>
  );
}

function InboxItem({ a }: { a: import('@harness/client').Approval }) {
  const [full, setFull] = useState(a.request);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!full) client.fullRequest(a).then((r) => (r ? setFull(r) : setFailed(true))).catch(() => setFailed(true)); }, [a.requestId]);
  if (full) return <PendingCard p={full} respond={respondFor(a.sessionId)} />;
  return <div className="flex items-center gap-2 rounded-xl border border-hx-border-subtle p-3 text-[13px] text-hx-secondary">{failed ? <Icon name="warning" size={14} /> : <Spinner />}<span className="flex-1">{a.summary ?? a.kind}</span><Button size="sm" onClick={() => openSession(a.sessionId)}>Open</Button></div>;
}

function AttentionCard() {
  const approvals = useData((s) => s.approvals);
  if (!approvals.length) return <p className="text-[12.5px] text-hx-muted">Nothing is waiting for you.</p>;
  return (
    <div className="space-y-1">
      {approvals.slice(0, 5).map((a) => <button key={a.requestId} type="button" onClick={() => openSession(a.sessionId)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] hover:bg-hx-hover"><Icon name={a.kind === 'question' ? 'help' : 'shield'} size={14} className="text-hx-warning" /><span className="min-w-0 flex-1 truncate">{a.summary ?? a.tool ?? a.kind}</span><span className="max-w-[40%] truncate text-[11px] text-hx-muted">{a.title}</span></button>)}
      {approvals.length > 5 && <button type="button" className="px-1.5 text-[12px] text-hx-accent-text" onClick={() => navigate({ view: 'core.inbox:inbox' })}>All {approvals.length}</button>}
    </div>
  );
}

export const coreInbox: BuiltinPlugin = {
  name: 'core.inbox', version: '0.1.0', description: 'Everything waiting for you, across conversations.',
  ui: {
    apiVersion: 1, displayName: 'Inbox', icon: 'inbox', trust: 'native', capabilities: [],
    contributes: {
      navItems: [{ id: 'inbox', title: 'Inbox', icon: 'inbox', view: 'inbox', order: 10, badge: 'core.inbox.pending' }],
      views: [{ id: 'inbox', title: 'Waiting for you', kind: 'native', component: 'Inbox' }],
      homeCards: [{ id: 'attention', title: 'Waiting for you', kind: 'native', component: 'AttentionCard', order: 10 }],
      statusItems: [{ id: 'pending', text: '{core.inbox.pending} waiting', tooltip: 'Requests waiting for you', command: 'open', order: 10 }],
      commands: [{ id: 'open', title: 'Open the inbox', category: 'Inbox', icon: 'inbox', keybinding: 'Mod+Shift+I', action: { type: 'open-view', view: 'inbox' } }],
    },
  },
  components: { Inbox, AttentionCard },
  activate: () => {
    const set = () => useApp.getState().setBadge('core.inbox.pending', useData.getState().approvals.length);
    set();
    useData.subscribe((s, p) => { if (s.approvals !== p.approvals) set(); });
  },
};

// ---------------- core.activity ----------------

function Activity() {
  const sessions = useData((s) => s.sessions);
  const active = sessions.filter((s) => s.status === 'running' || s.status === 'waiting');
  const [tasks, setTasks] = useState<Record<string, TaskView[]>>({});
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all(active.map(async (s) => [s.id, await client.sessions.tasks(s.id).catch(() => [])] as const)).then((r) => { if (alive) setTasks(Object.fromEntries(r)); });
    void load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [active.map((s) => s.id).join(',')]);
  const stop = (id: string) => void client.sessions.abort(id).then(() => toast('Stopped')).catch((e: Error) => toast(e.message, { kind: 'error' }));
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-activity>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="mb-5 text-[20px] font-semibold">Activity</h1>
        {!active.length ? <EmptyState icon="activity" title="Nothing is running">Conversations at work, and their background shells, sub-agents and workflow runs, show here.</EmptyState> : active.map((s) => (
          <div key={s.id} data-activity-session={s.id} className="mb-3 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3">
            <div className="flex items-center gap-2">
              {s.status === 'running' ? <Spinner className="text-hx-accent-text" /> : <Icon name="clock" size={15} className="text-hx-warning" />}
              <button type="button" onClick={() => openSession(s.id)} className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium hover:underline">{s.title || 'Conversation'}</button>
              <Badge tone={s.status === 'waiting' ? 'warning' : 'accent'}>{s.status === 'waiting' ? 'Needs you' : 'Working'}</Badge>
              <span className="text-[11.5px] text-hx-muted">{fmtCost(s.cost)}</span>
              <Button size="sm" variant="ghost" icon="stop" onClick={() => stop(s.id)}>Stop</Button>
            </div>
            {(tasks[s.id] ?? []).filter((t) => t.status === 'running').map((t) => (
              <div key={t.id} className="ml-6 mt-1.5 flex items-center gap-2 text-[12.5px] text-hx-secondary"><Icon name={t.kind === 'shell' ? 'terminal' : t.kind === 'workflow' ? 'workflow' : 'bot'} size={13} /><span className="min-w-0 flex-1 truncate">{t.description}</span><span className="text-[11px] text-hx-muted">{t.kind}</span></div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export const coreActivity: BuiltinPlugin = {
  name: 'core.activity', version: '0.1.0', description: 'What is running now, with Stop.',
  ui: {
    apiVersion: 1, displayName: 'Activity', icon: 'activity', trust: 'native', capabilities: [],
    contributes: {
      navItems: [{ id: 'activity', title: 'Activity', icon: 'activity', view: 'activity', order: 20, badge: 'core.activity.running' }],
      views: [{ id: 'activity', title: 'Activity', kind: 'native', component: 'Activity' }],
      statusItems: [{ id: 'running', text: '{core.activity.running} running', command: 'open', order: 20 }],
      commands: [{ id: 'open', title: 'Show activity', category: 'Activity', icon: 'activity', action: { type: 'open-view', view: 'activity' } }],
    },
  },
  components: { Activity },
  activate: () => {
    const set = () => useApp.getState().setBadge('core.activity.running', useData.getState().sessions.filter((s) => s.status === 'running').length);
    set();
    useData.subscribe((s, p) => { if (s.sessions !== p.sessions) set(); });
  },
};

export { cx };
