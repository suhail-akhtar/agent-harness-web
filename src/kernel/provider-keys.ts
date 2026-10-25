import path from 'node:path';
import type { ModelSpec } from '../core/models.ts';
import { readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import type { VaultActor, VaultStore } from '../vault/store.ts';
import type { Registry } from './registry.ts';

// Provider keys and base URLs an administrator sets through the API (the desktop's
// "Models & providers" settings), so a key needs no restart and no environment variable.
// A key is an operator-scope key vault entry, provider-<id>-key (administrators only,
// audited, never returned); the environment's key still wins. Base URLs are not secret:
// <data>/providers.json. The registry asks here for every request (Registry.keyInfo), so
// a key set, changed or removed applies to the next request of every session.

const SERVER: VaultActor = { admin: true, label: 'server:provider-keys' };

export const providerKeyEntry = (id: string) => `provider-${id.replace(/[^A-Za-z0-9._-]/g, '_')}-key`;

export class ProviderKeys {
  private keys = new Map<string, { key: string; version: number }>();
  private urls: Record<string, string> = {};
  /** Each provider's switches (ProviderDef.options), off unless set. */
  private opts: Record<string, Record<string, boolean>> = {};
  private file: string;
  private refreshing?: Promise<void>;
  private checked = 0;

  private o: { dataDir: string; vault?: VaultStore; registry: Registry; log?: (m: string) => void };

  constructor(o: { dataDir: string; vault?: VaultStore; registry: Registry; log?: (m: string) => void }) {
    this.o = o;
    this.file = path.join(o.dataDir, 'providers.json');
  }

  get vaultOn(): boolean { return !!this.o.vault; }

  async load(): Promise<this> {
    await this.readFile();
    await this.refresh(true);
    return this;
  }

  /**
   * Reads the keys again where the vault entry changed (another server on the data folder set
   * one): only the version is compared, a value is read (and audited) only when it is new.
   */
  async refresh(force = false): Promise<void> {
    const vault = this.o.vault;
    if (!vault) return;
    if (!force && Date.now() - this.checked < 5000) return;
    this.refreshing ??= (async () => {
      try {
        await vault.sync();
        const entries = new Map(vault.list(SERVER).filter((e) => e.scope === 'operator').map((e) => [e.name, e]));
        for (const id of this.o.registry.providers.keys()) {
          const e = entries.get(providerKeyEntry(id));
          if (!e) { this.keys.delete(id); continue; }
          if (this.keys.get(id)?.version === e.version) continue;
          try { this.keys.set(id, { key: await vault.reveal(SERVER, e.name, `the ${id} provider's API key`, { scope: 'operator' }), version: e.version }); } catch (err) { this.o.log?.(`provider key ${id}: ${(err as Error).message}`); }
        }
        await this.readFile();
        this.checked = Date.now();
      } finally { this.refreshing = undefined; }
    })();
    return this.refreshing;
  }

  /** The stored key (synchronous: what the last refresh read; a stale check starts another in the background). */
  get(id: string): string | undefined {
    if (Date.now() - this.checked > 60_000) void this.refresh().catch(() => {});
    return this.keys.get(id)?.key;
  }

  baseUrl(id: string): string | undefined { return this.urls[id]; }

  private async readFile(): Promise<void> {
    const f = await readJson<{ baseUrls?: Record<string, string>; options?: Record<string, Record<string, boolean>> }>(this.file, {});
    this.urls = f.baseUrls ?? {};
    this.opts = f.options ?? {};
  }

  /** A provider's switch (declared in ProviderDef.options): off unless an administrator turned it on. */
  option(id: string, name: string): boolean { return this.opts[id]?.[name] === true; }
  options(id: string): Record<string, boolean> { return { ...(this.opts[id] ?? {}) }; }

  async setOptions(id: string, patch: Record<string, boolean>): Promise<void> {
    await withFileLock(this.file, async () => {
      const f = await readJson<{ baseUrls?: Record<string, string>; options?: Record<string, Record<string, boolean>> }>(this.file, {});
      const all = f.options ?? {};
      all[id] = { ...(all[id] ?? {}), ...patch };
      await writeFileAtomic(this.file, JSON.stringify({ ...f, options: all }, null, 1));
      this.opts = all;
    });
  }

  async setKey(id: string, key: string, by: VaultActor): Promise<void> {
    const vault = this.o.vault;
    if (!vault) throw new Error('The key vault is turned off on this server (HARNESS_VAULT): set the key in the environment instead.');
    const info = await vault.put({ ...by, admin: true }, { name: providerKeyEntry(id), value: key, scope: 'operator', kind: 'token', description: `API key of the ${id} model provider (set in the providers settings)` });
    this.keys.set(id, { key, version: info.version });
  }

  async removeKey(id: string, by: VaultActor): Promise<boolean> {
    const vault = this.o.vault;
    if (!vault) return false;
    const had = vault.list({ ...by, admin: true }).some((e) => e.scope === 'operator' && e.name === providerKeyEntry(id));
    if (had) await vault.remove({ ...by, admin: true }, providerKeyEntry(id), 'operator');
    this.keys.delete(id);
    return had;
  }

  async setBaseUrl(id: string, url: string | undefined): Promise<void> {
    await withFileLock(this.file, async () => {
      const f = await readJson<{ baseUrls?: Record<string, string> }>(this.file, {});
      const cur = f.baseUrls ?? {};
      if (url) cur[id] = url; else delete cur[id];
      await writeFileAtomic(this.file, JSON.stringify({ ...f, baseUrls: cur }, null, 1));
      this.urls = cur;
    });
  }
}

/** The address a provider's requests go to: set through the API, else the operator's variable, else its default. */
export function providerBaseUrl(registry: Registry, id: string): string | undefined {
  const def = registry.providers.get(id);
  return registry.baseUrlFor?.(id) ?? (def?.baseUrlEnv ? process.env[def.baseUrlEnv]?.trim() || undefined : undefined) ?? def?.defaultBaseUrl;
}

/** A base URL an administrator may set: http(s), no credentials in it, no query. */
export function cleanBaseUrl(raw: unknown): string {
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw new Error('baseUrl is not a URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('baseUrl must be http(s)');
  if (u.username || u.password) throw new Error('baseUrl may not carry credentials (set the key as apiKey)');
  if (u.search || u.hash) throw new Error('baseUrl takes no query or fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Checks a provider's key with the cheapest real call there is: its models list where the
 * API has one (Anthropic, OpenAI and OpenAI-compatible addresses), else a one-word request
 * to its first model. The key never appears in what is returned.
 */
export async function testProvider(registry: Registry, id: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; latencyMs: number; model: string; error?: string }> {
  const def = registry.providers.get(id);
  const model = [...registry.models.values()].find((m) => m.provider === id);
  const started = Date.now();
  const done = (ok: boolean, error?: string) => ({ ok, latencyMs: Date.now() - started, model: model?.id ?? '', ...(error ? { error } : {}) });
  if (!def) return done(false, `no provider "${id}"`);
  const { key } = registry.keyInfo(id);
  const hide = (t: string) => (key && key.length >= 6 ? t.split(key).join('[key]') : t).slice(0, 500);
  const tiny = async (m: ModelSpec) => {
    await registry.provider(m).send({ model: m, system: 'Reply with OK.', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'OK?' }] }], effort: m.efforts[0] ?? m.effort, cacheKey: `hw-test-${id}`, signal: AbortSignal.timeout(30_000) });
  };
  try {
    if (registry.hasInstance(id) || !providerBaseUrl(registry, id)) {
      if (!model) return done(false, `no model uses the ${id} provider`);
      if (!key && !def.keyless && !registry.hasInstance(id)) return done(false, `no API key for ${id}`);
      await tiny(model);
      return done(true);
    }
    if (!key && !def.keyless) return done(false, `no API key for ${id}`);
    const base = providerBaseUrl(registry, id)!.replace(/\/+$/, '');
    const anthropic = id === 'anthropic';
    const url = anthropic ? `${base}/v1/models?limit=1` : `${base}/models`;
    const headers: Record<string, string> = anthropic ? { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' } : key ? { authorization: `Bearer ${key}` } : {};
    const r = await fetchFn(url, { headers: { accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return done(false, hide(`HTTP ${r.status}${body ? `: ${body.slice(0, 300)}` : ''}`));
    }
    await r.arrayBuffer().catch(() => undefined);
    return done(true);
  } catch (e) {
    return done(false, hide((e as Error).message ?? String(e)));
  }
}
