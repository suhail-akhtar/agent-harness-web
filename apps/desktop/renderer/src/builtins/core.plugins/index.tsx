/**
 * core.plugins: every plugin (built in, on the server, and UI-only ones loaded from folders on this
 * machine), switched on and off, uninstalled, installed from the catalogue; what each one's UI may
 * do (its trust and capabilities) and what was granted; UI errors shown where they happen.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { CatalogueEntry, PluginRevisionInfo } from '@harness/client';
import { isMissing } from '@harness/client';
import { CONTRIBUTION_POINTS, type Capability, type IconName } from '@harness/plugin-ui';
import { Badge, Button, Checkbox, EmptyState, Icon, InfoNote, Input, Modal, Spinner, Switch, Tabs, toast, Page } from '@harness/ui';
import type { BuiltinPlugin } from '../../state/data';
import { useData, client } from '../../state/data';
import { useApp } from '../../state/app';
import { desktop } from '../../bridge';
import { CAPABILITY_TEXT, decide } from '@desk/grants';
import type { PluginEntry } from '../../registry/registry';
import { ReviewModal } from './Review';
import { contextItems } from '../../shell/ContextMenu';

function PluginsPage() {
  const plugins = useData((s) => s.registry.plugins);
  const [tab, setTab] = useState('installed');
  const [q, setQ] = useState('');
  const shown = plugins.filter((p) => `${p.name} ${p.description ?? ''} ${p.ui?.displayName ?? ''} ${p.info?.tags.join(' ') ?? ''} ${p.info?.publisher?.name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page data-plugins-page width="wide" title="Plugins" actions={<Tabs value={tab} onChange={setTab} tabs={[{ id: 'installed', label: 'Installed', count: plugins.length }, { id: 'catalogue', label: 'Catalogue' }, { id: 'dev', label: 'Developer' }]} />}>
        {tab === 'installed' && (
          <>
            <div className="mb-3 flex items-center gap-2"><div className="flex-1"><Input icon="search" placeholder="Filter plugins" value={q} onChange={(e) => setQ(e.target.value)} /></div><CheckUpdates /></div>
            <div className="space-y-2">{shown.map((p) => <PluginCard key={`${p.source}:${p.name}`} p={p} />)}</div>
          </>
        )}
        {tab === 'catalogue' && <Catalogue />}
        {tab === 'dev' && <Developer />}
    </Page>
  );
}

function PluginCard({ p }: { p: PluginEntry }) {
  const grants = useData((s) => s.grants);
  const me = useData((s) => s.me);
  // A clash this plugin lost (the core or the plugin loaded first keeps the key or the name).
  const conflicts = useData((s) => s.registry.conflicts).filter((c) => c.ids.slice(1).some((id) => id === p.name || id.startsWith(`${p.name}:`)));
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const builtin = p.source === 'builtin';
  const required = !!p.required || (useApp.getState().info?.product.plugins.required ?? []).includes(p.name);
  const declared = (p.ui?.capabilities ?? []) as Capability[];
  const decision = p.ui && !builtin ? decide(grants[p.name], p.uiHash, declared) : null;
  const points = p.ui ? CONTRIBUTION_POINTS.filter((k) => (p.ui!.contributes[k] as unknown[]).length).map((k) => `${(p.ui!.contributes[k] as unknown[]).length} ${k}`) : [];
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (builtin) { const d = new Set(useApp.getState().prefs.disabledPlugins); if (on) d.delete(p.name); else d.add(p.name); useApp.getState().setPrefs({ disabledPlugins: [...d] }); }
      else if (p.source === 'dev') await desktop.toggleDevPlugin(p.name, on);
      else await (on ? client.plugins.enable(p.name) : client.plugins.disable(p.name));
      await useData.getState().refreshPlugins();
      useData.getState().rebuild();
      toast(`${p.ui?.displayName ?? p.name} ${on ? 'on' : 'off'}`);
    } catch (e) { toast(isMissing(e) ? 'This server cannot switch plugins on and off.' : (e as Error).message, { kind: 'error' }); } finally { setBusy(false); }
  };
  // Uninstalling asks what becomes of the plugin's data folder on the server: kept unless the person ticks the box.
  const [removing, setRemoving] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const uninstall = async () => {
    setRemoving(false);
    try {
      await client.plugins.uninstall(p.name, { deleteData });
      await useData.getState().refreshPlugins();
      toast(deleteData ? 'Uninstalled, its data deleted' : 'Uninstalled, its data kept');
    } catch (e) { toast((e as Error).message, { kind: 'error' }); }
  };
  const title = p.ui?.displayName ?? p.info?.displayName ?? p.name;
  const update = async () => {
    setBusy(true);
    try {
      const now = await client.plugins.update(p.name);
      await useData.getState().refreshPlugins();
      toast(`${title} updated to ${now.version} (the version before is kept: Details > Earlier versions)`, { kind: 'success' });
    } catch (e) { toast((e as Error).message, { kind: 'error' }); } finally { setBusy(false); }
  };
  // A bundle of the plugin (.tgz): Import it on another computer or server, then open it as its own app there.
  const exportBundle = async () => {
    try {
      const bytes = await client.plugins.exportBundle(p.name);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const saved = await desktop.saveBundle(`${p.name}-${p.version ?? '0.0.0'}.tgz`, btoa(bin));
      if (saved) toast(`Exported to ${saved}: import it under Plugins > Developer on another computer`, { kind: 'success' });
    } catch (e) { toast(isMissing(e) ? 'This server cannot export plugins.' : (e as Error).message, { kind: 'error' }); }
  };
  return (
    <div data-plugin={p.name} data-enabled={p.enabled ? '1' : '0'} className="rounded-xl border border-hx-border-subtle bg-hx-elevated p-4" onContextMenu={contextItems(() => [
      ...(p.enabled && !builtin && (p.ui?.contributes.views.length ?? 0) > 0 ? [{ id: 'app', label: 'Open as its own app', icon: 'external', onSelect: () => void desktop.openPluginWindow(p.name) }] : []),
      { id: 'details', label: open ? 'Hide details' : 'Show details', icon: 'info', onSelect: () => setOpen(!open) },
      ...(!builtin && p.source !== 'dev' && me?.role === 'admin' ? [{ id: 'export', label: 'Export as a file…', icon: 'share', onSelect: () => void exportBundle() }] : []),
      ...(!builtin && p.source !== 'bundled' && me?.role === 'admin' ? [{ id: 'review', label: 'Review', icon: 'shield', onSelect: () => setReviewing(true) }] : []),
      ...(!required && (builtin || p.source === 'dev' || me?.role === 'admin') ? [{ id: 'toggle', label: p.enabled ? 'Switch off' : 'Switch on', icon: 'zap', disabled: busy, onSelect: () => void toggle(!p.enabled) }] : []),
      { id: 'copy', label: 'Copy name', icon: 'copy', onSelect: () => void desktop.clipboard(p.name) },
    ], title)}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-hx-pill text-hx-secondary">{p.info?.iconData ? <img src={p.info.iconData} alt="" className="h-9 w-9 object-cover" data-plugin-icon /> : <Icon name={(p.ui?.icon ?? p.info?.icon ?? 'puzzle') as IconName} size={18} />}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium">{title}</span>
            <span className="text-[11.5px] text-hx-muted">{p.name} {p.version}</span>
            <Badge tone={builtin ? 'accent' : p.source === 'dev' ? 'info' : 'neutral'}>{builtin ? 'Built in' : p.source}</Badge>
            {!builtin && <span data-tier={p.tier ?? 'custom'}><Badge tone={p.tier === 'official' ? 'success' : 'neutral'}>{p.tier === 'official' ? 'Official' : 'Custom'}</Badge></span>}
            {p.ui && <Badge>{p.ui.trust === 'native' ? 'native UI' : p.ui.trust === 'frame' ? 'frame UI' : 'declarative UI'}</Badge>}
            {required && <Badge tone="warning">Required</Badge>}
            {p.update && <span data-update-available={p.update.latest}><Badge tone="info">Update: {p.update.latest}</Badge></span>}
          </div>
          {p.description && <p className="mt-1 line-clamp-2 text-[12.5px] text-hx-secondary">{p.description}</p>}
          {(p.info?.publisher || p.info?.author || (p.info?.tags.length ?? 0) > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-hx-muted" data-plugin-meta={p.name}>
              {(p.info?.publisher ?? p.info?.author) && <span>by {(p.info.publisher ?? p.info.author)!.name}</span>}
              {p.info?.category && <span>· {p.info.category}</span>}
              {p.info?.tags.slice(0, 5).map((t) => <span key={t} className="rounded bg-hx-pill px-1.5 py-px">{t}</span>)}
            </div>
          )}
          {p.error && <div className="mt-2" data-plugin-error><InfoNote tone="danger">Not loaded: {p.error}</InfoNote></div>}
          {!p.error && p.info?.compat.ok === false && <div className="mt-2"><InfoNote tone="warning">{p.info.compat.reason}</InfoNote></div>}
          {p.uiError && <div className="mt-2" data-ui-error><InfoNote tone="danger">Its UI did not load: {p.uiError}</InfoNote></div>}
          {conflicts.length > 0 && (
            <div className="mt-2" data-conflict>
              <InfoNote tone="warning">{conflicts.map((c, i) => <div key={i}>{c.kind === 'slash' ? `/${c.key.replace(/^\//, '')} is already ${c.ids[0]}'s: this plugin's command is not used.` : `${c.key} is already ${c.ids[0]}'s: ${c.ids.slice(1).join(', ')} has no shortcut (rebind it in Settings > Shortcuts).`}</div>)}</InfoNote>
            </div>
          )}
          {decision && declared.length > 0 && (
            <div className="mt-2 text-[12px]" data-grant-state={decision.state}>
              {decision.state === 'granted' ? <span className="text-hx-success">Access granted: {decision.capabilities.join(', ')}</span> : decision.state === 'denied' ? <span className="text-hx-muted">Access refused</span> : <span className="text-hx-warning">Will ask for access when it opens{decision.changed ? ' (its files changed)' : ''}</span>}
            </div>
          )}
        </div>
        <Switch checked={p.enabled || required} disabled={busy || required || (!builtin && p.source !== 'dev' && me?.role !== 'admin')} onChange={(v) => void toggle(v)} label={`${p.name} on`} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="text-[12px] text-hx-muted hover:text-hx-primary" onClick={() => setOpen(!open)}>{open ? 'Less' : 'Details'}</button>
        <div className="flex-1" />
        {decision?.state === 'granted' && <Button size="sm" variant="ghost" onClick={() => void desktop.revokeGrant(p.name).then(() => useData.getState().refreshPlugins())}>Revoke access</Button>}
        {p.enabled && !builtin && (p.ui?.contributes.views.length ?? 0) > 0 && <Button size="sm" variant="ghost" icon="external" data-open-app={p.name} onClick={() => void desktop.openPluginWindow(p.name)}>Open as app</Button>}
        {p.enabled && !builtin && (p.ui?.contributes.views.length ?? 0) > 0 && <Button size="sm" variant="ghost" icon="pin" data-shortcut={p.name} onClick={() => void desktop.pluginShortcut(p.name, p.ui?.displayName ?? p.name).then((r) => toast(r.ok ? `A shortcut to ${p.ui?.displayName ?? p.name} is on your desktop` : r.reason ?? 'No shortcut', { kind: r.ok ? 'success' : 'info' }))}>Desktop shortcut</Button>}
        {p.update && me?.role === 'admin' && <Button size="sm" variant="primary" icon="download" data-update={p.name} disabled={busy} onClick={() => void update()}>Update to {p.update.latest}</Button>}
        {!builtin && p.source !== 'dev' && me?.role === 'admin' && <Button size="sm" variant="ghost" icon="share" data-export={p.name} onClick={() => void exportBundle()}>Export</Button>}
        {!builtin && p.source !== 'bundled' && me?.role === 'admin' && <Button size="sm" variant="ghost" icon="shield" data-review={p.name} onClick={() => setReviewing(true)}>Review</Button>}
        {p.source === 'installed' && me?.role === 'admin' && <Button size="sm" variant="ghost" icon="trash" data-uninstall={p.name} onClick={() => { setDeleteData(false); setRemoving(true); }}>Uninstall</Button>}
      </div>
      {reviewing && <ReviewModal target={p.source === 'dev' ? { dir: (useData.getState().devPlugins.find((d) => d.name === p.name)?.dir) ?? '', title: p.ui?.displayName ?? p.name } : { name: p.name, title: p.ui?.displayName ?? p.name }} onClose={() => setReviewing(false)} />}
      <Modal open={removing} onClose={() => setRemoving(false)} title={`Uninstall ${p.ui?.displayName ?? p.name}?`} size="sm" label="Uninstall plugin"
        footer={<><Button variant="ghost" onClick={() => setRemoving(false)}>Cancel</Button><Button variant="danger" data-confirm-uninstall onClick={() => void uninstall()}>Uninstall</Button></>}>
        <div className="space-y-3 text-[13px] text-hx-secondary" data-uninstall-dialog={p.name}>
          <p>Its folder is removed from the server. Conversations keep what it already did.</p>
          <p>Its data folder (what it stored for itself) is kept, so installing it again picks up where it left off.</p>
          <div data-delete-data><Checkbox checked={deleteData} onChange={setDeleteData} label="Also delete its data folder" /></div>
        </div>
      </Modal>
      {open && (
        <div className="mt-2 rounded-lg bg-hx-bg p-3 text-[12px] text-hx-secondary">
          <div><b>Contributes:</b> {points.join(', ') || 'no UI (server half only)'}</div>
          {p.permissions && Object.keys(p.permissions).length > 0 && (
            <div className="mt-1" data-server-permissions={p.name}><b>Its server code may:</b><ul className="ml-4 list-disc">{serverPermissions(p.permissions).map((t) => <li key={t}>{t}</li>)}</ul></div>
          )}
          {declared.length > 0 && <div className="mt-1"><b>May ask for:</b><ul className="ml-4 list-disc">{declared.map((c) => <li key={c}>{CAPABILITY_TEXT[c] ?? c}</li>)}</ul></div>}
          {p.info && <BundleDetails p={p} admin={me?.role === 'admin'} />}
          {p.uiHash && <div className="mt-1 font-mono text-[11px] text-hx-muted">uiHash {p.uiHash}</div>}
        </div>
      )}
    </div>
  );
}

/** The bundle's details: who publishes it, its links, licence, harness versions, changelog and the versions kept. */
function BundleDetails({ p, admin }: { p: PluginEntry; admin: boolean }) {
  const info = p.info!;
  const [revs, setRevs] = useState<PluginRevisionInfo[] | null>(null);
  const [log, setLog] = useState(false);
  useEffect(() => { if (admin && p.source === 'installed') void client.plugins.revisions(p.name).then(setRevs).catch(() => setRevs([])); }, [p.name, p.version, admin, p.source]);
  const rollback = async (id: string, version: string) => {
    try {
      await client.plugins.rollback(p.name, id);
      await useData.getState().refreshPlugins();
      toast(`Back to ${version}`, { kind: 'success' });
    } catch (e) { toast((e as Error).message, { kind: 'error' }); }
  };
  const LINKS: Array<[keyof typeof info.links, string]> = [['homepage', 'Website'], ['docs', 'Docs'], ['support', 'Support'], ['repository', 'Source'], ['privacy', 'Privacy'], ['terms', 'Terms']];
  const who = info.publisher ?? info.author;
  return (
    <div className="mt-2 space-y-1" data-bundle={p.name}>
      <div><b>Version:</b> {p.version}{info.compat.harness ? <> · runs on harness {info.compat.harness}</> : null}{info.license ? <> · licence {info.license}</> : null}</div>
      {who && <div><b>Publisher:</b> {who.url ? <button type="button" className="text-hx-accent hover:underline" onClick={() => void desktop.openExternal(who.url!)}>{who.name}</button> : who.name}{who.email ? ` <${who.email}>` : ''}</div>}
      {LINKS.some(([k]) => info.links[k]) && (
        <div className="flex flex-wrap gap-2" data-bundle-links>
          {LINKS.filter(([k]) => info.links[k]).map(([k, label]) => <button key={k} type="button" className="text-hx-accent hover:underline" onClick={() => void desktop.openExternal(info.links[k]!)}>{label}</button>)}
        </div>
      )}
      {info.changelog && (
        <div>
          <button type="button" className="text-hx-muted hover:text-hx-primary" data-changelog-toggle onClick={() => setLog(!log)}>{log ? 'Hide changelog' : 'Changelog'}</button>
          {log && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-hx-elevated p-2 text-[11.5px]" data-changelog>{info.changelog}</pre>}
        </div>
      )}
      {revs && revs.length > 0 && (
        <div data-revisions={p.name}><b>Earlier versions kept:</b>
          <ul className="ml-4 list-disc">{revs.map((r) => <li key={r.id}>{r.version} <span className="text-hx-muted">(replaced {new Date(r.at).toLocaleString()})</span> <button type="button" className="ml-1 text-hx-accent hover:underline" data-rollback={r.id} onClick={() => void rollback(r.id, r.version)}>Roll back</button></li>)}</ul>
        </div>
      )}
    </div>
  );
}

/** Asks the server for newer versions of the plugins installed on it (administrators). */
function CheckUpdates() {
  const me = useData((s) => s.me);
  const [busy, setBusy] = useState(false);
  if (me?.role !== 'admin') return null;
  const check = async () => {
    setBusy(true);
    try {
      const list = await client.plugins.checkUpdates();
      await useData.getState().refreshPlugins();
      toast(list.length ? `Updates: ${list.map((u) => `${u.name} ${u.latest}`).join(', ')}` : 'Every installed plugin is up to date');
    } catch (e) { toast(isMissing(e) ? 'This server cannot check for plugin updates.' : (e as Error).message, { kind: 'error' }); } finally { setBusy(false); }
  };
  return <Button size="sm" variant="ghost" icon="refresh" data-check-updates disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check for updates'}</Button>;
}

/** A plugin's server permissions in plain words (what people see before trusting it). */
function serverPermissions(p: Record<string, unknown>): string[] {
  const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).map(String) : []);
  return [
    ...(list('network').length ? [`Reach ${list('network').join(', ')}`] : []),
    ...(list('secrets').length ? [`Read the server settings ${list('secrets').join(', ')}`] : []),
    ...(list('vault').length ? [`Ask for key vault entries ${list('vault').join(', ')} (an administrator grants each)`] : []),
    ...(p.sessions === true ? ["Start and drive conversations, and see every conversation's events"] : []),
    ...(p.routes === true ? ['Serve its own web endpoints'] : []),
    ...(p.processes === true ? ['Run programs on this computer itself (outside any sandbox)'] : []),
  ];
}

