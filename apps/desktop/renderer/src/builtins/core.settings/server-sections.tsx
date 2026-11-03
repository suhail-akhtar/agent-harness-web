/**
 * Settings kept by the server: Models & providers, Permissions & limits, Instructions, Memory,
 * Vault, Schedules, MCP bundles. Each degrades to a note when the server does not offer it.
 */

import React, { useEffect, useState } from 'react';
import type { Delegation, EffectiveSetting, McpBundle, ProviderInfo, SessionMeta, VaultEntry } from '@harness/client';
import { isMissing } from '@harness/client';
import { Badge, Button, EmptyState, Field, Icon, IconButton, Input, InfoNote, Select, Spinner, Switch, Textarea, cx, toast, SecretInput } from '@harness/ui';
import { useData, client } from '../../state/data';
import { useApp } from '../../state/app';
import { recommendedModel } from '../../state/recommend';
import { ScheduleManager } from '../core.scheduled/Scheduled';

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
  const connected = providers.filter((p) => p.configured);
  const others = providers.filter((p) => !p.configured);
  const ready = models.filter((m) => m.available).length;
  const group = (title: string, list: ProviderInfo[]) => list.length > 0 && (
    <div className="mt-4">
      <h3 className="mb-1.5 text-caption font-medium uppercase tracking-wide text-hx-muted">{title}</h3>
      <div className="divide-y divide-hx-border-subtle overflow-hidden rounded-xl border border-hx-border-subtle bg-hx-elevated">
        {list.map((p) => <ProviderRow key={p.id} p={p} admin={admin} models={models.filter((m) => m.provider === p.id)} onChanged={refresh} />)}
      </div>
    </div>
  );
  return (
    <div data-section="models">
      <p className="text-body text-hx-secondary" data-providers-summary>
        {connected.length} of {providers.length} providers connected · {ready} model{ready === 1 ? '' : 's'} ready to use.
        {!onboarding && ' Keys are kept in the server\'s key vault and never shown again.'}
      </p>
      {!admin && <div className="mt-3"><InfoNote tone="warning">Only administrators change keys on this server.</InfoNote></div>}
      {group('Connected', connected)}
      {group('Not connected', others)}
      {!onboarding && <DelegationSettings />}
    </div>
  );
}

/**
 * Delegation (your account's `delegation` setting): which other models agents may hand work to
 * (sub-agents, linked sessions, workflow agent nodes), whether the first hand-off to each provider
 * in a conversation asks you, and a cost cap for that work. Within the operator's cap.
 */
