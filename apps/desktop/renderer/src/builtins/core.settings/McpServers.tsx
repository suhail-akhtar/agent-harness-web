/**
 * Settings > MCP servers: the person's own MCP servers. Connected by URL (or a command, for an administrator),
 * signed in through the browser, imported from another app's config; each tool approved, and allowed, asked
 * about or blocked. Secrets are ${vault:name} references to the Vault section.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { McpImportResult, McpServerConfig, McpServerView, McpTestResult, McpToolPolicy, McpToolView } from '@harness/client';
import { isMissing } from '@harness/client';
import { Badge, Button, Callout, Card, CheckboxGroup, ChoiceGroup, EmptyState, Field, IconButton, InfoNote, Input, Meta, Modal, OptionCards, Section, Spinner, StatusDot, Switch, Textarea, toast } from '@harness/ui';
import { client, useData } from '../../state/data';
import { useApp } from '../../state/app';
import { desktop } from '../../bridge';
import { BuildServerDialog, BuiltServers } from './BuildServer';
import type { McpBuildRecord } from '@harness/client';

const fail = (e: Error) => toast(e.message, { kind: 'error' });

const POLICIES: Array<{ id: McpToolPolicy; label: string }> = [
  { id: 'auto', label: 'Auto' }, { id: 'allow', label: 'Allow' }, { id: 'ask', label: 'Ask' }, { id: 'block', label: 'Block' },
];

/** Where a server is: its address's host, or its command. */
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const where = (s: McpServerConfig) => (s.type === 'http' ? (() => { try { return new URL(s.url!.replace(/\$\{vault:[^}]+\}/g, 'x')).host; } catch { return s.url; } })() : [base(s.command ?? ''), ...(s.args ?? []).map(base)].join(' ').slice(0, 80));

function statusOf(s: McpServerView): { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string } {
  if (!s.enabled) return { tone: 'neutral', label: 'Off' };
  if (!s.status) return { tone: 'neutral', label: 'Not checked yet' };
  if (s.status.needsSignIn) return { tone: 'warning', label: 'Needs sign-in' };
  if (!s.status.ok) return { tone: 'danger', label: 'Not connecting' };
  if (s.status.pending) return { tone: 'warning', label: `${s.status.pending} waiting for approval` };
  return { tone: 'success', label: 'Connected' };
}

/** "KEY=value" lines to an object, and back. */
const toLines = (o?: Record<string, string>, sep = '=') => Object.entries(o ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
const fromLines = (t: string, sep: RegExp) => {
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) { const m = sep.exec(line.trim()); if (m) out[m[1]!.trim()] = m[2]!.trim(); }
  return Object.keys(out).length ? out : undefined;
};

