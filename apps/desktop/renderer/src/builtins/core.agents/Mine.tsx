/**
 * Your agents (core.agents:mine): the person's own agents and the ones the app and its plugins bring. Each is a
 * specialist with its role, instructions, model, tools, MCP servers, skills, autonomy and limits; the orchestrator
 * in any conversation can delegate to it, and the person can start a conversation with it. The builder makes or
 * changes one (Generate drafts it from a description: nothing is saved until Save), keeps its versions, and reads
 * and writes Claude Code's agent files (.claude/agents/<name>.md), which Cursor, VS Code and Copilot also read.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { AgentDef, AgentInfo, AgentOptions, AgentRecord, Effort } from '@harness/client';
import { Badge, Button, CheckboxGroup, EmptyState, Field, Icon, IconButton, Input, Menu, Modal, Page, Select, Switch, Textarea, Tooltip, cx, toast, type MenuItem, ChoiceGroup, Card, IconTile, Meta, Section, OptionCards, Callout } from '@harness/ui';
import { client, clientInfo, useData } from '../../state/data';
import { navigate, openSession, useApp } from '../../state/app';
import { scratchFolder, desktop } from '../../bridge';
import { create } from 'zustand';

const fail = (e: unknown) => toast((e as Error).message, { kind: 'error' });

/** The builder: closed, a new agent (maybe from a draft), or one of the person's to change. */
export const useAgentEditor = create<{ editing: AgentRecord | null; draft: Partial<AgentDef> | null; open: (o?: { edit?: AgentRecord; draft?: Partial<AgentDef> }) => void; close: () => void }>((set) => ({
  editing: null, draft: null,
  open: (o) => set({ editing: o?.edit ?? null, draft: o?.edit ? null : o?.draft ?? {} }),
  close: () => set({ editing: null, draft: null }),
}));

/** A conversation that runs as the agent (its model when it has one, else the app's default). */
export async function chatWith(a: Pick<AgentInfo, 'name' | 'model'>): Promise<void> {
  const prefs = useApp.getState().prefs;
  const models = useData.getState().models;
  const own = a.model && models.some((m) => m.id === a.model && m.available);
  const s = await client.sessions.create({ agent: a.name, title: a.name, ...(own ? {} : prefs.defaultModel ? { model: prefs.defaultModel } : {}), mode: (prefs.defaultMode || 'default') as never, runtime: 'local', path: await scratchFolder(), client: clientInfo() });
  useData.getState().upsertSession(s);
  openSession(s.id);
}

const MODES: Array<{ id: '' | NonNullable<AgentDef['permissionMode']>; label: string; help: string }> = [
  { id: '', label: 'As the conversation', help: 'It works with the permissions of the conversation it runs in.' },
  { id: 'plan', label: 'Read only', help: 'It reads and plans; anything that changes something waits for you.' },
  { id: 'default', label: 'Ask me', help: 'It asks before edits and commands.' },
  { id: 'auto', label: 'A checker decides', help: 'A checking model approves safe steps; the rest wait for you.' },
  { id: 'acceptEdits', label: 'Edits are fine', help: 'It edits files freely and asks before commands (never more than the conversation allows).' },
  { id: 'dontAsk', label: 'Never ask', help: 'What would need your approval is refused: it never interrupts you.' },
];
const KIND_LABEL: Record<string, string> = { read: 'Read and search', edit: 'Change files', exec: 'Run commands', network: 'The web', external: 'Outside services', meta: 'Agents, tasks and the app' };

