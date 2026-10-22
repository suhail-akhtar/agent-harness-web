// A service dependency graph merged from what is known about the estate:
// (a) the inventory (depends_on, and the host each service runs on),
// (b) traces (Tempo's service-graph metrics in Prometheus,
//     traces_service_graph_request_total{client, server}; Jaeger's dependencies API),
// (c) Kubernetes objects (Services and what they select, ownerReferences up to
//     the Deployment, env URLs naming other Services, ready endpoint counts),
//     read from every operator cluster with a read-only kubeconfig (shared.k8sObjects, lib/k8s.mjs),
// (d) Prometheus up{job, instance}: jobs, their instance counts, the hosts they run on.
// An edge A -> B means A depends on B (calls it, needs it, runs on it). Queries:
// what depends on X (blast radius), what X depends on (where a root cause may
// sit), single points of failure, and Mermaid text for reports.

import { opsTool } from './memory.mjs';
import { endpointConfig, jaegerClient } from './traces.mjs';
import { CredentialError, redact } from './secrets.mjs';
import { fmt } from './stats.mjs';

const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const err = (content) => ({ content, is_error: true });

// ---------------- the graph ----------------

export function newGraph() { return { nodes: new Map(), edges: new Map() }; }

export function addNode(g, name, { kind, source, ...info } = {}) {
  if (!name) return undefined;
  const n = g.nodes.get(name) ?? { name, kinds: new Set(), sources: new Set() };
  if (kind) n.kinds.add(kind);
  if (source) n.sources.add(source);
  for (const [k, v] of Object.entries(info)) if (v !== undefined) n[k] = v;
  g.nodes.set(name, n);
  return n;
}

export function addEdge(g, from, to, { kind = 'calls', source, ...info } = {}) {
  if (!from || !to || from === to) return undefined;
  addNode(g, from, { source }); addNode(g, to, { source });
  const key = `${from}\u0000${to}`;
  const e = g.edges.get(key) ?? { from, to, kinds: new Set(), sources: new Set() };
  e.kinds.add(kind);
  if (source) e.sources.add(source);
  for (const [k, v] of Object.entries(info)) if (v !== undefined) e[k] = v;
  g.edges.set(key, e);
  return e;
}

/** (a) The inventory: services, hosts, depends_on, runs-on. Trace and k8s names map to inventory names by trace_service / k8s_service. */
export function fromInventory(g, inv) {
  for (const h of inv.hosts ?? []) addNode(g, h.name, { kind: 'host', source: 'inventory', address: h.address });
  for (const s of inv.services ?? []) {
    addNode(g, s.name, { kind: 'service', source: 'inventory', job: s.metrics_job, owner: s.owner });
    if (s.host && s.host !== 'local') addEdge(g, s.name, s.host, { kind: 'runs_on', source: 'inventory' });
    for (const d of s.depends_on ?? []) addEdge(g, s.name, d, { kind: 'depends_on', source: 'inventory' });
  }
  return g;
}

/** The inventory name for a name seen elsewhere (a trace service, a k8s Service, a Prometheus job). */
export function aliasMap(inv) {
  const m = new Map();
  for (const s of inv?.services ?? []) {
    for (const k of [s.trace_service, s.otel_service, s.k8s_service, s.metrics_job, s.container]) if (k && !m.has(String(k))) m.set(String(k), s.name);
    m.set(s.name, s.name);
  }
  return m;
}

/** (b) Call edges from a trace service graph: [{ client, server, rate, errors }] (Tempo metrics) or [{ parent, child, callCount }] (Jaeger). */
export function fromTraceEdges(g, edges, { alias = new Map(), source = 'traces' } = {}) {
  for (const e of edges) {
    const a = alias.get(e.client ?? e.parent) ?? e.client ?? e.parent;
    const b = alias.get(e.server ?? e.child) ?? e.server ?? e.child;
    if (!a || !b || a === 'user' || a === 'unknown') { if (b) addNode(g, b, { kind: 'service', source }); continue; }
    addEdge(g, a, b, { kind: 'calls', source, rate: e.rate, errorRatio: e.rate > 0 && e.errors !== undefined ? e.errors / e.rate : undefined, calls: e.callCount });
    for (const n of [a, b]) addNode(g, n, { kind: 'service', source });
  }
  return g;
}

