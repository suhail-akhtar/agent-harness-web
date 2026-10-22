/**
 * Settings kept by the server: Models & providers, Permissions & limits, Instructions, Memory,
 * Vault, Schedules, MCP bundles. Each degrades to a note when the server does not offer it.
 */

import React, { useEffect, useState } from 'react';
import type { EffectiveSetting, McpBundle, ProviderInfo, Schedule, SessionMeta, VaultEntry } from '@harness/client';
import { isMissing } from '@harness/client';
import { Badge, Button, EmptyState, Field, Icon, IconButton, Input, InfoNote, Select, Spinner, Switch, Textarea, cx, toast, SecretInput } from '@harness/ui';
import { useData, client } from '../../state/data';
import { useApp } from '../../state/app';

const fail = (e: unknown) => toast((e as Error).message, { kind: 'error' });
function useLoad<T>(f: () => Promise<T>, deps: unknown[] = []): [T | null, string, () => void] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => { let alive = true; setErr(''); f().then((x) => alive && setV(x)).catch((e: Error) => alive && setErr(isMissing(e) ? 'This server does not offer this.' : e.message)); return () => { alive = false; }; }, [n, ...deps]);
  return [v, err, () => setN((k) => k + 1)];
}

export function ModelsProviders({ onboarding }: { onboarding?: boolean }): React.ReactElement {
  const providers = useData((s) => s.providers);
  const models = useData((s) => s.models);
  const me = useData((s) => s.me);
  const refresh = () => useData.getState().refreshModels();
  if (providers === null) return <InfoNote>This server does not list providers. Keys come from its environment (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, MOONSHOT_API_KEY, ZAI_API_KEY).</InfoNote>;
  const admin = me?.role === 'admin';
  return (
    <div data-section="models">
      {!onboarding && <p className="mb-3 text-[13px] text-hx-secondary">A key is stored in the server's key vault (never shown again, never sent to this window). A key in the server's environment wins over a stored one.</p>}
      {!admin && <InfoNote tone="warning">Only administrators change keys on this server.</InfoNote>}
      <div className="space-y-3">
        {[...providers].sort((a, b) => Number(b.configured) - Number(a.configured)).map((p) => <ProviderCard key={p.id} p={p} admin={admin} models={models.filter((m) => m.provider === p.id)} onChanged={refresh} />)}
      </div>
    </div>
  );
}

function ProviderCard({ p, admin, models, onChanged }: { p: ProviderInfo; admin: boolean; models: import('@harness/client').ModelInfo[]; onChanged: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [base, setBase] = useState(p.baseUrl ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (what: string, f: () => Promise<unknown>) => { setBusy(what); try { await f(); await onChanged(); } catch (e) { fail(e); } finally { setBusy(null); } };
  return (
    <div data-provider={p.id} className="rounded-xl border border-hx-border-subtle bg-hx-elevated p-4">
      <div className="flex items-center gap-2">
        <Icon name="key" size={16} className="text-hx-muted" />
        <span className="text-[14px] font-medium">{p.label ?? p.id}</span>
        {p.configured ? <Badge tone="success">{p.keyless ? 'No key needed' : p.source === 'env' ? 'Key from environment' : p.source === 'vault' ? 'Key stored' : 'Ready'}</Badge> : <Badge>No key</Badge>}
        <span className="ml-auto text-[11.5px] text-hx-muted">{p.keyEnv?.join(' or ')}</span>
      </div>
      {models.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{models.map((m) => <span key={m.id} className={cx('rounded-md px-1.5 py-0.5 text-[11.5px]', m.available ? 'bg-hx-pill text-hx-secondary' : 'bg-hx-pill/60 text-hx-muted')}>{m.label}</span>)}</div>}
      {admin && !p.keyless && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="min-w-[220px] flex-1"><SecretInput value={key} onChange={setKey} placeholder={p.configured ? 'Replace the key' : 'Paste an API key'} /></div>
          <Button size="sm" variant="primary" disabled={!key.trim() || !!busy} loading={busy === 'save'} data-save-key onClick={() => void run('save', async () => { const r = await client.providers.set(p.id, { apiKey: key.trim() }); setKey(''); toast(r.note ?? 'Key saved', { kind: 'success' }); })}>Save key</Button>
          <Button size="sm" disabled={!!busy} loading={busy === 'test'} data-test-key onClick={() => void (async () => { setBusy('test'); try { const r = await client.providers.test(p.id); setTest({ ok: r.ok, text: r.ok ? `Works${r.model ? ` (${r.model})` : ''}${r.latencyMs ? ` in ${r.latencyMs} ms` : ''}` : r.error ?? 'Failed' }); } catch (e) { setTest({ ok: false, text: (e as Error).message }); } finally { setBusy(null); } })()}>Test</Button>
          {p.source === 'vault' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('remove', async () => { await client.providers.removeKey(p.id); toast('Key removed'); })}>Remove key</Button>}
        </div>
      )}
      {test && <div data-test-result={test.ok ? 'ok' : 'error'} className={cx('mt-2 text-[12.5px]', test.ok ? 'text-hx-success' : 'text-hx-danger')}>{test.text}</div>}
      {admin && p.baseUrlEditable && (
        <div className="mt-3 flex items-center gap-2">
          <Input className="font-mono text-[12px]" value={base} placeholder="Default address" onChange={(e) => setBase(e.target.value)} aria-label={`${p.label ?? p.id} address`} />
          <Button size="sm" disabled={!!busy || base === (p.baseUrl ?? '')} onClick={() => void run('base', async () => { await client.providers.set(p.id, { baseUrl: base.trim() || null }); toast('Address saved'); })}>Save address</Button>
        </div>
      )}
    </div>
  );
}

