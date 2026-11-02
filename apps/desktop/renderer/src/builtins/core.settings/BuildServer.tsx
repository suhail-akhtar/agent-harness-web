/**
 * Settings > MCP servers > Build a server: an MCP server from a description, an OpenAPI document, a database or a
 * command. The harness drafts its spec (the person reviews the tools and settings), builds it on the official SDK,
 * checks it with its own client, and adds it to the person's servers, packs it as a .mcpb for Claude Desktop, or
 * gives the config for Claude Code, Cursor and VS Code.
 */

import React, { useEffect, useState } from 'react';
import type { McpBuildDraft, McpBuildRecord, McpBuildSource, McpBuildSpec } from '@harness/client';
import { Badge, Button, Callout, Card, CheckboxGroup, ChoiceGroup, EmptyState, Field, Input, Meta, Modal, OptionCards, Section, StatusDot, Textarea, toast } from '@harness/ui';
import { client, useData } from '../../state/data';
import { useApp } from '../../state/app';
import { desktop } from '../../bridge';

type Source = McpBuildSource['source'];

const CONFIGS: Array<{ path: string; label: string }> = [
  { path: 'configs/claude_desktop_config.json', label: 'Claude Desktop' },
  { path: 'configs/mcp.json', label: 'Claude Code (.mcp.json)' },
  { path: 'configs/cursor-mcp.json', label: 'Cursor' },
  { path: 'configs/vscode-mcp.json', label: 'VS Code' },
];

/** What a tool does, in a few words. */
function how(run: McpBuildSpec['tools'][number]['run']): string {
  if (run.kind === 'http') return `${run.method} ${run.url.replace(/^\$\{[A-Z_]+\}/, '')}`;
  if (run.kind === 'command') return `runs ${run.command}`;
  if (run.kind === 'sql') return 'SQL';
  return 'code';
}