function AgentCard({ a, onEdit, reload }: { a: AgentInfo; onEdit?: () => void; reload: () => void }) {
  const mine = a.source === 'user';
  const rec = a as AgentRecord;
  const menu: MenuItem[] = mine ? [
    { id: 'edit', label: 'Edit', icon: 'edit', onSelect: () => onEdit?.() },
    { id: 'export', label: 'Save as an agent file…', icon: 'download', onSelect: () => void client.agents.export(a.name).then((text) => desktop.saveText(`${a.name}.md`, text, 'md')).catch(fail) },
    { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => void useApp.getState().ask({ title: `Delete ${a.name}?`, body: 'The agent and its earlier versions go. Conversations that used it keep what it did.', confirmLabel: 'Delete', danger: true }).then((yes) => { if (yes) void client.agents.remove(a.name).then(reload).catch(fail); }) },
  ] : [];
  const tools = a.tools ? `${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}` : 'all tools';
  return (
    <Card data-agent-card={a.name} data-agent-source={a.source} className="flex flex-col" muted={mine && rec.enabled === false}>
      <div className="flex items-start gap-2.5">
        <IconTile icon="bot" tone={a.source === 'user' ? 'accent' : 'neutral'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5"><span className="truncate text-body font-semibold">{a.name}</span>
            {a.source !== 'user' && <Badge>{a.source === 'builtin' ? 'built in' : a.plugin ?? 'plugin'}</Badge>}
            {mine && <span className="text-tiny text-hx-muted">v{rec.version}</span>}
          </div>
          <p className="mt-0.5 line-clamp-2 text-small text-hx-secondary">{a.description}</p>
        </div>
        {mine && <Tooltip label={rec.enabled ? 'On: in your conversations' : 'Off: in none'}><Switch checked={rec.enabled} label={`${a.name}: ${rec.enabled ? 'on' : 'off'}`} onChange={(v) => void client.agents.update(a.name, { enabled: v }).then(reload).catch(fail)} /></Tooltip>}
      </div>
      <Meta className="mt-2.5" data-agent-facts items={[
        a.model ?? "the conversation's model", tools,
        a.mcpServers?.length ? `MCP: ${a.mcpServers.join(', ')}` : null,
        a.skills?.length ? `skills: ${a.skills.join(', ')}` : null,
        a.permissionMode ? MODES.find((m) => m.id === a.permissionMode)?.label.toLowerCase() : null,
        a.background ? 'background' : null, a.isolation ? 'own worktree' : null,
        a.modelInvocable === false ? 'only you start it' : null,
      ]} />
      <div className="mt-3 flex items-center gap-1.5 border-t border-hx-border-subtle pt-3">
        {a.userInvocable !== false && (!mine || rec.enabled) && <Button size="sm" icon="chat" onClick={() => void chatWith(a).catch(fail)} data-agent-chat>Chat</Button>}
        {mine && <Button size="sm" variant="ghost" icon="edit" onClick={onEdit} data-agent-edit>Edit</Button>}
        <span className="flex-1" />
        {mine && <Menu items={menu} trigger={({ ref, toggle }) => <IconButton ref={ref} size="sm" icon="more" label="More" onClick={toggle} data-agent-more />} />}
      </div>
    </Card>
  );
}

/** The person's agents and the others, with New, Import and the builder. */
export function YourAgents({ embedded }: { embedded?: boolean }): React.ReactElement {
  const [list, setList] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState('');
  const editing = useAgentEditor((x) => x.editing);
  const draft = useAgentEditor((x) => x.draft);
  const reload = () => client.agents.list().then((l) => { setList(l); setError(''); }).catch((e: Error) => setError(e.message));
  useEffect(() => { void reload(); }, []);
  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.md,text/markdown'; input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        try { const r = await client.agents.import(await f.text(), f.name.replace(/\.(agent\.)?md$/i, '')); toast(`Imported ${r.name} (version ${r.version})`, { kind: 'success' }); } catch (e) { fail(e); }
      }
      void reload();
    };
    input.click();
  };
  const mine = (list ?? []).filter((a) => a.source === 'user');
  const others = (list ?? []).filter((a) => a.source !== 'user');
  const body = (
    <div data-your-agents>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-body text-hx-secondary">Specialists with their own instructions, model, tools, MCP servers and limits. In any conversation the agent can hand work to them (several at once); you can also talk to one directly.</p>
        <Button icon="upload" variant="ghost" onClick={importFile} data-agents-import>Import</Button>
        <Button icon="plus" variant="primary" onClick={() => useAgentEditor.getState().open()} data-agents-new>New agent</Button>
      </div>
      {error && <Callout tone="danger" className="mb-4">{error}</Callout>}
      {list === null ? <p className="text-body text-hx-muted">Loading…</p> : (
        <>
          {!mine.length
            ? <EmptyState icon="bot" title="No agents of your own yet" action={<Button variant="primary" icon="sparkles" onClick={() => useAgentEditor.getState().open()} data-agents-make>Make one</Button>}>Describe one (a reviewer, a researcher, a test writer…) and it is drafted for you to check, or import an agent file from Claude Code, Cursor or Copilot.</EmptyState>
            : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-agents-mine>{mine.map((a) => <AgentCard key={a.name} a={a} reload={reload} onEdit={() => useAgentEditor.getState().open({ edit: a as AgentRecord })} />)}</div>}
          {others.length > 0 && (
            <>
              <h2 className="mb-2.5 mt-8 text-tiny font-semibold uppercase tracking-wide text-hx-muted">Built in and from plugins</h2>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-agents-others>{others.map((a) => <AgentCard key={`${a.source}:${a.name}`} a={a} reload={reload} />)}</div>
            </>
          )}
        </>
      )}
      <AgentEditor open={editing !== null || draft !== null} edit={editing ?? undefined} draft={draft ?? undefined} onClose={() => useAgentEditor.getState().close()} onSaved={() => void reload()} />
    </div>
  );
  return embedded ? body : <Page title="Your agents">{body}</Page>;
}