export function DelegationSettings(): React.ReactElement {
  const models = useData((s) => s.models);
  const providers = useData((s) => s.providers);
  const [saved, setSaved] = useState<Delegation | null>(null);
  const [v, setV] = useState<Delegation>({});
  const [cap, setCap] = useState<string[] | '*' | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    client.settings.mine().then((m) => { const d = (m.delegation ?? {}) as Delegation; setSaved(d); setV(d); }).catch((e: Error) => { setErr(e.message); setSaved({}); });
    client.settings.effective().then((rows) => {
      const op = rows?.find((r) => r.key === 'delegation')?.layers?.find((l) => l.source === 'operator')?.value as { allowedModels?: string[] | '*' } | undefined;
      setCap(op?.allowedModels ?? '*');
    }).catch(() => setCap('*'));
  }, []);
  if (!saved) return <div className="mt-6"><Spinner /></div>;
  const any = v.allowedModels === '*';
  const list = Array.isArray(v.allowedModels) ? v.allowedModels : [];
  const allowedByOperator = (id: string) => cap === null || cap === '*' || cap.includes(id);
  const toggle = (id: string, on: boolean) => setV({ ...v, allowedModels: on ? [...new Set([...list, id])] : list.filter((x) => x !== id) });
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const m = await client.settings.mine();
      const clean: Delegation = { ...(v.allowedModels !== undefined && (v.allowedModels === '*' || v.allowedModels.length) ? { allowedModels: v.allowedModels } : {}), ...(v.requireApproval ? { requireApproval: true } : {}), ...(v.maxCostUsd ? { maxCostUsd: v.maxCostUsd } : {}) };
      const { delegation: _old, ...rest } = m as Record<string, unknown> & { delegation?: unknown };
      await client.settings.saveMine(Object.keys(clean).length ? { ...rest, delegation: clean } : rest);
      setSaved(clean); setV(clean); toast('Delegation saved: new hand-offs follow it', { kind: 'success' });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  // The models by provider, connected providers first, so the list reads like the one above.
  const byProvider = [...new Set(models.map((m) => m.provider))].map((id) => ({ id, models: models.filter((m) => m.provider === id) }))
    .sort((a, b) => Number(b.models.some((m) => m.available)) - Number(a.models.some((m) => m.available)));
  const chosen = any ? models.filter((m) => allowedByOperator(m.id)).length : list.length;
  return (
    <section data-delegation className="mt-8">
      <div className="flex items-center gap-2"><Icon name="split" size={16} className="text-hx-muted" /><h3 className="text-body-lg font-medium">Models your agents can hand work to</h3></div>
      <p className="mt-1 text-small text-hx-secondary">Sub-agents, linked sessions and workflow steps may run on these, besides the conversation's own model. What they pass on goes to that model's company. With none picked, agents use the conversation's model only.</p>
      <div className="mt-3 rounded-xl border border-hx-border-subtle bg-hx-elevated px-4 py-1">
        <Field inline label="Any model the server allows" help={any ? 'Every model below may be used.' : `${chosen} picked below.`}>
          <Switch checked={any} onChange={(on) => setV({ ...v, allowedModels: on ? '*' : [] })} label="Any model the server allows" />
        </Field>
        {!any && (
          <div className="space-y-3 border-t border-hx-border-subtle py-3" data-delegation-models>
            {byProvider.map((g) => {
              const live = g.models.some((m) => m.available);
              return (
                <div key={g.id}>
                  <div className="mb-1 flex items-center gap-2 text-caption font-medium uppercase tracking-wide text-hx-muted">
                    <span className={cx('h-1.5 w-1.5 rounded-full', live ? 'bg-hx-success' : 'bg-hx-active')} aria-hidden />{providers?.find((p) => p.id === g.id)?.label ?? g.id}{!live && <span className="font-normal normal-case tracking-normal">· not connected</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.models.map((m) => {
                      const ok = allowedByOperator(m.id);
                      const on = list.includes(m.id);
                      return (
                        <label key={m.id} data-delegation-model={m.id} title={ok ? m.notes : 'Not allowed by the operator'}
                          className={cx('inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-small', on ? 'border-hx-accent bg-hx-accent-soft text-hx-accent-text' : 'border-hx-border-subtle text-hx-secondary hover:border-hx-border', (!ok || !m.available) && !on && 'opacity-60', !ok && 'cursor-not-allowed')}>
                          <input type="checkbox" className="sr-only" checked={on} disabled={!ok} onChange={(e) => toggle(m.id, e.target.checked)} />
                          {on && <Icon name="check" size={12} />}{m.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="border-t border-hx-border-subtle">
          <Field inline label="Ask me first" help="Before the first hand-off to each company in a conversation.">
            <Switch checked={!!v.requireApproval} onChange={(on) => setV({ ...v, requireApproval: on })} label="Ask me before the first hand-off to each provider in a conversation" />
          </Field>
        </div>
        <div className="border-t border-hx-border-subtle">
          <Field inline label="Spending cap (USD)" help="For handed-off work, per conversation. Empty: no cap of your own.">
            <Input type="number" min={0} step={0.05} className="w-28" placeholder="No cap" aria-label="Cost cap in USD" data-delegation-cap value={v.maxCostUsd ?? ''} onChange={(e) => { const n = Number(e.target.value); setV({ ...v, maxCostUsd: e.target.value === '' || !(n > 0) ? undefined : n }); }} />
          </Field>
        </div>
      </div>
      {cap !== null && cap !== '*' && <p className="mt-2 text-caption text-hx-muted">The operator allows: {cap.join(', ') || 'no other model'}.</p>}
      {err && <p className="mt-2 text-small text-hx-danger">{err}</p>}
      {dirty && <div className="mt-3 flex items-center justify-end gap-2"><span className="mr-auto text-small text-hx-muted">Unsaved changes</span><Button disabled={busy} onClick={() => setV(saved)}>Reset</Button><Button variant="primary" loading={busy} data-save-delegation onClick={() => void save()}>Save</Button></div>}
    </section>
  );
}

/** Where a connected provider's key comes from, in plain words. */
const keySource = (p: ProviderInfo) => p.keyless ? 'No key needed' : p.source === 'env' ? 'Key from the server\'s environment' : p.source === 'vault' ? 'Key saved here' : 'Ready';

/**
 * One provider: a row (name, whether it is connected, its models) that opens to its key, a test,
 * and, under Advanced, its address and switches. A provider without a key offers Connect.
 */
function ProviderRow({ p, admin, models, onChanged }: { p: ProviderInfo; admin: boolean; models: import('@harness/client').ModelInfo[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [key, setKey] = useState('');
  const [base, setBase] = useState(p.baseUrl ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (what: string, f: () => Promise<unknown>) => { setBusy(what); try { await f(); await onChanged(); } catch (e) { fail(e); } finally { setBusy(null); } };
  const name = p.label ?? p.id;
  const hasAdvanced = admin && (p.baseUrlEditable || (p.options ?? []).length > 0);
  return (
    <div data-provider={p.id} data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hx-hover">
        <span className={cx('h-2 w-2 shrink-0 rounded-full', p.configured ? 'bg-hx-success' : 'bg-hx-active')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium text-hx-primary">{name}</span>
          <span className="block truncate text-caption text-hx-muted">{p.configured ? keySource(p) : 'Not connected'}{models.length ? ` · ${models.length} model${models.length === 1 ? '' : 's'}: ${models.map((m) => m.label).join(', ')}` : ''}</span>
        </span>
        {!p.configured && admin && !open && <span className="rounded-md bg-hx-accent px-2.5 py-1 text-small font-medium text-white">Connect</span>}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} className="text-hx-muted" />
      </button>
      {open && (
        <div className="space-y-3 border-t border-hx-border-subtle bg-hx-bg/40 px-4 py-3">
          {admin && !p.keyless && (
            <div>
              <div className="mb-1.5 text-small font-medium text-hx-primary">{p.configured ? 'Replace the key' : `${name} API key`}</div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[220px] flex-1"><SecretInput value={key} onChange={setKey} placeholder={p.configured ? 'Paste a new key' : 'Paste an API key'} /></div>
                <Button size="sm" variant="primary" disabled={!key.trim() || !!busy} loading={busy === 'save'} data-save-key onClick={() => void run('save', async () => { const r = await client.providers.set(p.id, { apiKey: key.trim() }); setKey(''); toast(r.note ?? 'Key saved', { kind: 'success' }); })}>Save key</Button>
                <Button size="sm" disabled={!!busy} loading={busy === 'test'} data-test-key onClick={() => void (async () => { setBusy('test'); try { const r = await client.providers.test(p.id); setTest({ ok: r.ok, text: r.ok ? `It works${r.model ? ` (${r.model})` : ''}${r.latencyMs ? `, ${r.latencyMs} ms` : ''}` : r.error ?? 'Failed' }); } catch (e) { setTest({ ok: false, text: (e as Error).message }); } finally { setBusy(null); } })()}>Test</Button>
                {p.source === 'vault' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('remove', async () => { await client.providers.removeKey(p.id); toast('Key removed'); })}>Remove key</Button>}
              </div>
              {p.source === 'env' && <p className="mt-1.5 text-caption text-hx-muted">The server's environment sets this key{p.keyEnv?.length ? ` (${p.keyEnv.join(' or ')})` : ''}; it wins over one saved here.</p>}
              {!p.configured && p.keyEnv?.length ? <p className="mt-1.5 text-caption text-hx-muted">Or set {p.keyEnv.join(' or ')} in the server's environment.</p> : null}
            </div>
          )}
          {test && <div data-test-result={test.ok ? 'ok' : 'error'} className={cx('text-small', test.ok ? 'text-hx-success' : 'text-hx-danger')}>{test.text}</div>}
          {hasAdvanced && (
            <div>
              <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} className="inline-flex items-center gap-1 text-small text-hx-secondary hover:text-hx-primary">
                <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={14} />Advanced
              </button>
              {advanced && (
                <div className="mt-1 space-y-1 pl-5">
                  {p.baseUrlEditable && (
                    <Field label="Address" help="Leave empty for the provider's own.">
                      <div className="flex items-center gap-2">
                        <Input className="font-mono text-small" value={base} placeholder="Default address" onChange={(e) => setBase(e.target.value)} aria-label={`${name} address`} />
                        <Button size="sm" disabled={!!busy || base === (p.baseUrl ?? '')} onClick={() => void run('base', async () => { await client.providers.set(p.id, { baseUrl: base.trim() || null }); toast('Address saved'); })}>Save</Button>
                      </div>
                    </Field>
                  )}
                  {(p.options ?? []).map((o) => (
                    <div key={o.id} data-provider-option={`${p.id}:${o.id}`}>
                      <Field inline label={o.label} help={o.help ? `${o.help}${!p.configured ? ' Needs a key first.' : ''}` : undefined}>
                        <Switch checked={o.value} disabled={!!busy || !p.configured} label={o.label} onChange={(v) => void run('option', async () => { await client.providers.set(p.id, { options: { [o.id]: v } }); toast(`${o.label}: ${v ? 'on' : 'off'}`); })} />
                      </Field>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function OnboardProvider(): React.ReactElement {
  return <div className="px-6 py-4"><p className="mb-3 text-body text-hx-secondary">Add a key for at least one provider. DeepSeek (inexpensive) or Anthropic (Claude Sonnet) are good places to start.</p><ModelsProviders onboarding /></div>;
}

/** The defaults onboarding suggests, in order. */
export const SUGGESTED_MODELS = ['claude-sonnet-5-5', 'deepseek-flash'];

export function OnboardModel(): React.ReactElement {
  const models = useData((s) => s.models);
  const prefs = useApp((s) => s.prefs);
  // Recommended first: Claude Sonnet 5.5 with an Anthropic key, else DeepSeek Flash (state/recommend.ts).
  const rec = recommendedModel(models);
  const rank = (id: string) => (id === rec?.id ? -1 : SUGGESTED_MODELS.includes(id) ? SUGGESTED_MODELS.indexOf(id) : 99);
  const available = models.filter((m) => m.available).sort((a, b) => rank(a.id) - rank(b.id));
  // The recommendation becomes the default unless the person already picked one that works.
  useEffect(() => { if (rec && !available.some((m) => m.id === prefs.defaultModel)) useApp.getState().setPrefs({ defaultModel: rec.id }); }, [rec?.id, available.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="px-6 py-4" data-onboard-model data-recommended={rec?.id}>
      {!available.length ? <InfoNote tone="warning">No model has a key yet: go back a step and add one.</InfoNote> : (
        <div className="space-y-1.5">
          {rec && <p className="mb-2 text-small text-hx-secondary">{rec.why}</p>}
          {available.map((m) => (
            <button key={m.id} type="button" data-model-choice={m.id} onClick={() => useApp.getState().setPrefs({ defaultModel: m.id })} className={cx('flex w-full items-center gap-3 rounded-xl border p-3 text-left', prefs.defaultModel === m.id ? 'border-hx-accent bg-hx-accent-soft' : 'border-hx-border-subtle hover:border-hx-border')}>
              <Icon name="cpu" size={16} /><span className="flex-1"><span className="block text-body font-medium">{m.label}{m.id === rec?.id && <span className="ml-2 rounded bg-hx-accent-soft px-1.5 py-0.5 text-micro font-medium text-hx-accent-text" data-recommended-badge>Recommended</span>}</span><span className="block text-caption text-hx-muted">{m.provider} · {Math.round(m.contextWindow / 1000)}K context{m.notes ? ` · ${m.notes}` : ''}</span></span>{prefs.defaultModel === m.id && <Icon name="check" size={16} className="text-hx-accent-text" />}
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
  const [draft, setDraft] = useState<{ allow: string; deny: string; ask: string; maxSteps: string; maxCostUsd: string; maxTurnMinutes: string; verifyTurns: boolean; record: boolean } | null>(null);
  useEffect(() => {
    if (!mine) return;
    const p = (mine.permissions ?? {}) as { allow?: string[]; deny?: string[]; ask?: string[] };
    setDraft({ allow: (p.allow ?? []).join('\n'), deny: (p.deny ?? []).join('\n'), ask: (p.ask ?? []).join('\n'), maxSteps: String(mine.maxSteps ?? ''), maxCostUsd: String(mine.maxCostUsd ?? ''), maxTurnMinutes: String(mine.maxTurnMinutes ?? ''), verifyTurns: mine.verifyTurns === true, record: mine.record === true });
  }, [mine]);
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!draft) return <Spinner />;
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const num = (s: string) => (s.trim() && Number(s) > 0 ? Number(s) : undefined);
  // The rest of the person's settings (delegation, linked sessions) are kept: the server replaces what it is sent.
  const save = async () => { try { await client.settings.saveMine({ ...mine, permissions: { allow: lines(draft.allow), deny: lines(draft.deny), ask: lines(draft.ask) }, maxSteps: num(draft.maxSteps), maxCostUsd: num(draft.maxCostUsd), maxTurnMinutes: num(draft.maxTurnMinutes), verifyTurns: draft.verifyTurns, record: draft.record }); toast('Saved', { kind: 'success' }); reload(); } catch (e) { fail(e); } };
  return (
    <div data-section="permissions">
      <p className="mb-2 text-body text-hx-secondary">Your rules are added to the operator's: a deny or ask there can never be loosened here, and your limits apply only where they are lower. One rule per line, e.g. <code>bash(npm test)</code> or <code>edit(src/**)</code>.</p>
      <div className="grid gap-3 md:grid-cols-3">
        {(['allow', 'ask', 'deny'] as const).map((k) => <Field key={k} label={k === 'allow' ? 'Allow without asking' : k === 'ask' ? 'Always ask' : 'Never allow'}><Textarea rows={6} className="font-mono text-small" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></Field>)}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Steps per turn"><Input type="number" value={draft.maxSteps} onChange={(e) => setDraft({ ...draft, maxSteps: e.target.value })} placeholder="operator default" /></Field>
        <Field label="Spend per conversation (USD)"><Input type="number" value={draft.maxCostUsd} onChange={(e) => setDraft({ ...draft, maxCostUsd: e.target.value })} placeholder="operator default" /></Field>
        <Field label="Minutes per turn"><Input type="number" value={draft.maxTurnMinutes} onChange={(e) => setDraft({ ...draft, maxTurnMinutes: e.target.value })} placeholder="no limit" /></Field>
      </div>
      <div className="mt-3" data-verify-turns={draft.verifyTurns ? 'on' : 'off'}>
        <Switch checked={draft.verifyTurns} onChange={(on) => setDraft({ ...draft, verifyTurns: on })} label="Check each turn's changes with a verifier before it ends" />
        <p className="mt-1 text-small text-hx-secondary">A second agent with a clean context reads what the turn changed against what you asked; what it finds goes back to the agent first. One more model run for each turn that changes files.</p>
      </div>
      <div className="mt-3" data-record-runs={draft.record ? 'on' : 'off'}>
        <Switch checked={draft.record} onChange={(on) => setDraft({ ...draft, record: on })} label="Record my conversations (a run record you can verify and export)" />
        <p className="mt-1 text-small text-hx-secondary">Every step, model call and tool result is kept in a hash-chained record, signed when exported; a conversation's record is under Agents &gt; Run record beside it. New conversations from now on.</p>
      </div>
      <div className="mt-2 flex justify-end"><Button variant="primary" onClick={() => void save()}>Save</Button></div>
      {eff && eff.length > 0 && <EffectiveTable rows={eff} />}
    </div>
  );
}

function EffectiveTable({ rows }: { rows: EffectiveSetting[] }) {
  return (
    <div className="mt-6" data-effective>
      <h3 className="mb-1 text-tiny font-semibold uppercase tracking-wide text-hx-muted">In force now</h3>
      <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3 px-3 py-1.5 text-small">
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
      <p className="mb-2 text-body text-hx-secondary">Read at the start of every conversation you own (like a personal CLAUDE.md). The operator's and the project's instructions still apply.</p>
      <Textarea rows={16} className="font-mono text-small" value={text} onChange={(e) => setText(e.target.value)} placeholder="E.g. I work in TypeScript; prefer small commits; answer briefly." />
      <div className="mt-2 flex items-center justify-between"><span className="text-caption text-hx-muted">{text.length} / 24,000</span><Button variant="primary" disabled={text === v?.content} onClick={() => void client.settings.saveInstructions(text).then(() => toast('Saved', { kind: 'success' })).catch(fail)}>Save</Button></div>
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
          <div className="mb-2 text-small text-hx-muted">Mode: {data.mode === 'read' ? 'read only' : 'on'}</div>
          {!data.files.length ? <p className="text-body text-hx-muted">Nothing remembered yet.</p> : (
            <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
              {data.files.map((f) => (
                <div key={f.path} className="flex items-center gap-2 px-3 py-2 text-body">
                  <Icon name="file-text" size={14} className="text-hx-muted" /><span className="min-w-0 flex-1 truncate font-mono text-small">{f.path}</span>
                  <Button size="sm" variant="ghost" onClick={() => void client.memory.read(sid, f.path).then((r) => setOpen(r)).catch(fail)}>Open</Button>
                  <IconButton size="xs" icon="trash" tone="danger" label="Forget" onClick={() => void client.memory.remove(sid, f.path).then(reload).catch(fail)} />
                </div>
              ))}
            </div>
          )}
          {open && (
            <div className="mt-3">
              <div className="mb-1 font-mono text-small text-hx-muted">{open.path}</div>
              <Textarea rows={10} className="font-mono text-small" value={open.content} onChange={(e) => setOpen({ ...open, content: e.target.value })} />
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
      <p className="mb-3 text-body text-hx-secondary">Secrets the agent's tools can use by name (never shown to the model, never returned here).</p>
      {!data.entries.length ? <p className="mb-3 text-body text-hx-muted">No entries yet.</p> : (
        <div className="mb-4 divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
          {data.entries.map((e: VaultEntry) => (
            <div key={`${e.scope}:${e.name}`} className="flex items-center gap-2 px-3 py-2 text-body">
              <Icon name="vault" size={14} className="text-hx-muted" /><span className="font-mono text-small">{e.name}</span><Badge>{e.scope ?? 'user'}</Badge>
              <span className="min-w-0 flex-1 truncate text-small text-hx-muted">{e.description}</span>
              <IconButton size="xs" icon="trash" tone="danger" label="Delete" onClick={() => void client.vault.remove(e.name, e.scope).then(reload).catch(fail)} />
            </div>
          ))}
        </div>
      )}
      <h3 className="mb-1 text-tiny font-semibold uppercase tracking-wide text-hx-muted">Add an entry</h3>
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
  return <div data-section="schedules"><ScheduleManager embedded /></div>;
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
      <div className="mb-3 flex items-center"><p className="flex-1 text-body text-hx-secondary">MCP servers packed as .mcpb bundles, installed for every new conversation on this server.</p><Button icon="upload" onClick={install}>Install a bundle…</Button></div>
      {!list.length ? <p className="text-body text-hx-muted">No bundles installed.</p> : (
        <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
          {list.map((b: McpBundle) => <div key={b.name} className="flex items-center gap-2 px-3 py-2 text-body"><Icon name="plug" size={14} className="text-hx-muted" /><span className="font-medium">{b.name}</span><span className="text-caption text-hx-muted">{b.version}</span><span className="min-w-0 flex-1 truncate text-small text-hx-muted">{b.description}</span><IconButton size="xs" icon="trash" tone="danger" label="Remove" onClick={() => void client.mcpb.remove(b.name).then(reload).catch(fail)} /></div>)}
        </div>
      )}
    </div>
  );
}
