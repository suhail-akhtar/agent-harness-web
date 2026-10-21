// The ops inventory: what exists (hosts, services, environments), how to
// reach it (ssh address and a vault credential name, health URLs, metrics
// jobs, log sources), what "healthy" means (SLOs, alert rules), and when
// changes are allowed (maintenance windows).
//
// Two sources. The operator's file (HARNESS_OPS_INVENTORY) is trusted. The
// workspace's (.harness/ops/inventory.yaml|yml|json) can be edited by the
// agent (and comes with a repository), so:
// - credentials (a host's `credential`, monitoring's `prometheus_credential` and
//   `loki_credential`) are attached only by the operator's file: a workspace
//   entry may name a host or an endpoint, never a vault entry to send to it;
// - a host's read-only account (readUser + readCredential: an OS user the
//   operator restricted, whose commands are not asked about) likewise comes
//   only from the operator's file;
// - when the operator has a file, hosts and monitoring endpoints come from it
//   only; without one, the workspace's are used, without credentials.
// An entry that fails validation is dropped (its error is reported): nothing
// malformed - a user name that is an ssh option, a container name with a shell
// command - ever reaches a command.

import { readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

export const WORKSPACE_FILES = ['.harness/ops/inventory.yaml', '.harness/ops/inventory.yml', '.harness/ops/inventory.json'];
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

/**
 * What may go into an ssh or remote shell command, checked again right before
 * one is built. None of them can start with "-" (an option) or hold a space,
 * quote, "=" or shell character.
 */
export const SAFE = {
  user: /^[a-z_][a-z0-9_.-]{0,31}$/i,
  // A host name, an IPv4 address, or an IPv6 address (bare or in brackets).
  address: /^(?:[a-zA-Z0-9_][a-zA-Z0-9._-]{0,252}|\[?[0-9a-fA-F]*:[0-9a-fA-F:.]+\]?)$/,
  container: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/,
  unit: /^[a-zA-Z0-9][a-zA-Z0-9@_.:-]{0,127}$/,
  credential: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/,
  file: /^\/[\w./@+-]+$/,
};
/** Throws unless `value` is a safe `kind` (user, address, container, unit, file). */
export function assertSafe(kind, value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${kind} is missing`);
  if (!SAFE[kind].test(String(value))) throw new Error(`"${String(value).slice(0, 80)}" is not a valid ${kind}: refused`);
  return String(value);
}
const CREDENTIAL_KEYS = ['prometheus_credential', 'loki_credential'];
export const SEVERITIES = ['critical', 'warning', 'info'];

/** "90s", "5m", "2h", "30d", "1w", "250ms" (or a number of seconds) in milliseconds; NaN when not a duration. */
export function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  let total = 0; let rest = s;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
  while (rest) {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/.exec(rest);
    if (!m) return NaN;
    total += Number(m[1]) * unit[m[2]];
    rest = rest.slice(m[0].length);
  }
  return total;
}

/** Milliseconds as a Prometheus duration ("5m", "1h30m"). */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const parts = []; let r = Math.round(ms / 1000);
  for (const [u, n] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) { if (r >= n) { parts.push(`${Math.floor(r / n)}${u}`); r %= n; } }
  return parts.join('') || '0s';
}

export function parseInventoryText(text, file) {
  if (/\.json$/i.test(file)) return JSON.parse(text);
  return parseYaml(text);
}

async function readIf(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}

/** The workspace inventory file of a host's workspace, if any: { rel, text }. */
export async function readWorkspaceInventory(host, resolve) {
  if (host.kind === 'companion') {
    for (const rel of WORKSPACE_FILES) {
      const b = await host.readFile?.(rel).catch(() => null);
      if (b) return { rel, text: b.toString('utf8') };
    }
    return undefined;
  }
  for (const rel of WORKSPACE_FILES) {
    const real = await resolve(host, rel).catch(() => null);
    if (!real) continue;
    const text = await readIf(real);
    if (text !== undefined) return { rel, text };
  }
  return undefined;
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const isUrl = (s, protos = ['http:', 'https:']) => { try { return protos.includes(new URL(String(s)).protocol); } catch { return false; } };

/**
 * Checks an inventory document. Returns { errors, warnings, inv } where inv is
 * the normalised inventory (lists everywhere, defaults filled) without the
 * entries that have errors. `vaultPatterns`: the credential names this plugin may
 * read (harness-plugin.json permissions.vault). `external.hosts`: host names
 * another file (the operator's) defines, which services here may name.
 */
export function validateInventory(doc, { source = 'workspace', vaultPatterns = ['ops-*'], external = {} } = {}) {
  const errors = []; const warnings = [];
  const inv = { monitoring: {}, environments: [], hosts: [], services: [], maintenance: [], alerts: [] };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['the inventory must be a mapping with hosts, services, environments, maintenance, alerts'], warnings, inv };
  const known = ['monitoring', 'environments', 'hosts', 'services', 'maintenance', 'alerts', 'version'];
  for (const k of Object.keys(doc)) if (!known.includes(k)) warnings.push(`unknown top-level key "${k}" (known: ${known.join(', ')})`);
  const credOk = (c) => vaultPatterns.some((p) => (p.endsWith('*') ? c.startsWith(p.slice(0, -1)) : c === p));

  const m = doc.monitoring ?? {};
  if (typeof m !== 'object' || Array.isArray(m)) errors.push('monitoring: must be a mapping (prometheus, loki, scrape_interval)');
  else {
    const before = errors.length;
    for (const k of ['prometheus', 'loki']) if (m[k] !== undefined && !isUrl(m[k])) errors.push(`monitoring.${k}: "${m[k]}" is not an http(s) URL`);
    if (m.scrape_interval !== undefined && !(parseDuration(m.scrape_interval) > 0)) errors.push(`monitoring.scrape_interval: "${m.scrape_interval}" is not a duration (e.g. 15s)`);
    const mon = { ...m };
    for (const k of CREDENTIAL_KEYS) {
      if (mon[k] === undefined) continue;
      if (source !== 'operator') { warnings.push(`monitoring.${k}: "${mon[k]}" is ignored: only the operator's inventory (HARNESS_OPS_INVENTORY) attaches Key Vault credentials to endpoints`); delete mon[k]; continue; }
      if (!SAFE.credential.test(String(mon[k]))) errors.push(`monitoring.${k}: "${mon[k]}" is not a vault name`);
      else if (!credOk(String(mon[k]))) errors.push(`monitoring.${k}: "${mon[k]}" is outside what this plugin may read from the vault (${vaultPatterns.join(', ')})`);
    }
    if (errors.length > before) errors.push('monitoring: left out of the inventory until fixed');
    else inv.monitoring = { ...mon, source };
  }

  const envNames = new Set();
  asList(doc.environments).forEach((e, i) => {
    const at = `environments[${i}]`;
    const env = typeof e === 'string' ? { name: e } : e;
    if (!env || typeof env !== 'object' || !NAME.test(String(env.name ?? ''))) { errors.push(`${at}: needs a name (letters, digits, . _ -)`); return; }
    if (envNames.has(env.name)) errors.push(`${at}: environment "${env.name}" appears twice`);
    envNames.add(env.name);
    inv.environments.push({ ...env, source });
  });
  const checkEnv = (at, env) => { if (env !== undefined && envNames.size && !envNames.has(env)) errors.push(`${at}: env "${env}" is not in environments (${[...envNames].join(', ')})`); };

  const hostNames = new Set(); const hostSeen = new Set();
  asList(doc.hosts).forEach((h, i) => {
    const at = `hosts[${i}]`;
    if (!h || typeof h !== 'object' || !NAME.test(String(h.name ?? ''))) { errors.push(`${at}: needs a name (letters, digits, . _ -)`); return; }
    const where = `hosts.${h.name}`;
    const before = errors.length;
    if (hostSeen.has(h.name)) errors.push(`${where}: host "${h.name}" appears twice`);
    hostSeen.add(h.name);
    if (h.name === 'local') errors.push(`${where}: "local" is reserved for the machine the harness runs on`);
    if (h.address !== undefined && !SAFE.address.test(String(h.address))) errors.push(`${where}: address "${h.address}" is not a host name or IP address`);
    const port = h.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`${where}: port ${port} is not a TCP port`);
    if (h.user !== undefined && !SAFE.user.test(String(h.user))) errors.push(`${where}: user "${h.user}" is not a valid user name`);
    let credential = h.credential;
    if (credential !== undefined && source !== 'operator') {
      warnings.push(`${where}: its credential "${credential}" is ignored: only the operator's inventory (HARNESS_OPS_INVENTORY) attaches Key Vault credentials to hosts`);
      credential = undefined;
    }
    if (credential !== undefined) {
      if (!SAFE.credential.test(String(credential))) errors.push(`${where}: credential "${credential}" is not a vault name`);
      else if (!credOk(String(credential))) errors.push(`${where}: credential "${credential}" is outside what this plugin may read from the vault (${vaultPatterns.join(', ')})`);
    }
    // The read-only account: an OS user the operator restricted (no sudo, read-only groups), used for
    // investigation without asking. Only the operator's file may declare one: a workspace that could would
    // make commands run unasked.
    let reader;
    if (h.readUser !== undefined || h.readCredential !== undefined) {
      if (source !== 'operator') warnings.push(`${where}: its read-only account (readUser, readCredential) is ignored: only the operator's inventory (HARNESS_OPS_INVENTORY) declares one`);
      else if (h.readUser === undefined || h.readCredential === undefined) errors.push(`${where}: a read-only account needs both readUser and readCredential`);
      else if (!SAFE.user.test(String(h.readUser))) errors.push(`${where}: readUser "${h.readUser}" is not a valid user name`);
      else if (!SAFE.credential.test(String(h.readCredential))) errors.push(`${where}: readCredential "${h.readCredential}" is not a vault name`);
      else if (!credOk(String(h.readCredential))) errors.push(`${where}: readCredential "${h.readCredential}" is outside what this plugin may read from the vault (${vaultPatterns.join(', ')})`);
      else if (String(h.readUser) === String(h.user ?? 'root')) warnings.push(`${where}: readUser "${h.readUser}" is the operator account itself: no read-only account (commands are asked as operator commands)`);
      else reader = { readUser: String(h.readUser), readCredential: String(h.readCredential) };
    }
    checkEnv(where, h.env);
    if (errors.length > before) { errors.push(`${where}: left out of the inventory until fixed`); return; }
    hostNames.add(h.name);
    if (h.address !== undefined && credential === undefined) warnings.push(`${where}: no credential, so ssh_exec and host_stats cannot reach it`);
    const { credential: _drop, readUser: _ru, readCredential: _rc, ...rest } = h;
    inv.hosts.push({ ...rest, ...(credential !== undefined ? { credential: String(credential) } : {}), ...(reader ?? {}), port, user: String(h.user ?? 'root'), tags: asList(h.tags).map(String), source });
  });

  const svcNames = new Set(); const svcSeen = new Set();
  asList(doc.services).forEach((s, i) => {
    const at = `services[${i}]`;
    if (!s || typeof s !== 'object' || !NAME.test(String(s.name ?? ''))) { errors.push(`${at}: needs a name (letters, digits, . _ -)`); return; }
    const where = `services.${s.name}`;
    const before = errors.length;
    if (svcSeen.has(s.name)) errors.push(`${where}: service "${s.name}" appears twice`);
    svcSeen.add(s.name);
    if (s.host !== undefined && s.host !== 'local' && !hostNames.has(s.host) && !external.hosts?.has(s.host)) errors.push(`${where}: host "${s.host}" is not in hosts`);
    if (s.health !== undefined && !isUrl(s.health)) errors.push(`${where}: health "${s.health}" is not an http(s) URL`);
    if (s.tls !== undefined && !isUrl(s.tls, ['https:']) && !/^[a-zA-Z0-9.-]+:\d+$/.test(String(s.tls))) errors.push(`${where}: tls "${s.tls}" is not an https URL or host:port`);
    if (s.container !== undefined && !SAFE.container.test(String(s.container))) errors.push(`${where}: container "${s.container}" is not a container name`);
    if (s.unit !== undefined && !SAFE.unit.test(String(s.unit))) errors.push(`${where}: unit "${s.unit}" is not a systemd unit name`);
    // What the service needs (its database host, another service): where to look when it is slow or failing.
    for (const d of asList(s.depends_on)) if (typeof d !== 'string' || !NAME.test(d)) errors.push(`${where}: depends_on "${d}" is not a host or service name`);
    if (s.logs !== undefined) {
      const l = s.logs;
      const ok = l && typeof l === 'object' && (typeof l.docker === 'string' || typeof l.loki === 'string' || typeof l.file === 'string');
      if (!ok) errors.push(`${where}: logs must be { docker: <container> }, { loki: <LogQL selector> } or { file: <path on the host> }`);
      else {
        if (l.file !== undefined && !SAFE.file.test(String(l.file))) errors.push(`${where}: logs.file must be an absolute path (letters, digits, . _ - @ + / only)`);
        if (l.docker !== undefined && !SAFE.container.test(String(l.docker))) errors.push(`${where}: logs.docker "${l.docker}" is not a container name`);
      }
    }
    checkEnv(where, s.env);
    const slos = [];
    asList(s.slos).forEach((o, j) => {
      const sat = `${where}.slos[${j}]`;
      if (!o || typeof o !== 'object' || !NAME.test(String(o.name ?? ''))) { errors.push(`${sat}: needs a name`); return; }
      const obj = Number(o.objective);
      if (!(obj > 0 && obj < 100)) errors.push(`${sat}: objective must be a percentage between 0 and 100 (e.g. 99.9)`);
      if (!(parseDuration(o.window ?? '30d') > 0)) errors.push(`${sat}: window "${o.window}" is not a duration`);
      if (typeof o.errors !== 'string' || typeof o.total !== 'string') errors.push(`${sat}: needs errors and total: PromQL rates of bad and all events, with [{{window}}] for the range (e.g. sum(rate(http_requests_total{code=~"5.."}[{{window}}])))`);
      slos.push({ window: '30d', ...o, objective: obj });
    });
    if (errors.length > before) { errors.push(`${where}: left out of the inventory until fixed`); return; }
    svcNames.add(s.name);
    if (!s.health && !s.metrics_job) warnings.push(`${where}: no health URL and no metrics job: nothing would notice it failing`);
    inv.services.push({ ...s, tags: asList(s.tags).map(String), ...(s.depends_on !== undefined ? { depends_on: asList(s.depends_on).map(String) } : {}), slos, source });
  });

  asList(doc.maintenance).forEach((w, i) => {
    const at = `maintenance[${i}]`;
    if (!w || typeof w !== 'object' || !NAME.test(String(w.name ?? ''))) { errors.push(`${at}: needs a name`); return; }
    const where = `maintenance.${w.name}`;
    const before = errors.length;
    const hasCron = typeof w.cron === 'string';
    const hasFixed = w.start !== undefined;
    if (hasCron === hasFixed) errors.push(`${where}: give either cron + duration (a recurring window) or start + end (a one-off)`);
    if (hasCron) {
      if (w.cron.trim().split(/\s+/).length !== 5) errors.push(`${where}: cron "${w.cron}" needs five fields (minute hour day-of-month month day-of-week)`);
      if (!(parseDuration(w.duration) > 0)) errors.push(`${where}: duration "${w.duration}" is not a duration (e.g. 2h)`);
    }
    if (hasFixed && (Number.isNaN(Date.parse(w.start)) || Number.isNaN(Date.parse(w.end)) || Date.parse(w.end) <= Date.parse(w.start))) errors.push(`${where}: start and end must be ISO times with end after start`);
    for (const h of asList(w.hosts)) if (!hostNames.has(h) && !external.hosts?.has(h)) errors.push(`${where}: host "${h}" is not in hosts`);
    for (const s of asList(w.services)) if (!svcNames.has(s)) errors.push(`${where}: service "${s}" is not in services`);
    checkEnv(where, w.env);
    if (errors.length > before) { errors.push(`${where}: left out of the inventory until fixed`); return; }
    inv.maintenance.push({ ...w, hosts: asList(w.hosts), services: asList(w.services), source });
  });

  const alertNames = new Set();
  asList(doc.alerts).forEach((a, i) => {
    const at = `alerts[${i}]`;
    if (!a || typeof a !== 'object' || !NAME.test(String(a.name ?? ''))) { errors.push(`${at}: needs a name`); return; }
    const where = `alerts.${a.name}`;
    const before = errors.length;
    if (alertNames.has(a.name)) errors.push(`${where}: alert "${a.name}" appears twice`);
    alertNames.add(a.name);
    const kinds = ['expr', 'probe', 'logs'].filter((k) => a[k] !== undefined);
    if (kinds.length !== 1) errors.push(`${where}: needs exactly one of expr (PromQL), probe or logs`);
    if (a.severity !== undefined && !SEVERITIES.includes(a.severity)) errors.push(`${where}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (a.for !== undefined && !(parseDuration(a.for) >= 0)) errors.push(`${where}: for "${a.for}" is not a duration`);
    if (a.service !== undefined && !svcNames.has(a.service)) errors.push(`${where}: service "${a.service}" is not in services`);
    if (a.expr !== undefined && (typeof a.expr !== 'string' || !a.expr.trim())) errors.push(`${where}: expr must be a PromQL expression`);
    if (typeof a.expr === 'string') { const p = promqlShape(a.expr); if (p) errors.push(`${where}: expr: ${p}`); }
    if (a.probe !== undefined) {
      const p = a.probe;
      if (!p || typeof p !== 'object' || !['http', 'tcp', 'dns', 'tls'].includes(p.type)) errors.push(`${where}: probe needs a type (http, tcp, dns, tls) and a target`);
      else if (!p.url && !p.target) errors.push(`${where}: probe needs url (http) or target (host:port, a name)`);
    }
    if (a.logs !== undefined) {
      const l = a.logs;
      if (!l || typeof l !== 'object' || typeof l.pattern !== 'string' || (!l.service && !l.container && !l.query)) errors.push(`${where}: logs needs a pattern and a service (or container, or a Loki query)`);
      else {
        try { new RegExp(l.pattern); } catch (e) { errors.push(`${where}: logs.pattern is not a regular expression: ${e.message}`); }
        if (l.service && !svcNames.has(l.service)) errors.push(`${where}: logs.service "${l.service}" is not in services`);
        if (l.window !== undefined && !(parseDuration(l.window) > 0)) errors.push(`${where}: logs.window "${l.window}" is not a duration`);
        if (l.container !== undefined && !SAFE.container.test(String(l.container))) errors.push(`${where}: logs.container "${l.container}" is not a container name`);
      }
    }
    if (errors.length > before) { errors.push(`${where}: left out of the inventory until fixed`); return; }
    inv.alerts.push({ severity: 'warning', ...a, source });
  });
  return { errors, warnings, inv };
}

/**
 * A quick local shape check of a PromQL expression (balanced brackets and
 * quotes, no template leftovers). The real parse check is the Prometheus API's.
 */
export function promqlShape(expr) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = []; let q = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if ('([{'.includes(c)) stack.push(c);
    else if (pairs[c]) { if (stack.pop() !== pairs[c]) return `unbalanced "${c}" at character ${i + 1}`; }
  }
  if (q) return 'an unterminated string';
  if (stack.length) return `unclosed "${stack[stack.length - 1]}"`;
  if (/\{\{.*\}\}/.test(expr.replace(/\{\{window\}\}/g, ''))) return 'a template placeholder is left in it';
  return '';
}

/**
 * The inventory a session sees: the operator's file and the workspace's,
 * merged as described above. Throws on unreadable/unparsable files with the
 * file named; validation problems are returned, not thrown.
 */
export async function loadInventory({ host, resolve, env = process.env, vaultPatterns }) {
  const docs = [];
  const notes = [];
  const opFile = env.HARNESS_OPS_INVENTORY;
  if (opFile) {
    const text = await readIf(opFile);
    if (text === undefined) throw new Error(`HARNESS_OPS_INVENTORY names ${opFile}, which does not exist`);
    let doc;
    try { doc = parseInventoryText(text, opFile); } catch (e) { throw new Error(`${opFile}: ${e.message}`); }
    docs.push({ source: 'operator', file: opFile, doc });
  }
  const ws = host ? await readWorkspaceInventory(host, resolve) : undefined;
  if (ws) {
    let doc;
    try { doc = parseInventoryText(ws.text, ws.rel); } catch (e) { throw new Error(`${ws.rel}: ${e.message}`); }
    docs.push({ source: 'workspace', file: ws.rel, doc });
  }
  const out = { monitoring: {}, environments: [], hosts: [], services: [], maintenance: [], alerts: [], files: docs.map((d) => `${d.file} (${d.source})`), errors: [], warnings: [] };
  for (const d of docs) {
    // The workspace's services may run on the operator's hosts (checked again after the merge).
    const r = validateInventory(d.doc, { source: d.source, vaultPatterns, external: { hosts: new Set(out.hosts.map((h) => h.name)) } });
    out.errors.push(...r.errors.map((e) => `${d.file}: ${e}`));
    out.warnings.push(...r.warnings.map((e) => `${d.file}: ${e}`));
    const fromWorkspaceUnderOperator = d.source === 'workspace' && !!opFile;
    if (fromWorkspaceUnderOperator) {
      if (r.inv.hosts.length) notes.push(`${d.file}: its ${r.inv.hosts.length} host(s) are ignored: with an operator inventory (HARNESS_OPS_INVENTORY), hosts come from the operator only`);
      if (Object.keys(d.doc?.monitoring ?? {}).length) notes.push(`${d.file}: its monitoring endpoints are ignored for the same reason`);
    } else {
      for (const k of Object.keys(r.inv.monitoring)) if (out.monitoring[k] === undefined) out.monitoring[k] = r.inv.monitoring[k];
      for (const h of r.inv.hosts) if (!out.hosts.some((x) => x.name === h.name)) out.hosts.push(h);
    }
    for (const k of ['environments', 'services', 'maintenance', 'alerts']) {
      for (const x of r.inv[k]) {
        if (out[k].some((y) => y.name === x.name)) { if (d.source === 'workspace') notes.push(`${d.file}: ${k}.${x.name} is ignored: the operator inventory defines it`); continue; }
        // A workspace service cannot claim an operator host it was not given: it is checked like any other reference.
        out[k].push(x);
      }
    }
  }
  if (fromEnv(env, 'HARNESS_OPS_PROMETHEUS_URL')) out.monitoring.prometheus = env.HARNESS_OPS_PROMETHEUS_URL;
  if (fromEnv(env, 'HARNESS_OPS_LOKI_URL')) out.monitoring.loki = env.HARNESS_OPS_LOKI_URL;
  // References from the workspace to hosts the operator file does not have: such a service is left out too.
  out.services = out.services.filter((s) => {
    if (!s.host || s.host === 'local' || out.hosts.some((h) => h.name === s.host)) return true;
    out.errors.push(`services.${s.name}: host "${s.host}" is not in the inventory's hosts (left out until fixed)`);
    return false;
  });
  for (const s of out.services) for (const d of s.depends_on ?? []) if (d !== 'local' && !out.hosts.some((h) => h.name === d) && !out.services.some((x) => x.name === d)) out.warnings.push(`services.${s.name}: depends_on "${d}" is neither a host nor a service in the inventory`);
  out.warnings.push(...notes);
  out.present = docs.length > 0 || !!out.monitoring.prometheus;
  return out;
}

