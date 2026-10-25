/**
 * Settings on this machine: Appearance, General, Application, Shortcuts, Servers, About.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Icon, IconButton, Input, Kbd, Select, Switch, Spinner, cx, toast, InfoNote, Page } from '@harness/ui';
import { useApp } from '../../state/app';
import { useData, client } from '../../state/data';
import { allThemes } from '../../state/theme';
import { ProductMark } from '../../components/ProductMark';
import { desktop, platform, type HomeInfo, type ServersInfo } from '../../bridge';
import { chordFromEvent, conflicts, formatChord } from '../../registry/keybindings';
import type { DesktopPrefs } from '@desk/prefs';

const set = (patch: Partial<DesktopPrefs>) => useApp.getState().setPrefs(patch);
const Section = ({ title, children }: { title?: string; children: React.ReactNode }) => (
  <section className="mb-6">{title && <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-hx-muted">{title}</h3>}<div className="divide-y divide-hx-border-subtle">{children}</div></section>
);

export function Appearance(): React.ReactElement {
  const prefs = useApp((s) => s.prefs);
  const registry = useData((s) => s.registry);
  const info = useApp((s) => s.info);
  const themes = useMemo(() => allThemes(registry, prefs.accent || info?.product.brand.accent), [registry, prefs.accent, info]);
  const choices = [{ id: 'system', label: 'System', mode: 'light' as const, colors: themes[0]!.colors }, ...themes];
  return (
    <div data-section="appearance">
      <Section title="Theme">
        <div className="grid grid-cols-2 gap-2 py-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
          {choices.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={prefs.theme === t.id} data-theme-choice={t.id} onClick={() => set({ theme: t.id })}
              className={cx('overflow-hidden rounded-xl border text-left', prefs.theme === t.id ? 'border-hx-accent ring-2 ring-hx-accent/35' : 'border-hx-border-subtle hover:border-hx-border')}>
              <div className="flex h-14 items-end gap-1 p-2" style={{ background: t.id === 'system' ? `linear-gradient(90deg, ${themes[0]!.colors.background} 50%, ${themes[1]!.colors.background} 50%)` : t.colors.background }}>
                <span className="h-2 w-10 rounded-full" style={{ background: t.id === 'system' ? themes[0]!.colors.foreground : t.colors.foreground, opacity: 0.7 }} />
                <span className="h-2 w-5 rounded-full" style={{ background: t.colors.accent }} />
              </div>
              <div className="px-2.5 py-1.5 text-[12.5px]">{t.label}{t.source && t.source !== 'core' && t.source !== 'core.shell' && <span className="ml-1 text-[11px] text-hx-muted">· {t.source}</span>}</div>
            </button>
          ))}
        </div>
        <Field label="Accent colour" help="For the built-in light and dark themes. Empty: the product's own." inline>
          <div className="flex items-center gap-2">
            <input type="color" aria-label="Accent colour" value={prefs.accent || info?.product.brand.accent || '#d97757'} onChange={(e) => set({ accent: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-hx-border bg-transparent" />
            {prefs.accent && <Button size="sm" variant="ghost" onClick={() => set({ accent: '' })}>Reset</Button>}
          </div>
        </Field>
        <Field label="Contrast" help="Stronger text and borders." inline><Switch checked={prefs.contrast === 'strong'} onChange={(v) => set({ contrast: v ? 'strong' : 'normal' })} label="Strong contrast" /></Field>
      </Section>
      <Section title="Text and layout">
        <Field label="Text size" inline><div className="flex items-center gap-2"><input type="range" min={12} max={18} value={prefs.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} aria-label="Text size" /><span className="w-10 text-[12px] text-hx-muted">{prefs.fontSize}px</span></div></Field>
        <Field label="Density" inline><Select value={prefs.density} onChange={(v) => set({ density: v as DesktopPrefs['density'] })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} className="w-40" /></Field>
        <Field label="Transcript width" inline><Select value={prefs.transcriptWidth} onChange={(v) => set({ transcriptWidth: v as DesktopPrefs['transcriptWidth'] })} options={[{ value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }, { value: 'full', label: 'Full width' }]} className="w-40" /></Field>
        <Field label="Interface font"><Input value={prefs.uiFont} onChange={(e) => set({ uiFont: e.target.value })} /></Field>
        <Field label="Code font"><Input className="font-mono" value={prefs.codeFont} onChange={(e) => set({ codeFont: e.target.value })} /></Field>
        <Field label="Reduce motion" inline><Switch checked={prefs.motion === 'reduced'} onChange={(v) => set({ motion: v ? 'reduced' : 'system' })} label="Reduce motion" /></Field>
      </Section>
    </div>
  );
}

export function General(): React.ReactElement {
  const prefs = useApp((s) => s.prefs);
  const models = useData((s) => s.models);
  return (
    <div data-section="general">
      <Section title="Composer">
        <Field label="Send with" inline><Select value={prefs.sendKey} onChange={(v) => set({ sendKey: v as DesktopPrefs['sendKey'] })} options={[{ value: 'enter', label: 'Enter (Shift+Enter: new line)' }, { value: 'mod-enter', label: `${formatChord('Mod+Enter', platform)} (Enter: new line)` }]} className="w-64" /></Field>
        <Field label="Tool steps" help="Under each reply's “Worked for …” line." inline><Select value={prefs.steps} onChange={(v) => set({ steps: v as DesktopPrefs['steps'] })} options={[{ value: 'collapsed', label: 'Folded' }, { value: 'expanded', label: 'Open' }]} className="w-40" /></Field>
      </Section>
      <Section title="New conversations">
        <Field label="Default model" inline><Select value={prefs.defaultModel} onChange={(v) => set({ defaultModel: v })} options={[{ value: '', label: 'The first with a key' }, ...models.map((m) => ({ value: m.id, label: `${m.label}${m.available ? '' : ' (no key)'}`, disabled: !m.available }))]} className="w-64" /></Field>
        <Field label="Default permission mode" inline><Select value={prefs.defaultMode} onChange={(v) => set({ defaultMode: v })} options={[{ value: 'default', label: 'Ask first' }, { value: 'acceptEdits', label: 'Accept edits' }, { value: 'plan', label: 'Plan first' }, { value: 'auto', label: 'Auto' }, { value: 'dontAsk', label: "Don't ask" }]} className="w-64" /></Field>
      </Section>
      <Section title="Notifications">
        <Field label="Notify me" help="Only while the window is in the background: approvals, questions, finished work." inline><Switch checked={prefs.notifications} onChange={(v) => set({ notifications: v })} label="Notifications" /></Field>
      </Section>
    </div>
  );
}

export function Application(): React.ReactElement {
  const prefs = useApp((s) => s.prefs);
  const info = useApp((s) => s.info);
  const engine = useApp((s) => s.engine);
  const [logs, setLogs] = useState<string[] | null>(null);
  return (
    <div data-section="application">
      <Section title="Startup">
        <Field label="Start at login" inline><Switch checked={prefs.startAtLogin} onChange={(v) => { set({ startAtLogin: v }); void desktop.setLoginItem(v).catch(() => {}); }} label="Start at login" /></Field>
        <Field label="Keep running in the tray" help="Closing the window leaves the app in the tray." inline><Switch checked={prefs.keepInTray} onChange={(v) => set({ keepInTray: v })} label="Keep in tray" /></Field>
        <Field label="Prevent sleep while working" inline><Switch checked={prefs.preventSleep} onChange={(v) => set({ preventSleep: v })} label="Prevent sleep" /></Field>
      </Section>
      <Section title="Engine">
        <Field label="Status" inline>
          <div className="flex items-center gap-2" data-engine-row><Badge tone={engine.status === 'ready' ? 'success' : engine.status === 'starting' ? 'warning' : 'danger'}>{engine.status}</Badge>
            <Button size="sm" icon="refresh" onClick={() => void desktop.engineRestart()}>Restart</Button>
            <Button size="sm" variant="ghost" onClick={() => void desktop.engineLogs().then(setLogs)}>Show log</Button></div>
        </Field>
        {logs && <pre className="hx-scroll my-2 max-h-64 overflow-auto rounded-lg bg-hx-code p-2 font-mono text-[11px] leading-4">{logs.join('\n')}</pre>}
        <SpendLimit />
        <Field label="App folder" help={`Window, preferences and plugin grants on this computer: ${info?.dataDir ?? ''}`} inline><Button size="sm" icon="folder-open" onClick={() => void desktop.openDataFolder()}>Open</Button></Field>
      </Section>
      <Location />
    </div>
  );
}

/** The spend limit per conversation of this app's own engine (the person is its operator); it applies once the engine restarts. */
function SpendLimit(): React.ReactElement {
  const prefs = useApp((s) => s.prefs);
  const [applied, setApplied] = useState(prefs.spendLimitUsd);
  const cur = prefs.spendLimitUsd;
  const amounts = [...new Set([5, 10, 25, 50, 100, 250, ...(typeof cur === 'number' && cur > 0 ? [cur] : [])])].sort((a, b) => a - b);
  const options = [{ value: 'default', label: 'Default ($5)' }, ...amounts.map((n) => ({ value: String(n), label: `$${n}` })), { value: '0', label: 'No limit' }];
  const pending = cur !== applied;
  const help = pending
    ? 'Applies after the engine restarts (running conversations stop).'
    : 'A conversation stops when its model calls reach this; raise it and say "continue". No limit: only your providers\' own limits apply.';
  return (
    <Field label="Spend limit per conversation" help={help} inline>
      <div className="flex items-center gap-2" data-spend-limit>
        <Select value={cur === null ? 'default' : String(cur)} onChange={(v) => set({ spendLimitUsd: v === 'default' ? null : Number(v) })} options={options} />
        {pending && <Button size="sm" variant="primary" icon="refresh" onClick={() => { setApplied(cur); void desktop.engineRestart(); }}>Restart engine</Button>}
      </div>
    </Field>
  );
}

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`);

/** The harness home (~/.harness): where it is, its folders with their sizes, Open, Move, and the tmp clean-up age. */
function Location(): React.ReactElement {
  const [h, setH] = useState<HomeInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState('');
  const load = () => desktop.homeInfo().then((x) => { setH(x); setDays(String(x.tmpCleanupDays)); setErr(''); }).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);
  const run = async (what: string, f: () => Promise<unknown>) => { setBusy(what); try { await f(); } catch (e) { toast((e as Error).message, { kind: 'error' }); } finally { setBusy(null); } };
  const move = () => run('move', async () => {
    const to = await desktop.chooseHomeFolder();
    if (!to || !h) return;
    const yes = await useApp.getState().ask({ title: 'Move the harness home?', body: `Everything in ${h.home} is copied to ${to} (into a "Harness" folder when that one is not empty), checked, and used from then on. The engine restarts; conversations that are running stop. The old copy stays until you remove it.`, confirmLabel: 'Move' });
    if (!yes) return;
    const r = await desktop.moveHome(to);
    setH(r.info); setDays(String(r.info.tmpCleanupDays));
    toast(`The home is now ${r.moved.home}`, { kind: 'success', detail: `${r.moved.files} files copied and checked; the old copy is kept until you remove it.` });
  });
  const removeOld = () => run('remove', async () => {
    if (!h?.oldCopy) return;
    const yes = await useApp.getState().ask({ title: 'Remove the old copy?', body: `${h.oldCopy} and everything in it is deleted. The home in use (${h.home}) is not touched.`, confirmLabel: 'Remove', danger: true });
    if (yes) setH(await desktop.removeOldHome());
  });
  const saveDays = () => run('days', async () => { const n = Number(days); const v = await desktop.setTmpDays(n); setDays(String(v)); toast(`Scratch folders older than ${v} days are removed`, { kind: 'success' }); await load(); });
  if (err) return <Section title="Location"><InfoNote tone="warning">{err}</InfoNote></Section>;
  if (!h) return <Section title="Location"><Spinner /></Section>;
  return (
    <div data-location>
      <Section title="Location">
        <Field label="Harness home" help="Conversations, workspaces, scratch folders, exports and logs. The server and the command line use it too." inline>
          <div className="flex items-center gap-2">
            <code className="max-w-[260px] truncate rounded bg-hx-code px-1.5 py-0.5 text-[11.5px]" title={h.home} data-home-path>{h.home}</code>
            <Button size="sm" icon="folder-open" onClick={() => void desktop.openHomeFolder('home')}>Open</Button>
            <Button size="sm" icon="arrow-right" loading={busy === 'move'} disabled={!!busy} onClick={() => void move()} data-move-home>Move…</Button>
          </div>
        </Field>
        {h.migration && <div className="py-2"><InfoNote tone="info">{h.migration}</InfoNote></div>}
        {h.oldCopy && (
          <Field label="Old copy" help={`Kept after the move: ${h.oldCopy}`} inline>
            <Button size="sm" variant="danger" icon="trash" loading={busy === 'remove'} disabled={!!busy} onClick={() => void removeOld()} data-remove-old-home>Remove</Button>
          </Field>
        )}
        {h.folders.map((f) => (
          <div key={f.key} className="flex items-center gap-3 py-2" data-home-folder={f.key} data-bytes={f.bytes}>
            <Icon name="folder" size={16} className="text-hx-muted" />
            <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{f.label} <span className="ml-1 text-[11.5px] font-normal text-hx-muted">{size(f.bytes)} · {f.files} file{f.files === 1 ? '' : 's'}</span></span><span className="block truncate text-[11.5px] text-hx-muted" title={f.path}>{f.note} · {f.path}</span></span>
            <IconButton icon="folder-open" size="sm" label={`Open ${f.label}`} onClick={() => void desktop.openHomeFolder(f.key)} />
          </div>
        ))}
        <Field label="Clean up scratch folders" help="Scratch conversations get a folder each in tmp/. Folders not changed for this many days are removed (on start and daily); nothing outside tmp/ is touched." inline>
          <div className="flex items-center gap-2">
            <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-20" aria-label="Days" data-tmp-days />
            <span className="text-[12px] text-hx-muted">days</span>
            <Button size="sm" disabled={!!busy || days === String(h.tmpCleanupDays)} loading={busy === 'days'} onClick={() => void saveDays()} data-save-tmp-days>Save</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('clean', async () => { const r = await desktop.cleanTmp(); toast(r.removed.length ? `Removed ${r.removed.length} old scratch folder(s)` : 'Nothing old enough to remove'); await load(); })}>Clean now</Button>
          </div>
        </Field>
      </Section>
    </div>
  );
}

export function Shortcuts(): React.ReactElement {
  const commands = useData((s) => s.registry.commands);
  const overrides = useApp((s) => s.prefs.keybindings);
  const [recording, setRecording] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const clash = useMemo(() => conflicts(commands.map((c) => ({ id: c.qid, keys: c.keys })), platform), [commands]);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      const chord = chordFromEvent(e);
      if (!chord) return;
      set({ keybindings: { ...useApp.getState().prefs.keybindings, [recording]: chord } });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);
  const shown = commands.filter((c) => `${c.title} ${c.category ?? ''} ${c.plugin}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div data-section="shortcuts">
      <div className="mb-3"><Input icon="search" placeholder="Filter commands" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {clash.length > 0 && <div className="mb-3"><InfoNote tone="warning">{clash.map((c) => <div key={c.chord}>Same keys for: {c.ids.join(', ')}</div>)}</InfoNote></div>}
      <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
        {shown.map((c) => (
          <div key={c.qid} data-shortcut={c.qid} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{c.category ? `${c.category}: ` : ''}{c.title}</span><span className="block text-[11px] text-hx-muted">{c.plugin}</span></span>
            {recording === c.qid ? <span className="rounded-md bg-hx-accent-soft px-2 py-1 text-[12px] text-hx-accent-text">Press keys… (Esc cancels)</span> : c.keys ? <Kbd keys={formatChord(c.keys, platform)} /> : <span className="text-[12px] text-hx-muted">—</span>}
            <Button size="sm" variant="ghost" onClick={() => setRecording(c.qid)}>Change</Button>
            {overrides[c.qid] !== undefined && <IconButton size="xs" icon="refresh" label="Back to the default" onClick={() => { const k = { ...overrides }; delete k[c.qid]; set({ keybindings: k }); }} />}
            {c.keys && <IconButton size="xs" icon="x" label="Remove the shortcut" onClick={() => set({ keybindings: { ...overrides, [c.qid]: '' } })} />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Servers(): React.ReactElement {
  const [s, setS] = useState<ServersInfo | null>(null);
  const [form, setForm] = useState({ name: '', url: '', token: '' });
  const [busy, setBusy] = useState(false);
  const load = () => desktop.servers().then(setS).catch(() => setS({ active: 'local', remote: [], encryption: false }));
  useEffect(() => { void load(); }, []);
  const run = async (f: () => Promise<ServersInfo>) => { setBusy(true); try { setS(await f()); } catch (e) { toast((e as Error).message, { kind: 'error' }); } finally { setBusy(false); } };
  if (!s) return <Spinner />;
  return (
    <div data-section="servers">
      <p className="mb-3 text-[13px] text-hx-secondary">The app runs its own engine on this computer, or works with a harness server (a team's or a company's). The same app, the same plugins.</p>
      <div className="space-y-2">
        <ServerRow name="This computer" detail="The local engine" active={s.active === 'local'} onUse={() => void run(() => desktop.useServer('local'))} busy={busy} />
        {s.remote.map((r) => <ServerRow key={r.id} name={r.name} detail={r.url} active={s.active === r.id} onUse={() => void run(() => desktop.useServer(r.id))} onRemove={() => void run(() => desktop.removeServer(r.id))} busy={busy} />)}
      </div>
      <h3 className="mb-1 mt-6 text-[12px] font-medium uppercase tracking-wide text-hx-muted">Add a server</h3>
      {!s.encryption && <InfoNote tone="warning">This system has no keychain to keep a token safely; remote servers cannot be saved here.</InfoNote>}
      <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Team server" /></Field>
      <Field label="Address"><Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://harness.example.com" /></Field>
      <Field label="Access token" help="Kept encrypted with your system's keychain; never shown again."><Input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} /></Field>
      <div className="mt-2 flex justify-end"><Button variant="primary" disabled={busy || !form.url || !form.token} onClick={() => void run(() => desktop.addServer(form)).then(() => setForm({ name: '', url: '', token: '' }))}>Add</Button></div>
    </div>
  );
}

function ServerRow({ name, detail, active, onUse, onRemove, busy }: { name: string; detail: string; active: boolean; onUse: () => void; onRemove?: () => void; busy: boolean }) {
  return (
    <div className={cx('flex items-center gap-3 rounded-xl border p-3', active ? 'border-hx-accent' : 'border-hx-border-subtle')}>
      <Icon name={onRemove ? 'server' : 'monitor'} size={18} className="text-hx-muted" />
      <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">{name}</span><span className="block truncate text-[11.5px] text-hx-muted">{detail}</span></span>
      {active ? <Badge tone="success">In use</Badge> : <Button size="sm" disabled={busy} onClick={onUse}>Use</Button>}
      {onRemove && <IconButton icon="trash" size="sm" tone="danger" label="Remove" onClick={onRemove} />}
    </div>
  );
}

export function About(): React.ReactElement {
  const info = useApp((s) => s.info);
  const registry = useData((s) => s.registry);
  const [server, setServer] = useState<string>('…');
  useEffect(() => { client.version().then((v) => setServer(v ? `${v.version} (API ${v.apiVersion ?? '?'}, UI API ${v.uiApiVersion ?? '?'})` : 'unknown')).catch(() => setServer('not reachable')); }, []);
  const rows: Array<[string, string]> = info ? [['App', `${info.product.name} ${info.version}`], ['Engine', server], ['Electron', info.electron], ['Chromium', info.chrome], ['Node', info.node], ['Platform', info.platform], ['Product profile', `${info.product.id} (${info.product.appId})`], ['Plugins', `${registry.active.length} active of ${registry.plugins.length}`], ['Data folder', info.dataDir]] : [];
  const copy = () => void navigator.clipboard.writeText(rows.map(([k, v]) => `${k}: ${v}`).join('\n')).then(() => toast('Copied'), () => toast('Could not copy', { kind: 'error' }));
  return (
    <div data-section="about">
      <div className="mb-4 flex items-center gap-3"><ProductMark size={48} /><div className="min-w-0 flex-1"><div className="text-[17px] font-semibold">{info?.product.name ?? 'Harness'}</div><div className="text-[12.5px] text-hx-muted">{info?.product.description}</div></div><Button size="sm" icon="copy" onClick={copy}>Copy versions</Button></div>
      <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle" data-about-versions>{rows.map(([k, v]) => <div key={k} className="flex gap-4 px-3 py-2 text-[13px]"><span className="w-36 shrink-0 text-hx-muted">{k}</span><span className="min-w-0 break-all" data-about-row={k}>{v}</span></div>)}</div>
    </div>
  );
}

/** The About page (Help > About): the same facts as the settings section, as a page. */
export function AboutPage(): React.ReactElement {
  return <Page data-about-page width="narrow"><About /></Page>;
}