/** On the Agents home: the person's own agents (a few), New, and the way to all of them. */
export function YourAgentsSection(): React.ReactElement {
  const [mine, setMine] = useState<AgentRecord[] | null>(null);
  const editing = useAgentEditor((x) => x.editing);
  const draft = useAgentEditor((x) => x.draft);
  const reload = () => client.agents.mine().then(setMine).catch(() => setMine([]));
  useEffect(() => { void reload(); }, []);
  return (
    <section className="mb-7" data-home-section="your-agents">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-tiny font-semibold uppercase tracking-wide text-hx-muted">Your agents</h2>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon="plus" onClick={() => useAgentEditor.getState().open()} data-home-agent-new>New agent</Button>
        <Button size="sm" variant="ghost" icon="bot" onClick={() => navigate({ view: 'core.agents:mine' })}>All</Button>
      </div>
      {mine === null ? null : !mine.length
        ? <p className="rounded-xl border border-dashed border-hx-border-subtle p-4 text-body text-hx-muted">Make specialists of your own (a reviewer, a researcher, a test writer): the agent hands them work, several at once.</p>
        : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{mine.slice(0, 6).map((a) => <AgentCard key={a.name} a={{ ...a, source: 'user' }} reload={reload} onEdit={() => useAgentEditor.getState().open({ edit: a })} />)}</div>}
      <AgentEditor open={editing !== null || draft !== null} edit={editing ?? undefined} draft={draft ?? undefined} onClose={() => useAgentEditor.getState().close()} onSaved={() => void reload()} />
    </section>
  );
}