export function OnboardProvider(): React.ReactElement {
  return <div className="px-6 py-4"><p className="mb-3 text-[13px] text-hx-secondary">Add a key for at least one provider. DeepSeek (inexpensive) or Anthropic (Claude Sonnet) are good places to start.</p><ModelsProviders onboarding /></div>;
}

/** The defaults onboarding suggests, in order. */
export const SUGGESTED_MODELS = ['claude-sonnet-5-5', 'deepseek-flash'];

export function OnboardModel(): React.ReactElement {
  const models = useData((s) => s.models);
  const prefs = useApp((s) => s.prefs);
  // Suggested first: Claude Sonnet for quality, DeepSeek Flash for cost.
  const rank = (id: string) => { const i = SUGGESTED_MODELS.indexOf(id); return i < 0 ? 99 : i; };
  const available = models.filter((m) => m.available).sort((a, b) => rank(a.id) - rank(b.id));
  useEffect(() => { if (available.length && !available.some((m) => m.id === prefs.defaultModel)) useApp.getState().setPrefs({ defaultModel: available[0]!.id }); }, [available.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="px-6 py-4" data-onboard-model>
      {!available.length ? <InfoNote tone="warning">No model has a key yet: go back a step and add one.</InfoNote> : (
        <div className="space-y-1.5">
          {available.map((m) => (
            <button key={m.id} type="button" onClick={() => useApp.getState().setPrefs({ defaultModel: m.id })} className={cx('flex w-full items-center gap-3 rounded-xl border p-3 text-left', prefs.defaultModel === m.id ? 'border-hx-accent bg-hx-accent-soft' : 'border-hx-border-subtle hover:border-hx-border')}>
              <Icon name="cpu" size={16} /><span className="flex-1"><span className="block text-[13.5px] font-medium">{m.label}{rank(m.id) < 99 && <span className="ml-2 rounded bg-hx-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-hx-accent-text">Suggested</span>}</span><span className="block text-[11.5px] text-hx-muted">{m.provider} · {Math.round(m.contextWindow / 1000)}K context{m.notes ? ` · ${m.notes}` : ''}</span></span>{prefs.defaultModel === m.id && <Icon name="check" size={16} className="text-hx-accent-text" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Permissions(): React.ReactElement {
  const [mine, err, reload] = useLoad(() => client.settings.mine());
  const [eff] = useLoad(() => client.settings.effective());
  const [draft, setDraft] = useState<{ allow: string; deny: string; ask: string; maxSteps: string; maxCostUsd: string; maxTurnMinutes: string } | null>(null);
  useEffect(() => {
    if (!mine) return;
    const p = (mine.permissions ?? {}) as { allow?: string[]; deny?: string[]; ask?: string[] };
    setDraft({ allow: (p.allow ?? []).join('\n'), deny: (p.deny ?? []).join('\n'), ask: (p.ask ?? []).join('\n'), maxSteps: String(mine.maxSteps ?? ''), maxCostUsd: String(mine.maxCostUsd ?? ''), maxTurnMinutes: String(mine.maxTurnMinutes ?? '') });
  }, [mine]);
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!draft) return <Spinner />;
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const num = (s: string) => (s.trim() && Number(s) > 0 ? Number(s) : undefined);
  const save = async () => { try { await client.settings.saveMine({ permissions: { allow: lines(draft.allow), deny: lines(draft.deny), ask: lines(draft.ask) }, maxSteps: num(draft.maxSteps), maxCostUsd: num(draft.maxCostUsd), maxTurnMinutes: num(draft.maxTurnMinutes) }); toast('Saved', { kind: 'success' }); reload(); } catch (e) { fail(e); } };
  return (
    <div data-section="permissions">
      <p className="mb-2 text-[13px] text-hx-secondary">Your rules are added to the operator's: a deny or ask there can never be loosened here, and your limits apply only where they are lower. One rule per line, e.g. <code>bash(npm test)</code> or <code>edit(src/**)</code>.</p>
      <div className="grid gap-3 md:grid-cols-3">
        {(['allow', 'ask', 'deny'] as const).map((k) => <Field key={k} label={k === 'allow' ? 'Allow without asking' : k === 'ask' ? 'Always ask' : 'Never allow'}><Textarea rows={6} className="font-mono text-[12px]" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></Field>)}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Steps per turn"><Input type="number" value={draft.maxSteps} onChange={(e) => setDraft({ ...draft, maxSteps: e.target.value })} placeholder="operator default" /></Field>
        <Field label="Spend per conversation (USD)"><Input type="number" value={draft.maxCostUsd} onChange={(e) => setDraft({ ...draft, maxCostUsd: e.target.value })} placeholder="operator default" /></Field>
        <Field label="Minutes per turn"><Input type="number" value={draft.maxTurnMinutes} onChange={(e) => setDraft({ ...draft, maxTurnMinutes: e.target.value })} placeholder="no limit" /></Field>
      </div>
      <div className="mt-2 flex justify-end"><Button variant="primary" onClick={() => void save()}>Save</Button></div>
      {eff && eff.length > 0 && <EffectiveTable rows={eff} />}
    </div>
  );
}

function EffectiveTable({ rows }: { rows: EffectiveSetting[] }) {
  return (
    <div className="mt-6" data-effective>
      <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-hx-muted">In force now</h3>
      <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3 px-3 py-1.5 text-[12.5px]">
            <span className="w-48 shrink-0 truncate font-mono text-hx-secondary">{r.key}</span>
            <span className="min-w-0 flex-1 truncate">{typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value)}</span>
            {r.locked && <Icon name="lock" size={12} className="text-hx-muted" />}
            <Badge>{r.source}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Instructions(): React.ReactElement {
  const [v, err] = useLoad(() => client.settings.instructions());
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { if (v) setText(v.content); }, [v]);
  if (err) return <InfoNote>{err}</InfoNote>;
  if (text === null) return <Spinner />;
  return (
    <div data-section="instructions">
      <p className="mb-2 text-[13px] text-hx-secondary">Read at the start of every conversation you own (like a personal CLAUDE.md). The operator's and the project's instructions still apply.</p>
      <Textarea rows={16} className="font-mono text-[12.5px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="E.g. I work in TypeScript; prefer small commits; answer briefly." />
      <div className="mt-2 flex items-center justify-between"><span className="text-[11.5px] text-hx-muted">{text.length} / 24,000</span><Button variant="primary" disabled={text === v?.content} onClick={() => void client.settings.saveInstructions(text).then(() => toast('Saved', { kind: 'success' })).catch(fail)}>Save</Button></div>
    </div>
  );
}

export function Memory(): React.ReactElement {
  const sessions = useData((s) => s.sessions);
  const [sid, setSid] = useState(sessions[0]?.id ?? '');
  const [data, err, reload] = useLoad(() => (sid ? client.memory.list(sid) : Promise.resolve(null)), [sid]);
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null);
  if (!sessions.length) return <EmptyState icon="memory" title="No memory yet">Memory is read through a conversation: start one first.</EmptyState>;
  return (
    <div data-section="memory">
      <Field label="Through the conversation" help="Memory is shared across your conversations; the project scope follows the conversation's folder." inline><Select value={sid} onChange={setSid} options={sessions.slice(0, 50).map((s: SessionMeta) => ({ value: s.id, label: s.title || s.id }))} className="w-64" /></Field>
      {err ? <InfoNote>{err}</InfoNote> : !data ? <Spinner /> : (
        <>
          <div className="mb-2 text-[12px] text-hx-muted">Mode: {data.mode === 'read' ? 'read only' : 'on'}</div>
          {!data.files.length ? <p className="text-[13px] text-hx-muted">Nothing remembered yet.</p> : (
            <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
              {data.files.map((f) => (
                <div key={f.path} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                  <Icon name="file-text" size={14} className="text-hx-muted" /><span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.path}</span>
                  <Button size="sm" variant="ghost" onClick={() => void client.memory.read(sid, f.path).then((r) => setOpen(r)).catch(fail)}>Open</Button>
                  <IconButton size="xs" icon="trash" tone="danger" label="Forget" onClick={() => void client.memory.remove(sid, f.path).then(reload).catch(fail)} />
                </div>
              ))}
            </div>
          )}
          {open && (
            <div className="mt-3">
              <div className="mb-1 font-mono text-[12px] text-hx-muted">{open.path}</div>
              <Textarea rows={10} className="font-mono text-[12px]" value={open.content} onChange={(e) => setOpen({ ...open, content: e.target.value })} />
              <div className="mt-2 flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(null)}>Close</Button><Button variant="primary" onClick={() => void client.memory.write(sid, open.path, open.content).then(() => { toast('Saved'); reload(); }).catch(fail)}>Save</Button></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Vault(): React.ReactElement {
  const [data, err, reload] = useLoad(() => client.vault.list());
  const [form, setForm] = useState({ name: '', value: '', description: '', scope: 'user' });
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!data) return <Spinner />;
  return (
    <div data-section="vault">
      <p className="mb-3 text-[13px] text-hx-secondary">Secrets the agent's tools can use by name (never shown to the model, never returned here).</p>
      {!data.entries.length ? <p className="mb-3 text-[13px] text-hx-muted">No entries yet.</p> : (
        <div className="mb-4 divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
          {data.entries.map((e: VaultEntry) => (
            <div key={`${e.scope}:${e.name}`} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <Icon name="vault" size={14} className="text-hx-muted" /><span className="font-mono text-[12.5px]">{e.name}</span><Badge>{e.scope ?? 'user'}</Badge>
              <span className="min-w-0 flex-1 truncate text-[12px] text-hx-muted">{e.description}</span>
              <IconButton size="xs" icon="trash" tone="danger" label="Delete" onClick={() => void client.vault.remove(e.name, e.scope).then(reload).catch(fail)} />
            </div>
          ))}
        </div>
      )}
      <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-hx-muted">Add an entry</h3>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="github-token" /></Field>
        <Field label="Scope"><Select value={form.scope} onChange={(v) => setForm({ ...form, scope: v })} options={[{ value: 'user', label: 'Mine' }, { value: 'operator', label: 'Operator (administrators)' }]} /></Field>
      </div>
      <Field label="Value"><SecretInput value={form.value} onChange={(v) => setForm({ ...form, value: v })} /></Field>
      <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <div className="flex justify-end"><Button variant="primary" disabled={!form.name || !form.value} onClick={() => void client.vault.put(form).then(() => { setForm({ name: '', value: '', description: '', scope: 'user' }); reload(); toast('Stored'); }).catch(fail)}>Store</Button></div>
    </div>
  );
}

export function Schedules(): React.ReactElement {
  const [list, err, reload] = useLoad(() => client.schedules.list());
  const [form, setForm] = useState({ title: '', prompt: '', cron: '', inMinutes: '' });
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!list) return <Spinner />;
  return (
    <div data-section="schedules">
      {!list.length ? <p className="mb-3 text-[13px] text-hx-muted">Nothing scheduled.</p> : (
        <div className="mb-4 divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
          {list.map((s: Schedule) => (
            <div key={s.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <Icon name="clock" size={14} className="text-hx-muted" />
              <span className="min-w-0 flex-1"><span className="block truncate">{s.title || s.prompt}</span><span className="block text-[11.5px] text-hx-muted">{s.cron ?? (s.at ? new Date(s.at).toLocaleString() : 'trigger')}{s.nextRun ? ` · next ${new Date(s.nextRun).toLocaleString()}` : ''}</span></span>
              <Switch checked={s.enabled} onChange={(v) => void client.schedules.setEnabled(s.id, v).then(reload).catch(fail)} label="Enabled" />
              <IconButton size="xs" icon="play" label="Run now" onClick={() => void client.schedules.run(s.id).then(() => toast('Started')).catch(fail)} />
              <IconButton size="xs" icon="trash" tone="danger" label="Delete" onClick={() => void client.schedules.remove(s.id).then(reload).catch(fail)} />
            </div>
          ))}
        </div>
      )}
      <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-hx-muted">New schedule</h3>
      <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <Field label="Prompt"><Textarea rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} /></Field>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Cron (five fields)" help="e.g. 0 9 * * 1-5"><Input className="font-mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} /></Field>
        <Field label="Or once, in minutes"><Input type="number" value={form.inMinutes} onChange={(e) => setForm({ ...form, inMinutes: e.target.value })} /></Field>
      </div>
      <div className="flex justify-end"><Button variant="primary" disabled={!form.prompt.trim() || (!form.cron.trim() && !form.inMinutes)} onClick={() => void client.schedules.create({ title: form.title || undefined, prompt: form.prompt, ...(form.cron.trim() ? { cron: form.cron.trim() } : { inMinutes: Number(form.inMinutes) }) }).then(() => { setForm({ title: '', prompt: '', cron: '', inMinutes: '' }); reload(); toast('Scheduled'); }).catch(fail)}>Schedule</Button></div>
    </div>
  );
}

export function McpBundles(): React.ReactElement {
  const [list, err, reload] = useLoad(() => client.mcpb.list());
  const install = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.mcpb';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => void client.mcpb.install(String(r.result).split(',')[1] ?? '').then((b) => { toast(`Installed ${b.name}`, { kind: 'success' }); reload(); }).catch(fail);
      r.readAsDataURL(f);
    };
    input.click();
  };
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!list) return <Spinner />;
  return (
    <div data-section="mcp">
      <div className="mb-3 flex items-center"><p className="flex-1 text-[13px] text-hx-secondary">MCP servers packed as .mcpb bundles, installed for every new conversation on this server.</p><Button icon="upload" onClick={install}>Install a bundle…</Button></div>
      {!list.length ? <p className="text-[13px] text-hx-muted">No bundles installed.</p> : (
        <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
          {list.map((b: McpBundle) => <div key={b.name} className="flex items-center gap-2 px-3 py-2 text-[13px]"><Icon name="plug" size={14} className="text-hx-muted" /><span className="font-medium">{b.name}</span><span className="text-[11.5px] text-hx-muted">{b.version}</span><span className="min-w-0 flex-1 truncate text-[12px] text-hx-muted">{b.description}</span><IconButton size="xs" icon="trash" tone="danger" label="Remove" onClick={() => void client.mcpb.remove(b.name).then(reload).catch(fail)} /></div>)}
        </div>
      )}
    </div>
  );
}
