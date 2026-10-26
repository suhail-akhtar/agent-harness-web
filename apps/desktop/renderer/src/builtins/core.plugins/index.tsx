/**
 * core.plugins: every plugin (built in, on the server, and UI-only ones loaded from folders on this
 * machine), switched on and off, uninstalled, installed from the catalogue; what each one's UI may
 * do (its trust and capabilities) and what was granted; UI errors shown where they happen.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { CatalogueEntry } from '@harness/client';
import { isMissing } from '@harness/client';
import { CONTRIBUTION_POINTS, type Capability } from '@harness/plugin-ui';
import { Badge, Button, Checkbox, EmptyState, Icon, InfoNote, Input, Modal, Spinner, Switch, Tabs, toast, Page } from '@harness/ui';
import type { BuiltinPlugin } from '../../state/data';
import { useData, client } from '../../state/data';
import { useApp } from '../../state/app';
import { desktop } from '../../bridge';
import { CAPABILITY_TEXT, decide } from '@desk/grants';
import type { PluginEntry } from '../../registry/registry';

function PluginsPage() {
  const plugins = useData((s) => s.registry.plugins);
  const [tab, setTab] = useState('installed');
  const [q, setQ] = useState('');
  const shown = plugins.filter((p) => `${p.name} ${p.description ?? ''} ${p.ui?.displayName ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page data-plugins-page width="wide" title="Plugins" actions={<Tabs value={tab} onChange={setTab} tabs={[{ id: 'installed', label: 'Installed', count: plugins.length }, { id: 'catalogue', label: 'Catalogue' }, { id: 'dev', label: 'Developer' }]} />}>
        {tab === 'installed' && (
          <>
            <div className="mb-3"><Input icon="search" placeholder="Filter plugins" value={q} onChange={(e) => setQ(e.target.value)} /></div>
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
  return (
    <div data-plugin={p.name} data-enabled={p.enabled ? '1' : '0'} className="rounded-xl border border-hx-border-subtle bg-hx-elevated p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hx-pill text-hx-secondary"><Icon name={p.ui?.icon ?? 'puzzle'} size={18} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium">{p.ui?.displayName ?? p.name}</span>
            <span className="text-[11.5px] text-hx-muted">{p.name} {p.version}</span>
            <Badge tone={builtin ? 'accent' : p.source === 'dev' ? 'info' : 'neutral'}>{builtin ? 'Built in' : p.source}</Badge>
            {p.ui && <Badge>{p.ui.trust === 'native' ? 'native UI' : p.ui.trust === 'frame' ? 'frame UI' : 'declarative UI'}</Badge>}
            {required && <Badge tone="warning">Required</Badge>}
          </div>
          {p.description && <p className="mt-1 line-clamp-2 text-[12.5px] text-hx-secondary">{p.description}</p>}
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
        {p.source === 'installed' && me?.role === 'admin' && <Button size="sm" variant="ghost" icon="trash" data-uninstall={p.name} onClick={() => { setDeleteData(false); setRemoving(true); }}>Uninstall</Button>}
      </div>
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
          {declared.length > 0 && <div className="mt-1"><b>May ask for:</b><ul className="ml-4 list-disc">{declared.map((c) => <li key={c}>{CAPABILITY_TEXT[c] ?? c}</li>)}</ul></div>}
          {p.uiHash && <div className="mt-1 font-mono text-[11px] text-hx-muted">uiHash {p.uiHash}</div>}
        </div>
      )}
    </div>
  );
}

function Catalogue() {
  const [list, setList] = useState<CatalogueEntry[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { client.plugins.catalogue().then(setList).catch((e: Error) => setErr(isMissing(e) ? 'This server has no catalogue.' : e.message)); }, []);
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!list) return <Spinner />;
  if (!list.length) return <EmptyState icon="box" title="The catalogue is empty">The operator names one with HARNESS_PLUGIN_CATALOGUE (signed plugins).</EmptyState>;
  return (
    <div className="space-y-2" data-catalogue>
      {list.map((c) => (
        <div key={c.name} className="flex items-center gap-3 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3">
          <Icon name="box" size={18} className="text-hx-muted" />
          <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">{c.name} <span className="text-[11.5px] font-normal text-hx-muted">{c.version}</span></span><span className="block truncate text-[12px] text-hx-muted">{c.description}</span></span>
          {c.installed ? <Badge tone="success">Installed</Badge> : <Button size="sm" variant="primary" onClick={() => void client.plugins.install(c.name).then(() => { toast(`Installed ${c.name}`, { kind: 'success' }); void useData.getState().refreshPlugins(); }).catch((e: Error) => toast(e.message, { kind: 'error' }))}>Install</Button>}
        </div>
      ))}
    </div>
  );
}

function Developer() {
  const dev = useData((s) => s.devPlugins);
  const add = () => void desktop.addDevPlugin().then(() => useData.getState().refreshPlugins()).catch((e: Error) => toast(e.message, { kind: 'error' }));
  return (
    <div data-dev-plugins>
      <p className="mb-3 text-[13px] text-hx-secondary">Load a plugin from a folder on this computer while you build it: its pages run in sandboxed frames (asking for access like any other), and its server code (tools, routes, skills) runs in this app's engine, which restarts to load it.</p>
      <Button icon="folder-plus" onClick={add}>Load a plugin folder…</Button>
      <div className="mt-3 space-y-2">
        {dev.map((d) => (
          <div key={d.dir} className="flex items-center gap-2 rounded-lg border border-hx-border-subtle p-2.5 text-[13px]">
            <Icon name="code" size={15} className="text-hx-muted" /><span className="font-medium">{d.name}</span><span className="min-w-0 flex-1 truncate text-[11.5px] text-hx-muted">{d.dir}</span>
            {d.uiError && <Badge tone="danger">UI error</Badge>}
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