type Form = {
  name: string; description: string; prompt: string; model: string; effort: '' | Effort;
  toolsMode: 'all' | 'some'; tools: string[]; disallowed: string; serversMode: 'all' | 'some'; servers: string[]; skills: string[];
  mode: '' | NonNullable<AgentDef['permissionMode']>; maxTurns: string; maxCostUsd: string; worktree: boolean; background: boolean;
  modelInvocable: boolean; userInvocable: boolean; color: string;
};
const toForm = (d: Partial<AgentDef> = {}): Form => ({
  name: d.name ?? '', description: d.description ?? '', prompt: d.prompt ?? '', model: d.model ?? '', effort: d.effort ?? '',
  toolsMode: d.tools ? 'some' : 'all', tools: d.tools ?? [], disallowed: (d.disallowedTools ?? []).join(', '),
  serversMode: d.mcpServers ? 'some' : 'all', servers: d.mcpServers ?? [], skills: d.skills ?? [],
  mode: d.permissionMode ?? '', maxTurns: d.maxTurns ? String(d.maxTurns) : '', maxCostUsd: d.maxCostUsd ? String(d.maxCostUsd) : '',
  worktree: d.isolation === 'worktree', background: !!d.background, modelInvocable: d.modelInvocable !== false, userInvocable: d.userInvocable !== false, color: d.color ?? '',
});
const fromForm = (f: Form): AgentDef => ({
  name: f.name.trim(), description: f.description.trim(), prompt: f.prompt,
  ...(f.model ? { model: f.model } : {}), ...(f.effort ? { effort: f.effort } : {}),
  ...(f.toolsMode === 'some' ? { tools: f.tools } : {}),
  ...(f.disallowed.trim() ? { disallowedTools: f.disallowed.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  ...(f.serversMode === 'some' ? { mcpServers: f.servers } : {}), ...(f.skills.length ? { skills: f.skills } : {}),
  ...(f.mode ? { permissionMode: f.mode } : {}),
  ...(f.maxTurns ? { maxTurns: Number(f.maxTurns) } : {}), ...(f.maxCostUsd ? { maxCostUsd: Number(f.maxCostUsd) } : {}),
  ...(f.worktree ? { isolation: 'worktree' as const } : {}), ...(f.background ? { background: true } : {}),
  ...(!f.modelInvocable ? { modelInvocable: false } : {}), ...(!f.userInvocable ? { userInvocable: false } : {}), ...(f.color ? { color: f.color } : {}),
});

/** A section of the builder: the kit's Section (dense), its help as its description. */
function Part({ title, children, help }: { title: string; children: React.ReactNode; help?: string }) {
  return <Section dense title={title} description={help}>{children}</Section>;
}
/** The builder: describe and Generate, or fill it in; Save makes a new version (refused when it changed meanwhile). */
export function AgentEditor({ open, edit, draft, onClose, onSaved }: { open: boolean; edit?: AgentRecord; draft?: Partial<AgentDef>; onClose: () => void; onSaved?: (a: AgentRecord) => void }): React.ReactElement {
  const [f, setF] = useState<Form>(() => toForm(edit ?? draft));
  const [opts, setOpts] = useState<AgentOptions | null>(null);
  const [describe, setDescribe] = useState('');
  const [busy, setBusy] = useState<'' | 'generate' | 'save'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [versions, setVersions] = useState<Array<{ version: number; at: number }>>([]);
  useEffect(() => {
    if (!open) return;
    setF(toForm(edit ?? draft)); setError(''); setNote(''); setDescribe('');
    client.agents.options().then(setOpts).catch((e: Error) => setError(e.message));
    if (edit) client.agents.versions(edit.name).then((v) => setVersions(v.map((x) => ({ version: x.version, at: x.at })))).catch(() => setVersions([]));
    else setVersions([]);
  }, [open, edit?.name, edit?.version, draft]);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const byKind = useMemo(() => {
    const g = new Map<string, Array<{ id: string; label: string; hint?: string }>>();
    for (const t of opts?.tools ?? []) g.set(t.kind, [...(g.get(t.kind) ?? []), { id: t.name, label: t.name, hint: t.description }]);
    // Safest first: reading, then changing files, commands, the web, outside services, the rest.
    const order = ['read', 'edit', 'exec', 'network', 'external', 'meta'];
    return [...g.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
  }, [opts]);
  const generate = async () => {
    setBusy('generate'); setError(''); setNote('');
    try {
      const r = await client.agents.generate(describe, f.model || undefined);
      // The draft fills the form: the person checks it and saves (nothing is saved yet).
      setF({ ...toForm(r.draft), ...(edit ? { name: f.name } : {}) });
      setNote(`Drafted for $${r.costUsd.toFixed(4)}. Check it, change what you like, then save.${r.dropped.length ? ` Left out (not on this server): ${r.dropped.join(', ')}.` : ''}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const missing = !f.name.trim() ? 'a name' : f.description.trim().length < 10 ? 'when to use it (a sentence)' : f.toolsMode === 'some' && !f.tools.length ? 'at least one tool (or All tools)' : '';
  const save = async () => {
    setBusy('save'); setError('');
    try {
      const def = fromForm(f);
      const r = edit ? await client.agents.update(edit.name, def, edit.version) : await client.agents.create(def);
      toast(edit ? `Saved ${r.name} (version ${r.version})` : `Made ${r.name}`, { kind: 'success' });
      onSaved?.(r);
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const restore = async (v: number) => {
    if (!edit) return;
    try { const r = await client.agents.restore(edit.name, v); toast(`Version ${v} is current again (as version ${r.version})`, { kind: 'success' }); onSaved?.(r); onClose(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title={edit ? `Edit ${edit.name}` : 'New agent'} size="xl"
      footer={<>
        {missing && <span className="mr-auto text-small text-hx-muted" data-agent-missing>Still needs {missing}</span>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!missing || !!busy} onClick={() => void save()} data-agent-save>{busy === 'save' ? 'Saving…' : edit ? 'Save' : 'Make agent'}</Button>
      </>}>
      <div data-agent-form={edit ? 'edit' : 'new'}>
        <Part title="Describe it" help="Say what it is for, in your words. Generate drafts the rest (instructions, the fewest tools, autonomy, limits) for you to check: nothing is saved until you do.">
          <div className="flex gap-2">
            <Textarea rows={2} className="flex-1" value={describe} onChange={(e) => setDescribe(e.target.value)} placeholder="Reviews my pull requests for security problems and explains each one with a fix" data-agent-describe />
            <Button icon="sparkles" disabled={describe.trim().length < 10 || !!busy} onClick={() => void generate()} data-agent-generate>{busy === 'generate' ? 'Drafting…' : 'Generate'}</Button>
          </div>
            {note && <Callout tone="success" className="mt-2" data-agent-note>{note}</Callout>}
        </Part>

        <Part title="Who it is">
          <div className="grid gap-x-3 md:grid-cols-[1fr_2fr]">
            <Field label="Name" help="Letters, digits, - and _"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="security-reviewer" data-agent-name /></Field>
            <Field label="When to use it" help="The orchestrator chooses agents by this: what it does and what it returns"><Input value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="Reviews changes for security problems; returns each finding with a fix" data-agent-description /></Field>
          </div>
          <Field label="Instructions" help="Its role, the steps it follows, how it checks its work, what it never does, and the shape of its report">
            <Textarea rows={9} className="font-mono text-small" value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder={'Role: …\nProcedure: 1. … 2. …\nChecks: …\nNever: …\nReport: …'} data-agent-prompt />
          </Field>
        </Part>

        <Part title="Model">
          <div className="grid gap-x-3 md:grid-cols-2">
            <Field label="Model" help="Another company's model only runs when you allowed it (Settings > Delegation)"><Select value={f.model} onChange={(v) => set({ model: v })} options={[{ value: '', label: 'The conversation\'s model' }, ...(opts?.models ?? []).map((m) => ({ value: m.id, label: m.label ?? m.id })), ...(f.model && opts && !opts.models.some((m) => m.id === f.model) ? [{ value: f.model, label: `${f.model} (not available here)` }] : [])]} data-agent-model /></Field>
            <Field label="Effort"><Select value={f.effort} onChange={(v) => set({ effort: v as Form['effort'] })} options={[{ value: '', label: 'The model\'s default' }, ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((e) => ({ value: e, label: e }))]} data-agent-effort /></Field>
          </div>
        </Part>

        <Part title="Tools" help="The fewer, the safer and the better it chooses.">
          <ChoiceGroup name="agent-tools" label="Tools" value={f.toolsMode} options={[{ id: 'all', label: 'All tools' }, { id: 'some', label: 'Only these' }]} onChange={(toolsMode) => set({ toolsMode })} />
          {f.toolsMode === 'some' && (
            <div className="mt-3 space-y-3">
              {byKind.map(([kind, items]) => <div key={kind}><div className="mb-1 text-small font-medium text-hx-secondary">{KIND_LABEL[kind] ?? kind}</div><CheckboxGroup mono name={kind} items={items} value={f.tools} onChange={(tools) => set({ tools })} /></div>)}
            </div>
          )}
          <div className="mt-3"><Field label="Never these" help="Comma-separated; * matches anything (mcp__github__delete_*)"><Input value={f.disallowed} onChange={(e) => set({ disallowed: e.target.value })} placeholder="bash, mcp__github__delete_*" data-agent-disallowed /></Field></div>
        </Part>

        <Part title="MCP servers" help="Services it may use through MCP. Add servers in Settings > MCP servers.">
          <ChoiceGroup name="agent-servers" label="MCP servers" value={f.serversMode} options={[{ id: 'all', label: 'Those of the conversation' }, { id: 'some', label: 'Only these' }]} onChange={(serversMode) => set({ serversMode })} />
          {f.serversMode === 'some' && <div className="mt-3">{opts?.mcpServers.length ? <CheckboxGroup mono name="servers" items={opts.mcpServers.map((s) => ({ id: s, label: s }))} value={f.servers} onChange={(servers) => set({ servers })} /> : <p className="text-small text-hx-muted">No MCP server on this server yet: it gets none.</p>}</div>}
        </Part>

        {(opts?.skills.length ?? 0) > 0 && (
          <Part title="Skills" help="Procedures it starts with loaded (their instructions in its brief).">
            <CheckboxGroup mono name="skills" items={opts!.skills.map((s) => ({ id: s.name, label: s.name, hint: s.description }))} value={f.skills} onChange={(skills) => set({ skills })} />
          </Part>
        )}

        <Part title="Autonomy" help="Never more than the conversation it works in allows.">
          <OptionCards name="agent-mode" label="Autonomy" value={f.mode} options={MODES.map((m) => ({ id: m.id, title: m.label, detail: m.help }))} onChange={(mode) => set({ mode })} />
        </Part>

        <Part title="Limits and how it runs">
          <div className="grid gap-x-3 md:grid-cols-2">
            <Field label="Steps at most" help="Each step is a model call; it stops there"><Input type="number" min={1} max={1000} value={f.maxTurns} onChange={(e) => set({ maxTurns: e.target.value })} placeholder="No limit of its own" data-agent-max-turns /></Field>
            <Field label="Spend at most a run (USD)"><Input type="number" min={0} step="0.01" value={f.maxCostUsd} onChange={(e) => set({ maxCostUsd: e.target.value })} placeholder="No limit of its own" data-agent-max-cost /></Field>
          </div>
          <div className="space-y-2 text-small">
            <label className="flex items-center gap-2"><Switch checked={f.worktree} onChange={(worktree) => set({ worktree })} label="Its own git worktree" /> Its own git worktree (where the folder is a repository: parallel agents never edit the same files)</label>
            <label className="flex items-center gap-2"><Switch checked={f.background} onChange={(background) => set({ background })} label="In the background" /> In the background by default (the conversation carries on; its report arrives when it finishes)</label>
            <label className="flex items-center gap-2"><Switch checked={f.modelInvocable} onChange={(modelInvocable) => set({ modelInvocable })} label="The orchestrator may use it" /> The agent in a conversation may hand work to it</label>
            <label className="flex items-center gap-2"><Switch checked={f.userInvocable} onChange={(userInvocable) => set({ userInvocable })} label="You may chat with it" /> You may start a conversation with it</label>
          </div>
        </Part>

        {edit && versions.length > 0 && (
          <Part title="Earlier versions">
            <div className="flex flex-wrap gap-1.5" data-agent-versions>{versions.slice(0, 8).map((v) => <Button key={v.version} size="sm" variant="ghost" onClick={() => void restore(v.version)} data-agent-restore={v.version}>v{v.version} · {new Date(v.at).toLocaleDateString()}</Button>)}</div>
          </Part>
        )}
        {error && <Callout tone="danger" data-agent-error>{error}</Callout>}
      </div>
    </Modal>
  );
}