const fromEnv = (env, k) => typeof env[k] === 'string' && env[k].trim() !== '';

let opCache;
/**
 * The operator's inventory alone, read synchronously (a permission check needs it
 * before a call runs: which vault entries the call will use), validated, cached
 * while the file is unchanged. Undefined without one or when it cannot be read.
 */
export function operatorInventorySync({ env = process.env, vaultPatterns } = {}) {
  const file = env.HARNESS_OPS_INVENTORY;
  if (!file) return undefined;
  try {
    const st = statSync(file);
    const key = `${file}|${st.mtimeMs}|${st.size}|${(vaultPatterns ?? []).join(',')}`;
    if (opCache?.key === key) return opCache.inv;
    const { inv } = validateInventory(parseInventoryText(readFileSync(file, 'utf8'), file), { source: 'operator', vaultPatterns });
    opCache = { key, inv };
    return inv;
  } catch { return undefined; }
}

export function findHost(inv, name) {
  if (name === 'local') return { name: 'local', local: true, tags: [], source: 'harness' };
  return inv.hosts.find((h) => h.name === name);
}
export function findService(inv, name) { return inv.services.find((s) => s.name === name); }

/** Filters hosts/services by tag, env, role, name substring. */
export function filterItems(items, { tag, env, role, name } = {}) {
  return items.filter((x) => (!tag || x.tags?.includes(tag)) && (!env || x.env === env) && (!role || x.role === role) && (!name || x.name.includes(name)));
}

/** Whether `when` falls in one of the windows for a host or service (cron windows checked minute by minute back over their duration). */
export function inMaintenance(inv, { host, service, env } = {}, when = Date.now(), cronTest) {
  const hits = [];
  for (const w of inv.maintenance) {
    const scoped = (w.hosts.length || w.services.length) ? (host && w.hosts.includes(host)) || (service && w.services.includes(service)) : (!w.env || !env || w.env === env);
    if (!scoped) continue;
    if (w.start) { if (when >= Date.parse(w.start) && when < Date.parse(w.end)) hits.push(w.name); continue; }
    if (w.cron && cronTest) {
      const test = cronTest(w.cron);
      const dur = parseDuration(w.duration);
      const startMin = Math.floor(when / 60_000) * 60_000;
      for (let t = startMin; t > when - dur; t -= 60_000) { if (test(new Date(t))) { hits.push(w.name); break; } }
    }
  }
  return hits;
}

export function relPath(p) { return p.split(path.sep).join('/'); }