function Catalogue() {
  const [list, setList] = useState<CatalogueEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const me = useData((s) => s.me);
  const load = () => client.plugins.catalogue().then(setList).catch((e: Error) => setErr(isMissing(e) ? 'This server has no catalogue.' : e.message));
  useEffect(() => { void load(); }, []);
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!list) return <Spinner />;
  const solutions = list.filter((c) => c.solution);
  const others = list.filter((c) => !c.solution);
  const titleOf = (n: string) => list.find((c) => c.name === n)?.solution?.title ?? n;
  const act = async (c: CatalogueEntry, install: boolean) => {
    setBusy(c.name);
    try {
      if (install) await client.plugins.install(c.name); else await client.plugins.uninstall(c.name);
      toast(install ? `${c.solution?.title ?? c.name} is installed` : `${c.solution?.title ?? c.name} was removed (its data is kept)`, { kind: 'success' });
      await useData.getState().refreshPlugins();
      await load();
    } catch (e) { toast((e as Error).message, { kind: 'error' }); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-6" data-catalogue>
      {solutions.length > 0 && (
        <section data-solutions>
          <h2 className="mb-1 text-[14px] font-semibold">Solutions</h2>
          <p className="mb-3 text-[12.5px] text-hx-secondary">Complete solutions on top of the core: install the ones this {me?.role === 'admin' ? 'server' : 'workspace'} needs, in any mix. Removing one keeps its data, so installing it again picks up where it left off.</p>
          <div className="grid gap-2 md:grid-cols-2">
            {solutions.map((c) => (
              <div key={c.name} data-solution={c.name} data-installed={c.installed ? '1' : '0'} className="flex flex-col gap-2 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium">{c.solution!.title}</span>
                  <span className="text-[11.5px] text-hx-muted">{c.name} {c.version}</span>
                  <span className="flex-1" />
                  <Badge tone="accent">Official</Badge>
                  {c.installed && <Badge tone="success">Installed</Badge>}
                </div>
                <p className="line-clamp-3 text-[12.5px] text-hx-secondary">{c.description}</p>
                {(c.solution!.requires.length > 0 || c.solution!.requiredBy.length > 0) && (
                  <div className="text-[12px] text-hx-muted">
                    {c.solution!.requires.length > 0 && <div>Needs {c.solution!.requires.map(titleOf).join(', ')} (installed with it)</div>}
                    {c.solution!.requiredBy.length > 0 && <div>Needed by {c.solution!.requiredBy.map(titleOf).join(', ')}</div>}
                  </div>
                )}
                {me?.role === 'admin' && (
                  <div className="flex justify-end">
                    {c.installed
                      ? <Button size="sm" variant="ghost" icon="trash" data-remove-solution={c.name} disabled={busy !== null || c.solution!.requiredBy.length > 0} loading={busy === c.name} onClick={() => void act(c, false)}>Remove</Button>
                      : <Button size="sm" variant="primary" data-install-solution={c.name} disabled={busy !== null} loading={busy === c.name} onClick={() => void act(c, true)}>Install</Button>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        {solutions.length > 0 && <h2 className="mb-2 text-[14px] font-semibold">Plugins</h2>}
        {!others.length ? <EmptyState icon="box" title="No other plugins in the catalogue">The operator names a catalogue of signed plugins with HARNESS_PLUGIN_CATALOGUE.</EmptyState> : (
          <div className="space-y-2">
            {others.map((c) => (
              <div key={c.name} className="flex items-center gap-3 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3">
                <Icon name="box" size={18} className="text-hx-muted" />
                <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">{c.name} <span className="text-[11.5px] font-normal text-hx-muted">{c.version}</span></span><span className="block truncate text-[12px] text-hx-muted">{c.description}</span></span>
                {c.installed ? <Badge tone="success">Installed</Badge> : <Button size="sm" variant="primary" onClick={() => void act(c, true)}>Install</Button>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Developer() {
  const dev = useData((s) => s.devPlugins);
  const [reviewing, setReviewing] = useState<{ dir?: string; name?: string; title: string; load?: boolean } | null>(null);
  // A folder is reviewed before it is loaded: the person sees what it adds and what is wrong with it, then loads it (or not).
  const add = () => void desktop.pickPluginFolder().then((dir) => { if (dir) setReviewing({ dir, title: dir.split(/[\/]/).pop() ?? dir, load: true }); }).catch((e: Error) => toast(e.message, { kind: 'error' }));
  const load = async (dir: string) => { await desktop.addDevPlugin(dir); await useData.getState().refreshPlugins(); toast('Plugin loaded: it is under Custom in the sidebar', { kind: 'success' }); };
  // A bundle exported on another computer or server: reviewed from a staging folder, then moved into place and loaded.
  const [staged, setStaged] = useState<{ dir: string; name: string; version: string } | null>(null);
  const importFile = () => void desktop.importPluginFile().then((b) => { if (b) setStaged(b); }).catch((e: Error) => toast(e.message, { kind: 'error' }));
  const commit = async () => { const dir = await desktop.importCommit(staged!.dir); setStaged(null); await load(dir); };
  return (
    <div data-dev-plugins>
      <p className="mb-3 text-[13px] text-hx-secondary">Load a plugin from a folder on this computer: it is reviewed first (its manifest, tools, routes, pages, permissions, code and tests), then loaded whole. Its pages run in sandboxed frames (asking for access like any other); its server code (tools, routes, skills) runs in this app's engine. Edits reload as you save. New plugin: <code>npm run plugin -- new my-plugin</code>, or ask an agent to build one (the build-a-plugin skill).</p>
      <div className="flex flex-wrap gap-2">
        <Button icon="folder-plus" onClick={add} data-load-plugin-folder>Load a plugin folder…</Button>
        <Button icon="upload" onClick={importFile} data-import-plugin>Import a plugin file…</Button>
      </div>
      <p className="mt-2 text-[12px] text-hx-muted">A plugin file (.tgz) comes from Export on any plugin, here or on another computer or server: it is reviewed, then loaded; open it as its own app from its card.</p>
      {staged && <ReviewModal target={{ dir: staged.dir, title: `${staged.name} ${staged.version}` }} onClose={() => { void desktop.importCancel(staged.dir); setStaged(null); }} onLoad={commit} />}
      {reviewing && <ReviewModal target={reviewing} onClose={() => setReviewing(null)} {...(reviewing.load && reviewing.dir ? { onLoad: () => load(reviewing.dir!) } : {})} />}
      <div className="mt-3 space-y-2">
        {dev.map((d) => (
          <div key={d.dir} className="flex items-center gap-2 rounded-lg border border-hx-border-subtle p-2.5 text-[13px]">
            <Icon name="code" size={15} className="text-hx-muted" /><span className="font-medium">{d.name}</span><span className="min-w-0 flex-1 truncate text-[11.5px] text-hx-muted">{d.dir}</span>
            {d.uiError && <Badge tone="danger">UI error</Badge>}
            <Button size="sm" variant="ghost" icon="shield" onClick={() => setReviewing({ dir: d.dir, title: d.name })}>Review</Button>
            <Button size="sm" variant="ghost" onClick={() => void desktop.removeDevPlugin(d.dir).then(() => useData.getState().refreshPlugins())}>Remove</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export const corePlugins: BuiltinPlugin = {
  name: 'core.plugins', version: '0.1.0', description: 'Manage plugins: on and off, install, access.',
  ui: {
    apiVersion: 1, displayName: 'Plugins', icon: 'puzzle', trust: 'native', capabilities: [], required: true,
    contributes: {
      navItems: [{ id: 'plugins', title: 'Plugins', icon: 'puzzle', view: 'plugins', order: 50 }],
      views: [{ id: 'plugins', title: 'Plugins', kind: 'native', component: 'PluginsPage' }],
      commands: [{ id: 'open', title: 'Manage plugins', category: 'Plugins', icon: 'puzzle', action: { type: 'open-view', view: 'plugins' } }],
    },
  },
  components: { PluginsPage },
};

export { useMemo };