/** The servers the person built, under their own servers. */
export function BuiltServers({ onOpen }: { onOpen: (r: McpBuildRecord) => void }): React.ReactElement | null {
  const tick = useData((s) => s.mcpTick);
  const [list, setList] = useState<McpBuildRecord[] | null>(null);
  useEffect(() => { client.mcpBuilds.list().then(setList).catch(() => setList([])); }, [tick]);
  if (!list?.length) return null;
  return (
    <Section dense title="Servers you built" count={list.length} description="Made with Build a server: open one to add it, pack it for Claude Desktop, or copy its config for another app.">
      <div className="flex flex-col gap-2" data-builds>
        {list.map((r) => (
          <Card key={r.name} padding="sm" interactive data-build={r.name} onClick={() => onOpen(r)}>
            <div className="flex items-center gap-3">
              <StatusDot tone={r.report?.ok ? 'success' : 'danger'} label={r.report?.ok ? 'Checked' : 'Its check failed'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="text-body font-medium">{r.spec.title ?? r.name}</span>{r.registered && <Badge tone="accent">In your servers</Badge>}</div>
                <Meta items={[r.name, `${r.spec.tools.length} tools`, `from ${r.source}`, r.report ? `${r.report.checks.filter((c) => c.ok).length}/${r.report.checks.length} checks` : null]} />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

export function BuildServerDialog({ onClose, onDone, open }: { onClose: () => void; onDone: () => void; open?: McpBuildRecord }): React.ReactElement {
  const models = useData((s) => s.models);
  const [step, setStep] = useState<'source' | 'review' | 'result'>(open ? 'result' : 'source');
  const [source, setSource] = useState<Source>('description');
  const [description, setDescription] = useState('');
  const [openapi, setOpenapi] = useState('');
  const [dbKind, setDbKind] = useState<'sqlite' | 'duckdb'>('sqlite');
  const [dbPath, setDbPath] = useState('');
  const [dbWrite, setDbWrite] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [draft, setDraft] = useState<McpBuildDraft | null>(null);
  const [spec, setSpec] = useState<McpBuildSpec | null>(open?.spec ?? null);
  const [keep, setKeep] = useState<string[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [rec, setRec] = useState<McpBuildRecord | null>(open ?? null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (what: string, f: () => Promise<void>) => { setBusy(what); setError(''); try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } };
  const model = models.find((m) => m.available)?.id;

  const makeDraft = () => run('draft', async () => {
    const from: McpBuildSource = source === 'description' ? { source, description, ...(model ? { model } : {}) }
      : source === 'openapi' ? (/^https?:\/\//.test(openapi.trim()) ? { source, url: openapi.trim() } : { source, text: openapi })
      : source === 'database' ? { source, kind: dbKind, path: dbPath.trim(), write: dbWrite.includes('write') }
      : { source, command: command.trim(), ...(description.trim() ? { description } : {}), ...(model ? { model } : {}) };
    const d = await client.mcpBuilds.draft(from);
    setDraft(d); setSpec(d.spec); setKeep(d.spec.tools.map((t) => t.name));
    setSettings(Object.fromEntries(d.spec.env.map((e) => [e.name, source === 'database' && e.name === 'DATABASE_PATH' ? dbPath.trim() : e.secret ? `\${vault:${d.spec.name}-${e.name.toLowerCase().replace(/_/g, '-')}}` : ''])));
    setStep('review');
  });
  const build = () => run('build', async () => {
    const s = { ...spec!, tools: spec!.tools.filter((t) => keep.includes(t.name)) };
    const r = await client.mcpBuilds.build(s, Object.fromEntries(Object.entries(settings).filter(([, v]) => v.trim())), source);
    setRec(r); setStep('result');
  });
  const register = () => run('register', async () => { const r = await client.mcpBuilds.register(rec!.name); toast(r.created ? `Added ${rec!.name} to your servers` : `Updated ${rec!.name}`, { kind: 'success' }); setRec({ ...rec!, registered: true }); onDone(); });
  const pack = () => run('pack', async () => {
    const r = await client.mcpBuilds.pack(rec!.name);
    setRec(r);
    const b = await client.mcpBuilds.bundle(rec!.name);
    const saved = await desktop.saveFile(b.name, b.base64, 'mcpb', 'MCP bundle');
    if (saved) toast(`Saved ${b.name}: open it in Claude Desktop to install it`, { kind: 'success' });
  });
  const copy = (path: string, label: string) => run('copy', async () => { const f = await client.mcpBuilds.file(rec!.name, path); await desktop.clipboard(f.text); toast(`The ${label} config is copied`); });
  const remove = async () => {
    if (!await useApp.getState().ask({ title: `Remove ${rec!.name}?`, body: 'Its folder and bundle are deleted. If it is in your servers, it stays there until you remove it too (and stops working).', confirmLabel: 'Remove', danger: true })) return;
    await run('remove', async () => { await client.mcpBuilds.remove(rec!.name); onDone(); onClose(); });
  };

  const footer = step === 'source'
    ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" data-build-draft loading={busy === 'draft'} disabled={source === 'description' ? description.trim().length < 15 : source === 'openapi' ? !openapi.trim() : source === 'database' ? !dbPath.trim() : !command.trim()} onClick={() => void makeDraft()}>Draft it</Button></>
    : step === 'review'
      ? <><Button variant="ghost" onClick={() => setStep('source')}>Back</Button><Button variant="primary" data-build-go loading={busy === 'build'} disabled={!keep.length} onClick={() => void build()}>Build and check</Button></>
      : <>{rec && <Button variant="danger" icon="trash" data-build-remove disabled={!!busy} onClick={() => void remove()}>Remove</Button>}<span className="flex-1" /><Button variant="ghost" onClick={() => setStep('review')} disabled={!spec}>Change it</Button><Button variant="primary" data-build-done onClick={onClose}>Done</Button></>;

  return (
    <Modal open onClose={onClose} size="xl" title={step === 'result' && rec ? `Build: ${rec.spec.title ?? rec.name}` : 'Build an MCP server'} footer={footer}>
      <div className="flex flex-col gap-4" data-build-step={step}>
        {step === 'source' && (
          <>
            <OptionCards name="build-source" label="Build it from" value={source} onChange={setSource} options={[
              { id: 'description', title: 'A description', detail: 'Say which service and what you want to do with it; a model drafts the tools.', icon: 'sparkles' },
              { id: 'openapi', title: 'An OpenAPI document', detail: 'A tool for each operation of an API (its address, or the JSON).', icon: 'file-text' },
              { id: 'database', title: 'A database', detail: 'A SQLite or DuckDB file: its tables, a find tool each, read-only SQL.', icon: 'database' },
              { id: 'command', title: 'A command', detail: 'A program on this computer; a model reads its --help and drafts tools.', icon: 'terminal' },
            ]} />
            {source === 'description' && <Field label="What it is for" help="The service, and the jobs you want an agent to do with it. Example: GitHub issues: search, read, create and comment, with my token."><Textarea data-build-description rows={5} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>}
            {source === 'openapi' && <Field label="The OpenAPI document" help="Its https:// address, or paste the JSON (OpenAPI 3)."><Textarea data-build-openapi rows={6} value={openapi} onChange={(e) => setOpenapi(e.target.value)} className="font-mono text-small" placeholder="https://api.example.com/openapi.json" /></Field>}
            {source === 'database' && (
              <>
                <ChoiceGroup name="build-db-kind" label="Kind" value={dbKind} onChange={setDbKind} options={[{ id: 'sqlite', label: 'SQLite' }, { id: 'duckdb', label: 'DuckDB' }]} />
                <Field label="The database file" help="A path on this computer."><Input data-build-db-path value={dbPath} onChange={(e) => setDbPath(e.target.value)} className="font-mono" placeholder="C:\data\shop.db" /></Field>
                <CheckboxGroup cols={1} name="build-db-write" value={dbWrite} onChange={setDbWrite} items={[{ id: 'write', label: 'Also a tool that changes it (INSERT, UPDATE, DELETE)', hint: 'Off: read-only, the database is opened read-only.' }]} />
              </>
            )}
            {source === 'command' && (
              <>
                <Field label="The program"><Input data-build-command value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono" placeholder="git" /></Field>
                <Field label="What to offer" help="Optional: which of its jobs the tools should do."><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
              </>
            )}
            {(source === 'description' || source === 'command') && <Meta items={[model ? `Drafted by ${models.find((m) => m.id === model)?.label ?? model}` : 'No model is available to draft it']} />}
          </>
        )}
        {step === 'review' && spec && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" help="Its tools are named mcp__name__tool in your conversations."><Input data-build-name value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value.toLowerCase() })} /></Field>
              <Field label="Title"><Input value={spec.title ?? ''} onChange={(e) => setSpec({ ...spec, title: e.target.value })} /></Field>
            </div>
            <Field label="What it is for"><Textarea rows={2} value={spec.description} onChange={(e) => setSpec({ ...spec, description: e.target.value })} /></Field>
            {draft?.skipped?.length ? <Callout tone="info" title="Left out">{draft.skipped.join(' · ')}</Callout> : null}
            {draft?.costUsd ? <Meta items={[`Drafting cost $${draft.costUsd.toFixed(4)}`]} /> : null}
            <Section dense title="Tools" count={keep.length} description="Keep the ones an agent needs: fewer, clearer tools work better. Read-only ones are called during the check.">
              <CheckboxGroup cols={1} name="build-tools" value={keep} onChange={setKeep}
                items={spec.tools.map((t) => ({ id: t.name, label: <span className="font-mono text-small">{t.name} <span className="font-sans text-hx-muted">· {t.annotations.readOnlyHint ? 'read-only' : t.annotations.destructiveHint ? 'destructive' : 'changes things'} · {how(t.run)}</span></span>, hint: t.description }))} />
            </Section>
            {spec.env.length > 0 && (
              <Section dense title="Settings" description="What it reads from its environment. A secret is a Vault reference, ${vault:name}: put the value in Settings > Vault.">
                <div className="flex flex-col gap-3">
                  {spec.env.map((e) => (
                    <Field key={e.name} label={<span className="font-mono">{e.name}{e.secret ? ' (secret)' : ''}</span>} help={e.description}>
                      <Input data-build-setting={e.name} value={settings[e.name] ?? ''} onChange={(x) => setSettings({ ...settings, [e.name]: x.target.value })} className="font-mono" />
                    </Field>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
        {step === 'result' && rec && (
          <>
            {rec.report?.ok
              ? <Callout tone="success" data-build-ok title="It works">{`Checked by the harness's own client: ${rec.report.checks.length} checks passed, ${rec.spec.tools.length} tools, MCP ${rec.report.protocol ?? ''}.`}</Callout>
              : <Callout tone="danger" data-build-failed title="Its check did not pass">Change the spec or its settings and build it again. What failed is below.</Callout>}
            <Section dense title="Checks">
              {!rec.report ? <EmptyState variant="inline" title="Not checked." /> : (
                <div className="divide-y divide-hx-border-subtle" data-build-checks>
                  {rec.report.checks.map((c) => (
                    <div key={c.name} className="flex items-start gap-2 py-1.5" data-check-row={c.ok ? 'ok' : 'failed'}>
                      <span className="pt-1.5"><StatusDot tone={c.ok ? 'success' : 'danger'} label={c.ok ? 'Passed' : 'Failed'} /></span>
                      <div className="min-w-0 flex-1"><div className="text-body">{c.name}</div>{c.detail && <div className="line-clamp-2 font-mono text-caption text-hx-muted">{c.detail}</div>}</div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
            {rec.report?.ok && (
              <Section dense title="Use it">
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" icon="plus" data-build-register loading={busy === 'register'} onClick={() => void register()}>{rec.registered ? 'Update in my servers' : 'Add to my servers'}</Button>
                  <Button icon="download" data-build-pack loading={busy === 'pack'} onClick={() => void pack()}>Download .mcpb</Button>
                  {CONFIGS.map((c) => <Button key={c.path} variant="ghost" icon="copy" disabled={!!busy} onClick={() => void copy(c.path, c.label)}>{c.label}</Button>)}
                </div>
              </Section>
            )}
          </>
        )}
        {error && <Callout tone="danger" data-build-error><span className="whitespace-pre-line">{error}</span></Callout>}
      </div>
    </Modal>
  );
}