export function McpServers(): React.ReactElement {
  const tick = useData((s) => s.mcpTick);
  const [data, setData] = useState<{ servers: McpServerView[]; admin: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<McpServerView | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [building, setBuilding] = useState<McpBuildRecord | 'new' | null>(null);
  const [bundling, setBundling] = useState(false);
  const load = () => client.mcp.list().then((d) => { setData(d); setErr(''); }).catch((e: Error) => setErr(isMissing(e) ? 'This server does not offer your own MCP servers yet.' : e.message));
  useEffect(() => { void load(); }, [tick]);

  if (err) return <InfoNote>{err}</InfoNote>;
  if (!data) return <Spinner />;
  const toggle = (s: McpServerView, on: boolean) => void client.mcp.update(s.name, { enabled: on }).then(load).catch(fail);
  return (
    <div data-section="mcp-servers">
      <Section
        title="Your MCP servers"
        description={<>Services your conversations and agents can use: tools, documents and prompts over the Model Context Protocol. Only you get them. Each tool is approved before it is used, and a server that later changes a tool needs your approval again.</>}
        count={data.servers.length}
        actions={<>{data.admin && <Button icon="sparkles" data-mcp-build onClick={() => setBuilding('new')}>Build a server…</Button>}<Button icon="upload" data-mcp-import onClick={() => setImporting(true)}>Import…</Button><Button variant="primary" icon="plus" data-mcp-add onClick={() => setEditing('new')}>Add server</Button></>}
      >
        {!data.servers.length ? (
          <EmptyState variant="section" icon="plug" title="No servers yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add server</Button>}>
            Connect one by its address (most services offer an MCP address, and sign-in), import the servers you use in Claude Desktop, Claude Code, Cursor or VS Code, or build one{data.admin ? ' from a description, an API, a database or a command' : ''}.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {data.servers.map((s) => {
              const st = statusOf(s);
              return (
                <Card key={s.name} padding="sm" interactive data-server={s.name} onClick={() => setOpen(s.name)}>
                  <div className="flex items-center gap-3">
                    <StatusDot tone={st.tone} label={st.label} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="font-medium text-body">{s.name}</span>{s.status?.pending ? <Badge tone="warning">{s.status.pending} to review</Badge> : null}{s.status?.needsSignIn && <Badge tone="warning">Sign in</Badge>}</div>
                      <Meta items={[st.label, where(s), s.status?.ok ? `${s.status.tools} tools` : null, s.status?.protocol ? `MCP ${s.status.protocol}` : null, s.description]} />
                    </div>
                    <span onClick={(e) => e.stopPropagation()}><Switch checked={s.enabled} label={`Use ${s.name}`} onChange={(v) => toggle(s, v)} /></span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>
      {data.admin && <BuiltServers onOpen={(r) => setBuilding(r)} />}
      {building && <BuildServerDialog open={building === 'new' ? undefined : building} onClose={() => setBuilding(null)} onDone={() => void load()} />}
      {editing && <ServerEditor admin={data.admin} editing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(name) => { setEditing(null); void load(); setOpen(name); }} />}
      {open && <ServerDetail name={open} onClose={() => { setOpen(null); void load(); }} onEdit={(s) => { setOpen(null); setEditing(s); }} />}
      {importing && <ImportDialog admin={data.admin} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void load(); }} onBundle={() => { setImporting(false); setBundling(true); }} />}
      {bundling && <BundleDialog onClose={() => setBundling(false)} onDone={(name) => { setBundling(false); void load(); setOpen(name); }} />}
    </div>
  );
}

function ServerEditor({ admin, editing, onClose, onSaved }: { admin: boolean; editing: McpServerView | null; onClose: () => void; onSaved: (name: string) => void }): React.ReactElement {
  const [type, setType] = useState<'http' | 'stdio'>(editing?.type ?? 'http');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [url, setUrl] = useState(editing?.url ?? '');
  const [headers, setHeaders] = useState(toLines(editing?.headers, ': '));
  const [command, setCommand] = useState(editing?.command ?? '');
  const [args, setArgs] = useState((editing?.args ?? []).join('\n'));
  const [env, setEnv] = useState(toLines(editing?.env));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    const cfg: McpServerConfig = type === 'http'
      ? { name: name.trim().toLowerCase(), type, url: url.trim(), ...(description.trim() ? { description: description.trim() } : {}), ...(fromLines(headers, /^([^:]+):(.*)$/) ? { headers: fromLines(headers, /^([^:]+):(.*)$/) } : {}) }
      : { name: name.trim().toLowerCase(), type, command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), ...(description.trim() ? { description: description.trim() } : {}), ...(fromLines(env, /^([^=]+)=(.*)$/) ? { env: fromLines(env, /^([^=]+)=(.*)$/) } : {}) };
    try {
      const saved = editing ? await client.mcp.update(editing.name, cfg, editing.version) : await client.mcp.create(cfg);
      toast(editing ? `Saved ${saved.name}` : `Added ${saved.name}`, { kind: 'success' });
      onSaved(saved.name);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={editing ? `Edit ${editing.name}` : 'Add an MCP server'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" data-mcp-save loading={busy} disabled={!name.trim() || (type === 'http' ? !url.trim() : !command.trim())} onClick={() => void save()}>{editing ? 'Save' : 'Add and connect'}</Button></>}>
      <div className="flex flex-col gap-4">
        {admin && !editing && (
          <OptionCards name="mcp-type" label="How it connects" value={type} onChange={setType} options={[
            { id: 'http', title: 'By its address', detail: 'A service on the internet (or your network). Signs in through your browser when it needs to.', icon: 'globe' },
            { id: 'stdio', title: 'A command', detail: 'A program this computer runs (npx, uvx, docker…). Only administrators can add one: it runs with this server\'s rights.', icon: 'terminal' },
          ]} />
        )}
        <Field label="Name" help="How its tools are named for the agent (mcp__name__tool): lowercase letters, digits, - and _." required>
          <Input data-mcp-name value={name} disabled={!!editing} onChange={(e) => setName(e.target.value)} placeholder="linear" autoFocus={!editing} />
        </Field>
        <Field label="What it is for" help="Optional. Helps you, and the agent builder, pick it.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Our issue tracker" />
        </Field>
        {type === 'http' ? (
          <>
            <Field label="Address" help={admin ? 'Its streamable HTTP endpoint, often ending in /mcp.' : 'Its https:// endpoint, often ending in /mcp.'} required>
              <Input data-mcp-url value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
            </Field>
            <Field label="Headers" help={<>One per line, as <code>Name: value</code>. Put a key in the Vault and write <code>{'${vault:name}'}</code> here, for example <code>{'Authorization: Bearer ${vault:linear-key}'}</code>. Leave empty to sign in instead.</>}>
              <Textarea data-mcp-headers rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} className="font-mono text-small" placeholder="Authorization: Bearer ${vault:my-key}" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Command" required><Input data-mcp-command value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" /></Field>
            <Field label="Arguments" help="One per line."><Textarea data-mcp-args rows={3} value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono text-small" placeholder={'-y\n@modelcontextprotocol/server-github'} /></Field>
            <Field label="Environment" help={<>One per line, as <code>NAME=value</code>; secrets as <code>{'${vault:name}'}</code>.</>}><Textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} className="font-mono text-small" placeholder="GITHUB_TOKEN=${vault:github-token}" /></Field>
          </>
        )}
        {error && <Callout tone="danger" data-mcp-error>{error}</Callout>}
      </div>
    </Modal>
  );
}

function ToolRow({ t, onPolicy, onApprove }: { t: McpToolView; onPolicy: (p: McpToolPolicy) => void; onApprove: () => void }): React.ReactElement {
  return (
    <div className="flex items-start gap-3 py-2" data-tool={t.name}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-small font-medium">{t.name}</span>
          {t.readOnly && <Badge tone="info">Read-only</Badge>}
          {t.state === 'new' && <Badge tone="warning">New</Badge>}
          {t.state === 'changed' && <Badge tone="danger">Changed</Badge>}
        </div>
        {t.description && <p className="mt-0.5 line-clamp-3 text-small text-hx-secondary">{t.description}</p>}
      </div>
      {t.state === 'approved'
        ? <ChoiceGroup name={`policy-${t.name}`} label={`${t.name}: when the agent uses it`} variant="segmented" size="sm" value={t.policy} options={POLICIES} onChange={onPolicy} />
        : <Button size="sm" data-mcp-approve={t.name} onClick={onApprove}>Approve</Button>}
    </div>
  );
}

function ServerDetail({ name, onClose, onEdit }: { name: string; onClose: () => void; onEdit: (s: McpServerView) => void }): React.ReactElement {
  const tick = useData((s) => s.mcpTick);
  const [view, setView] = useState<McpServerView | null>(null);
  const [test, setTest] = useState<McpTestResult | null>(null);
  const [busy, setBusy] = useState('');
  const run = async (what: string, f: () => Promise<unknown>) => { setBusy(what); try { await f(); } catch (e) { fail(e as Error); } finally { setBusy(''); } };
  // Removed: the change event that follows must not look it up again.
  const gone = useRef(false);
  const check = () => gone.current ? Promise.resolve() : run('test', async () => { const [v, t] = await Promise.all([client.mcp.get(name), client.mcp.test(name)]); setView(v); setTest(t); });
  useEffect(() => { void check(); }, [name, tick]);
  const signIn = () => run('signin', async () => {
    const r = await client.mcp.signIn(name);
    if (r.authorizeUrl) { await desktop.openExternal(r.authorizeUrl); toast('Finish signing in in your browser; this updates when you are done.'); }
    else { toast('Signed in', { kind: 'success' }); await check(); }
  });
  const pending = useMemo(() => test?.tools.filter((t) => t.state !== 'approved') ?? [], [test]);
  const remove = async () => {
    if (!await useApp.getState().ask({ title: `Remove ${name}?`, body: 'Its tools leave your conversations and agents, and its sign-in is forgotten.', confirmLabel: 'Remove', danger: true })) return;
    gone.current = true;
    await run('remove', async () => { try { await client.mcp.remove(name); } catch (e) { gone.current = false; throw e; } toast(`Removed ${name}`); onClose(); });
  };
  return (
    <Modal open onClose={onClose} size="lg" title={name}
      footer={<><Button variant="danger" icon="trash" data-mcp-remove disabled={!!busy} onClick={() => void remove()}>Remove</Button><span className="flex-1" />{view && <Button icon="edit" onClick={() => onEdit(view)}>Edit</Button>}<Button variant="primary" data-mcp-done onClick={onClose}>Done</Button></>}>
      {!view || !test ? <Spinner /> : (
        <div className="flex flex-col gap-4" data-detail={name}>
          <div className="flex items-center gap-2">
            <StatusDot tone={test.ok ? 'success' : test.needsSignIn ? 'warning' : 'danger'} label={test.ok ? 'Connected' : test.error ?? 'Not connecting'} />
            <Meta className="flex-1" items={[test.ok ? 'Connected' : test.needsSignIn ? 'Needs sign-in' : 'Not connecting', where(view), test.serverInfo?.name ? `${test.serverInfo.name}${test.serverInfo.version ? ` ${test.serverInfo.version}` : ''}` : null, test.protocol ? `MCP ${test.protocol}` : null, view.vault.length ? `Vault: ${view.vault.join(', ')}` : null]} />
            <IconButton icon="refresh" label="Check again" disabled={!!busy} onClick={() => void check()} />
            {view.type === 'http' && (view.signedIn
              ? <Button size="sm" variant="ghost" data-mcp-signout disabled={!!busy} onClick={() => void run('signout', async () => { await client.mcp.signOut(name); await check(); })}>Sign out</Button>
              : <Button size="sm" variant={test.needsSignIn ? 'primary' : 'secondary'} data-mcp-signin loading={busy === 'signin'} onClick={() => void signIn()}>Sign in</Button>)}
          </div>
          {!test.ok && !test.needsSignIn && <Callout tone="danger" title="It does not connect">{test.error}</Callout>}
          {test.needsSignIn && <Callout tone="warning" data-mcp-needs-signin title="Sign in to use it" actions={<Button size="sm" variant="primary" loading={busy === 'signin'} onClick={() => void signIn()}>Sign in</Button>}>Your browser opens the service's sign-in. Nothing you type there reaches this app: the service gives it a key for you, kept encrypted here.</Callout>}
          {pending.length > 0 && (
            <Callout tone="warning" data-mcp-pending title={`${pending.length} ${pending.length === 1 ? 'tool waits' : 'tools wait'} for your approval`} actions={<Button size="sm" variant="primary" data-mcp-approve-all loading={busy === 'approve'} onClick={() => void run('approve', async () => setTest(await client.mcp.approve(name)))}>Approve all</Button>}>
              {pending.some((t) => t.state === 'changed') ? 'The server changed what some tools say they do since you approved them. Read them before you approve: a changed description can carry instructions for the agent.' : 'New tools stay out of your conversations until you approve them.'}
            </Callout>
          )}
          {test.instructions && <p className="text-small text-hx-secondary">{test.instructions}</p>}
          {test.ok && (
            <Section dense title="Tools" count={test.tools.length} description="Auto: it asks unless the server marks the tool read-only. Allow: it runs without asking (still checked after the agent reads untrusted content). Ask: it always asks. Block: never offered.">
              {!test.tools.length ? <EmptyState variant="inline" title="This server has no tools." /> : (
                <div className="divide-y divide-hx-border-subtle">
                  {test.tools.map((t) => <ToolRow key={t.name} t={t}
                    onPolicy={(p) => void run('policy', async () => { await client.mcp.setPolicies(name, { [t.name]: p }); setTest({ ...test, tools: test.tools.map((x) => (x.name === t.name ? { ...x, policy: p } : x)) }); })}
                    onApprove={() => void run('approve', async () => setTest(await client.mcp.approve(name, [t.name])))} />)}
                </div>
              )}
            </Section>
          )}
          {test.ok && (test.resources.length > 0 || test.prompts.length > 0) && (
            <Section dense title="Documents and prompts" description="The agent reads these through two read-only tools of this server (resources, prompts).">
              <Meta items={[test.resources.length ? `${test.resources.length} resources` : null, test.prompts.length ? `${test.prompts.length} prompts: ${test.prompts.slice(0, 5).map((p) => p.name).join(', ')}` : null]} />
            </Section>
          )}
        </div>
      )}
    </Modal>
  );
}

function ImportDialog({ admin, onClose, onDone, onBundle }: { admin: boolean; onClose: () => void; onDone: () => void; onBundle: () => void }): React.ReactElement {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<McpImportResult | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const look = async () => {
    setBusy(true); setError('');
    try {
      const r = await client.mcp.import(text);
      setPreview(r);
      setChosen(r.servers.filter((s) => admin || s.config.type === 'http').map((s) => s.config.name));
    } catch (e) { setError((e as Error).message); setPreview(null); } finally { setBusy(false); }
  };
  const add = async () => {
    setBusy(true);
    try {
      const r = await client.mcp.import(text, { apply: true, names: chosen });
      if (r.added?.length) toast(`Added ${r.added.join(', ')}`, { kind: 'success' });
      if (r.errors.length) { setPreview(r); setError(r.errors.join('\n')); return; }
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Import MCP servers"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>{preview ? <Button variant="primary" data-mcp-import-add loading={busy} disabled={!chosen.length} onClick={() => void add()}>Add {chosen.length || ''}</Button> : <Button variant="primary" data-mcp-import-read loading={busy} disabled={!text.trim()} onClick={() => void look()}>Read it</Button>}</>}>
      <div className="flex flex-col gap-4">
        {admin && <div><Button variant="ghost" icon="box" data-mcp-bundle onClick={onBundle}>Install a .mcpb bundle instead…</Button></div>}
        <Field label="A config file's contents" help="From Claude Desktop (claude_desktop_config.json), Claude Code (.mcp.json), Cursor (mcp.json) or VS Code (.vscode/mcp.json). Keys written in it are moved to Vault references; nothing is added until you choose.">
          <Textarea data-mcp-import-text rows={8} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} className="font-mono text-small" placeholder='{ "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp" } } }' />
        </Field>
        {preview && (
          <>
            <Meta items={[preview.format, `${preview.servers.length} servers`]} />
            {preview.servers.length > 0 && (
              <CheckboxGroup cols={1} name="import" value={chosen} onChange={setChosen}
                items={preview.servers.map((s) => ({ id: s.config.name, label: <span><b>{s.config.name}</b> <span className="text-hx-muted">{where(s.config)}{!admin && s.config.type === 'stdio' ? ' (a command: only administrators)' : ''}</span></span>, ...(s.warnings.length ? { hint: s.warnings.join(' · ') } : {}) }))} />
            )}
            {preview.vault.length > 0 && <Callout tone="info" title="Put these in your Vault">They connect once the Vault has: {preview.vault.join(', ')}.</Callout>}
          </>
        )}
        {error && <Callout tone="danger"><span className="whitespace-pre-line">{error}</span></Callout>}
      </div>
    </Modal>
  );
}

/** A .mcpb bundle (a Claude Desktop extension) as one of the person's servers: picked, its settings filled in, installed. */
function BundleDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }): React.ReactElement {
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof client.mcp.inspectBundle>> | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.mcpb';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const base64 = String(r.result).split(',')[1] ?? '';
        setFile({ name: f.name, base64 }); setError('');
        client.mcp.inspectBundle(base64).then((i) => {
          setInfo(i);
          setValues(Object.fromEntries(i.settings.map((x) => [x.key, x.sensitive ? `\${vault:${i.name}-${x.key}}` : x.default !== undefined ? String(x.default) : ''])));
        }).catch((e: Error) => setError(e.message));
      };
      r.readAsDataURL(f);
    };
    input.click();
  };
  const install = async () => {
    setBusy(true); setError('');
    try { const v = await client.mcp.installBundle(file!.base64, values); toast(`Installed ${v.name}`, { kind: 'success' }); onDone(v.name); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Install an MCP bundle"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" data-bundle-install loading={busy} disabled={!info} onClick={() => void install()}>Install</Button></>}>
      <div className="flex flex-col gap-4" data-bundle-dialog>
        <div className="flex items-center gap-3"><Button icon="upload" data-bundle-pick onClick={pick}>Choose a .mcpb file…</Button>{file && <span className="text-small text-hx-muted">{file.name}</span>}</div>
        {info && (
          <>
            <Meta items={[info.name, info.version ? `version ${info.version}` : null, info.description]} />
            {info.settings.length > 0 && (
              <Section dense title="Its settings" description="A secret is a Vault reference, ${vault:name}: put the value in Settings > Vault first.">
                <div className="flex flex-col gap-3">
                  {info.settings.map((x) => (
                    <Field key={x.key} label={<span className="font-mono">{x.title ?? x.key}{x.sensitive ? ' (secret)' : ''}{x.required ? ' *' : ''}</span>} help={x.description}>
                      <Input data-bundle-setting={x.key} value={values[x.key] ?? ''} onChange={(e) => setValues({ ...values, [x.key]: e.target.value })} className="font-mono" />
                    </Field>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  );
}