/** Service names in URLs and host:port values of environment variables (http://orders:8080, orders.shop.svc.cluster.local). */
function envTargets(value, services, ns) {
  const out = new Set();
  const re = /(?:^|[/@\s,=])([a-z0-9]([-a-z0-9]*[a-z0-9])?)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?)?(?::\d+)?(?=[/\s,]|$)/g;
  for (const m of String(value ?? '').matchAll(re)) {
    const name = m[1]; const nsOf = m[3] ?? ns;
    if (services.has(`${nsOf}/${name}`)) out.add(`${nsOf}/${name}`);
  }
  return out;
}

/**
 * (c) Kubernetes objects (List items: Service, Pod, ReplicaSet, Deployment,
 * StatefulSet, DaemonSet, Endpoints): Service -> the workloads it selects
 * (backed_by), workload -> the Services its env URLs name (calls), the
 * Service's ready endpoint count as its instances.
 */
export function fromK8s(g, objects, { alias = new Map() } = {}) {
  const items = objects.flatMap((o) => (o?.kind === 'List' || Array.isArray(o?.items) ? o.items ?? [] : [o])).filter(Boolean);
  const ns = (o) => o.metadata?.namespace ?? 'default';
  const svcs = items.filter((o) => o.kind === 'Service');
  const svcKey = new Set(svcs.map((s) => `${ns(s)}/${s.metadata.name}`));
  const name = (key) => { const short = key.split('/')[1]; return alias.get(short) ?? short; };
  const owners = new Map(items.filter((o) => ['ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(o.kind)).map((o) => [`${o.kind}/${ns(o)}/${o.metadata.name}`, o]));
  const top = (o) => {
    let cur = o;
    for (let i = 0; i < 5; i++) {
      const ref = (cur.metadata?.ownerReferences ?? []).find((r) => r.controller) ?? cur.metadata?.ownerReferences?.[0];
      if (!ref) break;
      const next = owners.get(`${ref.kind}/${ns(o)}/${ref.name}`);
      if (!next) return `${ref.kind.toLowerCase()}/${ref.name}`;
      cur = next;
    }
    return `${cur.kind.toLowerCase()}/${cur.metadata.name}`;
  };
  const pods = items.filter((o) => o.kind === 'Pod');
  const workloads = new Map();
  for (const p of pods) { const w = `${ns(p)}/${top(p)}`; if (!workloads.has(w)) workloads.set(w, { pods: [], ns: ns(p) }); workloads.get(w).pods.push(p); }
  for (const d of items.filter((o) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(o.kind))) {
    const w = `${ns(d)}/${d.kind.toLowerCase()}/${d.metadata.name}`;
    if (!workloads.has(w)) workloads.set(w, { pods: [{ metadata: { labels: d.spec?.template?.metadata?.labels ?? {}, namespace: ns(d) }, spec: d.spec?.template?.spec ?? {} }], ns: ns(d), replicas: d.spec?.replicas });
    else workloads.get(w).replicas = d.spec?.replicas;
  }
  const ready = new Map();
  for (const e of items.filter((o) => o.kind === 'Endpoints')) ready.set(`${ns(e)}/${e.metadata.name}`, (e.subsets ?? []).reduce((a, s) => a + (s.addresses ?? []).length, 0));
  for (const s of svcs) {
    const key = `${ns(s)}/${s.metadata.name}`;
    addNode(g, name(key), { kind: 'k8s-service', source: 'k8s', namespace: ns(s), ...(ready.has(key) ? { instances: ready.get(key) } : {}) });
    const sel = s.spec?.selector ?? {};
    if (!Object.keys(sel).length) continue;
    for (const [w, info] of workloads) {
      if (info.ns !== ns(s)) continue;
      if (!info.pods.some((p) => Object.entries(sel).every(([k, v]) => p.metadata?.labels?.[k] === v))) continue;
      const wName = w.split('/').slice(1).join('/');
      addNode(g, wName, { kind: 'workload', source: 'k8s', namespace: info.ns, replicas: info.replicas ?? info.pods.length });
      addEdge(g, name(key), wName, { kind: 'backed_by', source: 'k8s' });
      // What this workload's containers call: env values naming other Services.
      for (const p of info.pods.slice(0, 1)) {
        for (const c of [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? [])]) {
          for (const env of c.env ?? []) for (const t of envTargets(env.value, svcKey, info.ns)) if (t !== key) addEdge(g, name(key), name(t), { kind: 'calls', source: 'k8s-env', via: env.name });
        }
      }
    }
  }
  return g;
}

/** (d) Prometheus up: [{ job, instance, up }] -> job nodes with instance counts, and runs_on edges to inventory hosts by address. */
export function fromPromUp(g, rows, { alias = new Map(), hosts = [] } = {}) {
  const byJob = new Map();
  for (const r of rows) { const v = byJob.get(r.job) ?? { total: 0, up: 0, instances: [] }; v.total++; if (Number(r.up) === 1) v.up++; v.instances.push(r.instance); byJob.set(r.job, v); }
  for (const [job, v] of byJob) {
    const n = alias.get(job) ?? job;
    addNode(g, n, { kind: alias.has(job) ? 'service' : 'job', source: 'prometheus', instances: v.total, up: v.up, job });
    for (const inst of v.instances) {
      const addr = String(inst ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      const h = hosts.find((x) => x.address && x.address === addr);
      if (h) addEdge(g, n, h.name, { kind: 'runs_on', source: 'prometheus' });
    }
  }
  return g;
}

// ---------------- queries ----------------

const DEP_KINDS = new Set(['calls', 'depends_on', 'runs_on', 'backed_by']);
/** Adjacency: node -> [{ to, edge }] (forward: what it depends on) or reverse (what depends on it). */
export function adjacency(g, reverse = false) {
  const m = new Map([...g.nodes.keys()].map((n) => [n, []]));
  for (const e of g.edges.values()) {
    if (![...e.kinds].some((k) => DEP_KINDS.has(k))) continue;
    if (reverse) m.get(e.to).push({ to: e.from, edge: e }); else m.get(e.from).push({ to: e.to, edge: e });
  }
  return m;
}

/** Breadth-first from a node: [{ name, depth, via }] (via: the node it was reached from). */
export function walk(g, start, { reverse = false, depth = 5 } = {}) {
  const adj = adjacency(g, reverse);
  if (!adj.has(start)) return [];
  const seen = new Map([[start, { name: start, depth: 0 }]]);
  const q = [start];
  while (q.length) {
    const n = q.shift();
    const d = seen.get(n).depth;
    if (d >= depth) continue;
    for (const { to, edge } of adj.get(n) ?? []) {
      if (seen.has(to)) continue;
      seen.set(to, { name: to, depth: d + 1, via: n, edge });
      q.push(to);
    }
  }
  return [...seen.values()].filter((x) => x.depth > 0).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
}

/** Cut vertices of the undirected dependency graph (Tarjan): removing one splits the estate. */
export function articulationPoints(g) {
  const adj = new Map([...g.nodes.keys()].map((n) => [n, new Set()]));
  for (const e of g.edges.values()) if ([...e.kinds].some((k) => DEP_KINDS.has(k))) { adj.get(e.from).add(e.to); adj.get(e.to).add(e.from); }
  const disc = new Map(); const low = new Map(); const out = new Set(); let t = 0;
  const dfs = (u, parent) => {
    disc.set(u, ++t); low.set(u, t); let children = 0;
    for (const v of adj.get(u)) {
      if (!disc.has(v)) {
        children++; dfs(v, u);
        low.set(u, Math.min(low.get(u), low.get(v)));
        if (parent !== undefined && low.get(v) >= disc.get(u)) out.add(u);
      } else if (v !== parent) low.set(u, Math.min(low.get(u), disc.get(v)));
    }
    if (parent === undefined && children > 1) out.add(u);
  };
  for (const n of adj.keys()) if (!disc.has(n)) dfs(n, undefined);
  return out;
}

/**
 * Single points of failure: a node others depend on that has one instance (or an
 * unknown count and one host), ranked by how much depends on it transitively;
 * plus cut vertices and hosts that run several services.
 */
export function spof(g) {
  const rev = adjacency(g, true);
  const cuts = articulationPoints(g);
  const rows = [];
  for (const n of g.nodes.values()) {
    const direct = rev.get(n.name) ?? [];
    if (!direct.length) continue;
    const blast = walk(g, n.name, { reverse: true, depth: 10 });
    const reasons = [];
    if (n.instances === 1) reasons.push('one instance');
    if (n.kinds.has('host')) {
      const svcs = direct.filter((d) => d.edge.kinds.has('runs_on')).map((d) => d.to);
      if (svcs.length >= 2) reasons.push(`a host running ${svcs.length} services (${svcs.join(', ')})`);
      else if (direct.some((d) => d.edge.kinds.has('depends_on'))) reasons.push('a single host others depend on');
    }
    if (n.replicas === 1) reasons.push('one replica');
    if (n.up !== undefined && n.instances !== undefined && n.up < n.instances) reasons.push(`${n.instances - n.up} of ${n.instances} instance(s) down now`);
    if (cuts.has(n.name)) reasons.push('removing it disconnects the graph');
    if (!reasons.length) continue;
    rows.push({ name: n.name, kinds: [...n.kinds], dependents: blast.map((b) => b.name), reasons });
  }
  return rows.sort((a, b) => b.dependents.length - a.dependents.length || a.name.localeCompare(b.name));
}

/** Mermaid flowchart text: observed calls as solid arrows, declared dependencies dashed, the focus node highlighted. */
export function toMermaid(g, { focus, only } = {}) {
  const keep = only ? new Set(only) : undefined;
  const ids = new Map(); let i = 0;
  const id = (n) => { if (!ids.has(n)) ids.set(n, `n${i++}`); return ids.get(n); };
  const label = (n) => String(n).replace(/["[\]{}()<>|]/g, ' ').trim();
  const lines = ['graph LR'];
  for (const n of g.nodes.values()) {
    if (keep && !keep.has(n.name)) continue;
    const shape = n.kinds.has('host') ? [`[(`, `)]`] : n.kinds.has('workload') ? ['[/', '/]'] : ['[', ']'];
    lines.push(`  ${id(n.name)}${shape[0]}"${label(n.name)}${n.instances !== undefined ? ` x${n.instances}` : ''}"${shape[1]}`);
  }
  for (const e of g.edges.values()) {
    if (keep && (!keep.has(e.from) || !keep.has(e.to))) continue;
    const k = [...e.kinds];
    const tag = [e.rate !== undefined ? `${fmt(e.rate)}/s` : '', e.errorRatio ? `${fmt(e.errorRatio * 100)}% err` : '', k.includes('runs_on') ? 'runs on' : ''].filter(Boolean).join(' ');
    const arrow = k.includes('calls') ? '-->' : '-.->';
    lines.push(`  ${id(e.from)} ${arrow}${tag ? `|"${label(tag)}"|` : ''} ${id(e.to)}`);
  }
  if (focus && ids.has(focus)) lines.push(`  style ${ids.get(focus)} stroke-width:3px`);
  return lines.join('\n');
}

export function describeEdge(e) {
  return `${e.from} -> ${e.to} [${[...e.kinds].sort().join(',')}; ${[...e.sources].sort().join(',')}${e.rate !== undefined ? `; ${fmt(e.rate)} req/s` : ''}${e.errorRatio !== undefined ? `; ${fmt(e.errorRatio * 100)}% errors` : ''}${e.calls !== undefined ? `; ${e.calls} calls` : ''}${e.via ? `; via env ${e.via}` : ''}]`;
}

// ---------------- the tool ----------------

export function register(api, shared) {
  const { configured, invOrError, credential, op, names, prom, vaultPatterns, clip } = shared;
  const promCredOf = () => names(op()?.monitoring?.prometheus_credential);
  const jaegerCred = () => { const o = op(); const j = o ? endpointConfig(o, 'jaeger', vaultPatterns) : undefined; return names(j?.credential); };
  const opProm = () => !!(op()?.monitoring?.prometheus || process.env.HARNESS_OPS_PROMETHEUS_URL?.trim());

  async function build(inv, ctx, seen, { sources, window }) {
    const g = newGraph();
    const notes = [];
    const alias = aliasMap(inv);
    const want = (s) => !sources.length || sources.includes(s);
    if (want('inventory')) fromInventory(g, inv);
    let p;
    if ((want('traces') || want('prometheus')) && inv.monitoring.prometheus) {
      try { p = await prom(inv, ctx, seen); } catch (e) { notes.push(`Prometheus not used: ${e.message}`); }
    } else if (want('traces') || want('prometheus')) notes.push('no Prometheus configured: no service-graph metrics and no up/job data');
    if (want('traces') && p) {
      try {
        const q = (m) => `sum by (client, server) (rate(${m}[${window}]))`;
        const [req, failed] = await Promise.all([p.instant(q('traces_service_graph_request_total'), Date.now() / 1000, ctx.signal), p.instant(q('traces_service_graph_request_failed_total'), Date.now() / 1000, ctx.signal).catch(() => ({ result: [] }))]);
        const fail = new Map((failed.result ?? []).map((r) => [`${r.metric.client}\u0000${r.metric.server}`, Number(r.value[1])]));
        const edges = (req.result ?? []).map((r) => ({ client: r.metric.client, server: r.metric.server, rate: Number(r.value[1]), errors: fail.get(`${r.metric.client}\u0000${r.metric.server}`) ?? 0 }));
        fromTraceEdges(g, edges, { alias, source: 'tempo-service-graph' });
        notes.push(edges.length ? `${edges.length} call edge(s) from the Tempo service graph (traces_service_graph_request_total over ${window})` : 'no Tempo service-graph metrics in Prometheus (traces_service_graph_request_total): Tempo\'s metrics generator with the service-graphs processor writes them');
      } catch (e) { notes.push(`service-graph metrics not read: ${e.message}`); }
    }
    const jc = endpointConfig(inv, 'jaeger', vaultPatterns);
    if (want('traces') && jc?.url && !jc.error) {
      try {
        const token = jc.credential ? await credential(jc.credential, ctx, 'aiops: Jaeger API', seen) : undefined;
        const ms = (Number(String(window).replace(/[^\d]/g, '')) || 60) * ({ m: 60e3, h: 3600e3, d: 86400e3 }[String(window).slice(-1)] ?? 60e3);
        const deps = await jaegerClient({ url: jc.url, token }).dependencies(Date.now(), ms, ctx.signal);
        fromTraceEdges(g, deps, { alias, source: 'jaeger' });
        notes.push(`${deps.length} call edge(s) from Jaeger's dependencies`);
      } catch (e) { notes.push(`Jaeger dependencies not read: ${e.message}`); }
    }
    if (want('k8s')) {
      if (typeof shared.k8sObjects === 'function') {
        try { const objs = await shared.k8sObjects(ctx, { kinds: ['Service', 'Endpoints', 'Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet'] }); fromK8s(g, objs ?? [], { alias }); notes.push(`Kubernetes: ${(objs ?? []).length} object list(s) read`); } catch (e) { notes.push(`Kubernetes objects not read: ${e.message}`); }
      } else if (sources.includes('k8s')) notes.push('no Kubernetes source in this harness (the k8s tools can show services and workloads; edges from them are not merged here)');
    }
    if (want('prometheus') && p) {
      try {
        const up = await p.instant('up', Date.now() / 1000, ctx.signal);
        fromPromUp(g, (up.result ?? []).map((r) => ({ job: r.metric.job, instance: r.metric.instance, up: r.value[1] })), { alias, hosts: inv.hosts });
      } catch (e) { notes.push(`up not read: ${e.message}`); }
    }
    return { g, notes };
  }

  opsTool(api, shared, {
    name: 'topology',
    description: 'The service dependency graph, merged from the inventory (depends_on, the host a service runs on), traces (Tempo service-graph metrics in Prometheus, Jaeger dependencies), Kubernetes (Services, workloads, env URLs; from clusters in the operator's inventory with a read-only kubeconfig) and Prometheus (up by job and instance). An edge A -> B means A depends on B. "graph": nodes and edges with their sources, request rates and error ratios; "dependents": what depends on a service, transitively (blast radius); "dependencies": what it depends on (where a root cause may sit: walk these and check each); "spof": single points of failure (one instance, a shared host, cut vertices) ranked by what depends on them; "mermaid": the graph (or the part around a service) as Mermaid text for a report.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['graph', 'dependents', 'dependencies', 'spof', 'mermaid'] },
        service: { type: 'string', description: 'dependents / dependencies / mermaid: the node' },
        depth: { type: 'number', description: 'levels to walk (default 5)' },
        sources: { type: 'array', items: { type: 'string', enum: ['inventory', 'traces', 'k8s', 'prometheus'] }, description: 'default: all that are configured' },
        window: { type: 'string', description: 'the rate window for trace edges (default 1h)' },
      },
      required: ['action'], additionalProperties: false,
    },
    kind: 'network', parallelSafe: true, untrusted: true,
    kindsFor: () => [opProm() ? 'read' : 'network'],
    sendsOut: () => !opProm(),
    vaultNames: () => names(...promCredOf(), ...jaegerCred(), ...(shared.k8sReadCredentials?.() ?? [])),
    availableIn: configured,
    summarize: (i) => `topology ${str(i.action)}${i.service ? ` ${str(i.service)}` : ''}`,
    async run(input, ctx) {
      const { inv, error } = await invOrError(ctx);
      if (error) return error;
      const action = str(input.action);
      const seen = new Set();
      const window = /^\d+[mhd]$/.test(str(input.window)) ? str(input.window) : '1h';
      try {
        const { g, notes } = await build(inv, ctx, seen, { sources: Array.isArray(input.sources) ? input.sources.map(String) : [], window });
        const head = `Topology: ${g.nodes.size} node(s), ${g.edges.size} edge(s).${notes.length ? ` ${notes.join('; ')}.` : ''}`;
        const depth = Math.min(20, Math.max(1, Number(input.depth) || 5));
        const svc = str(input.service);
        if ((action === 'dependents' || action === 'dependencies') && !g.nodes.has(svc)) return err(`"${svc}" is not in the graph (nodes: ${[...g.nodes.keys()].sort().join(', ').slice(0, 1500)})`);
        if (action === 'dependents' || action === 'dependencies') {
          const rev = action === 'dependents';
          const list = walk(g, svc, { reverse: rev, depth });
          if (!list.length) return `${head}\nNothing ${rev ? 'depends on' : `that ${svc} depends on is known`}${rev ? ` ${svc}` : ''} (within ${depth} levels).`;
          return clip(redact(`${head}\n${rev ? `What depends on ${svc} (blast radius: these can fail when it does)` : `What ${svc} depends on (check these for the root cause, nearest first)`} - ${list.length} node(s):\n${list.map((x) => `${'  '.repeat(x.depth)}${x.name} (depth ${x.depth}, via ${x.via}) ${describeEdge(x.edge).replace(/^.*?\[/, '[')}`).join('\n')}\n\n${toMermaid(g, { focus: svc, only: [svc, ...list.map((x) => x.name)] })}`, seen));
        }
        if (action === 'spof') {
          const rows = spof(g);
          if (!rows.length) return `${head}\nNo single point of failure found from what is known (instance counts come from Prometheus up and Kubernetes endpoints; add depends_on to the inventory for what they do not show).`;
          return clip(redact(`${head}\n${rows.length} single point(s) of failure, most depended on first:\n${rows.map((r) => `- ${r.name} (${r.kinds.join(',') || 'node'}): ${r.reasons.join('; ')}; ${r.dependents.length} node(s) depend on it${r.dependents.length ? `: ${r.dependents.slice(0, 12).join(', ')}` : ''}`).join('\n')}`, seen));
        }
        if (action === 'mermaid') {
          const only = svc && g.nodes.has(svc) ? [svc, ...walk(g, svc, { depth }).map((x) => x.name), ...walk(g, svc, { reverse: true, depth }).map((x) => x.name)] : undefined;
          return redact(`${head}\n\n\`\`\`mermaid\n${toMermaid(g, { focus: svc || undefined, only })}\n\`\`\``, seen);
        }
        if (action === 'graph') {
          const nodes = [...g.nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
          const adj = adjacency(g);
          return clip(redact(`${head}\nNodes:\n${nodes.map((n) => `- ${n.name} (${[...n.kinds].join(',') || '?'}; from ${[...n.sources].join(',')}${n.instances !== undefined ? `; ${n.up ?? '?'}/${n.instances} up` : ''}${n.replicas !== undefined ? `; ${n.replicas} replica(s)` : ''}) -> ${(adj.get(n.name) ?? []).map((x) => x.to).join(', ') || '(nothing)'}`).join('\n')}\nEdges:\n${[...g.edges.values()].map(describeEdge).join('\n')}`, seen));
        }
        return err(`unknown action "${action}"`);
      } catch (e) { return err(redact(e instanceof CredentialError ? e.message : `topology ${action}: ${e.message}`, seen)); }
    },
  });
}
