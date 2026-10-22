/**
 * The diagram spec: architecture, deployment, data (ER), code and flow diagrams as one JSON object.
 * Shared by models (a ```diagram block or an artifact of kind "diagram"), plugins and the renderer
 * (packages/ui/src/render/diagram), so all three agree on one shape. DESIGN section 16.
 *
 *   { "view": "deployment", "title": "CRM",
 *     "groups": [{ "id": "dmz", "kind": "zone", "label": "DMZ zone", "subtitle": "subnet dmz 10.42.10.0/24", "tone": "amber" }],
 *     "nodes":  [{ "id": "proxy", "kind": "reverse-proxy", "title": "Proxy", "tech": "nginx 1.27", "group": "dmz", "status": "done" }, ...],
 *     "edges":  [{ "from": "proxy", "to": "web", "label": "https" }, ...],
 *     "flows":  [{ "id": "login", "title": "Login", "steps": [{ "from": "user", "to": "proxy", "label": "POST /login" }, ...] }] }
 *
 * `validateDiagram` reads untrusted input (a model's, a plugin's, a file's): it never throws, names
 * the exact mistake when there is one (a model repairs from the message), bounds every size, and
 * returns a clean copy (strings trimmed and capped, aliases mapped, ids checked). Pure: no DOM.
 * Also here, so the renderer, the desktop and the tests share one answer: the diff between two
 * versions (the "changed" badges), flow sequencing, neighbourhoods and the summary line.
 */

export const DIAGRAM_VIEWS = ['context', 'container', 'component', 'deployment', 'data', 'code', 'flow'] as const;
export type DiagramView = typeof DIAGRAM_VIEWS[number];

/** The node catalogue: each kind has an icon and a caption ("RELATIONAL DATABASE"). */
export const NODE_KINDS = [
  'person', 'web-app', 'mobile-app', 'desktop-app', 'api', 'service', 'function', 'worker', 'batch-job',
  'relational-db', 'document-db', 'key-value', 'cache', 'queue', 'stream', 'storage', 'search',
  'reverse-proxy', 'load-balancer', 'gateway', 'cdn', 'dns', 'secrets', 'identity', 'monitoring',
  'external-system', 'internet', 'browser', 'device', 'folder', 'file', 'table', 'container', 'custom',
] as const;
export type NodeKind = typeof NODE_KINDS[number];

/** What a kind is called on its card. */
export const NODE_CAPTIONS: Record<NodeKind, string> = {
  person: 'Person', 'web-app': 'Web application', 'mobile-app': 'Mobile app', 'desktop-app': 'Desktop app', api: 'API', service: 'Service',
  function: 'Function', worker: 'Worker', 'batch-job': 'Batch job', 'relational-db': 'Relational database', 'document-db': 'Document store',
  'key-value': 'Key-value store', cache: 'Cache', queue: 'Queue', stream: 'Stream', storage: 'Object storage', search: 'Search index',
  'reverse-proxy': 'Reverse proxy', 'load-balancer': 'Load balancer', gateway: 'API gateway', cdn: 'CDN', dns: 'DNS', secrets: 'Secrets vault',
  identity: 'Identity provider', monitoring: 'Monitoring', 'external-system': 'External system', internet: 'Internet', browser: 'Browser',
  device: 'Device', folder: 'Folder', file: 'File', table: 'Table', container: 'Container', custom: 'Component',
};

/** Words models use for a kind, mapped to the catalogue (anything else becomes "custom" with a warning). */
const KIND_ALIASES: Record<string, NodeKind> = {
  user: 'person', actor: 'person', human: 'person', customer: 'person', people: 'person',
  webapp: 'web-app', web: 'web-app', frontend: 'web-app', spa: 'web-app', website: 'web-app', 'web-application': 'web-app', ui: 'web-app',
  mobile: 'mobile-app', app: 'web-app', ios: 'mobile-app', android: 'mobile-app', desktop: 'desktop-app',
  backend: 'service', microservice: 'service', server: 'service', 'micro-service': 'service', component: 'custom', system: 'service', application: 'service',
  lambda: 'function', serverless: 'function', 'cloud-function': 'function', job: 'batch-job', cron: 'batch-job', batch: 'batch-job', 'cron-job': 'batch-job', scheduler: 'batch-job', backup: 'batch-job',
  database: 'relational-db', db: 'relational-db', sql: 'relational-db', rdbms: 'relational-db', postgres: 'relational-db', postgresql: 'relational-db', mysql: 'relational-db', 'relational-database': 'relational-db',
  mongodb: 'document-db', mongo: 'document-db', nosql: 'document-db', 'document-store': 'document-db', dynamodb: 'key-value', kv: 'key-value', 'key-value-store': 'key-value',
  redis: 'cache', memcached: 'cache', mq: 'queue', 'message-queue': 'queue', rabbitmq: 'queue', sqs: 'queue', kafka: 'stream', 'event-stream': 'stream', topic: 'stream', 'event-bus': 'stream',
  s3: 'storage', blob: 'storage', bucket: 'storage', 'object-storage': 'storage', disk: 'storage', volume: 'storage', elasticsearch: 'search', opensearch: 'search', 'search-index': 'search',
  proxy: 'reverse-proxy', nginx: 'reverse-proxy', ingress: 'reverse-proxy', 'reverse proxy': 'reverse-proxy', lb: 'load-balancer', 'load balancer': 'load-balancer', 'api-gateway': 'gateway',
  vault: 'secrets', 'key-vault': 'secrets', kms: 'secrets', secret: 'secrets', auth: 'identity', idp: 'identity', sso: 'identity', oauth: 'identity', keycloak: 'identity',
  observability: 'monitoring', metrics: 'monitoring', logging: 'monitoring', prometheus: 'monitoring', grafana: 'monitoring',
  external: 'external-system', 'third-party': 'external-system', saas: 'external-system', 'external system': 'external-system', internet: 'internet', www: 'internet',
  client: 'browser', phone: 'device', iot: 'device', sensor: 'device', directory: 'folder', module: 'folder', package: 'folder', source: 'file', entity: 'table',
  pod: 'container', docker: 'container', vm: 'container',
};

export const GROUP_KINDS = ['host', 'network', 'zone', 'subnet', 'cluster', 'region', 'boundary'] as const;
export type GroupKind = typeof GROUP_KINDS[number];
const GROUP_ALIASES: Record<string, GroupKind> = { vpc: 'network', vnet: 'network', vm: 'host', server: 'host', machine: 'host', node: 'host', k8s: 'cluster', kubernetes: 'cluster', namespace: 'cluster', az: 'region', 'availability-zone': 'region', system: 'boundary', context: 'boundary', domain: 'boundary', group: 'boundary', module: 'boundary', dmz: 'zone' };

export const TONES = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'gray', 'pink', 'indigo', 'orange'] as const;
export type Tone = typeof TONES[number];

export const NODE_STATUSES = ['done', 'in-progress', 'failing', 'planned'] as const;
export type NodeStatus = typeof NODE_STATUSES[number];
const STATUS_ALIASES: Record<string, NodeStatus> = {
  done: 'done', built: 'done', live: 'done', ok: 'done', ready: 'done', complete: 'done', completed: 'done', deployed: 'done', healthy: 'done',
  'in-progress': 'in-progress', in_progress: 'in-progress', progress: 'in-progress', wip: 'in-progress', building: 'in-progress', running: 'in-progress', 'in progress': 'in-progress',
  failing: 'failing', failed: 'failing', error: 'failing', down: 'failing', broken: 'failing', unhealthy: 'failing',
  planned: 'planned', todo: 'planned', proposed: 'planned', future: 'planned', 'not-started': 'planned',
};

export const EDGE_KINDS = ['uses', 'https', 'http', 'sql', 'grpc', 'tcp', 'udp', 'amqp', 'event', 'file', 'env', 'import', 'reads', 'writes', 'calls', 'depends', 'ssh', 'dns', 'other'] as const;
export type EdgeKind = typeof EDGE_KINDS[number];
export const CARDINALITIES = ['1:1', '1:n', 'n:1', 'n:m'] as const;
export type Cardinality = typeof CARDINALITIES[number];
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = typeof FINDING_SEVERITIES[number];

export interface DiagramField { name: string; type?: string; pk?: boolean; fk?: string | boolean; uk?: boolean; pii?: boolean; nullable?: boolean; note?: string }
export interface DiagramLink { label?: string; file?: string; url?: string; line?: number }
export interface DiagramFinding { severity: FindingSeverity; title: string; detail?: string }

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  title: string;
  /** The technology line under the title ("PostgreSQL 16"). */
  tech?: string;
  description?: string;
  status?: NodeStatus;
  /** Bought or integrated rather than built here: drawn dashed. */
  integrated?: boolean;
  /** The id of the group it sits in. */
  group?: string;
  /** Deployment: a size line ("2 vCPU · 4 GB") and an address line ("10.42.10.5:443"). */
  size?: string;
  address?: string;
  /** Data (ER): the table's columns. */
  fields?: DiagramField[];
  links?: DiagramLink[];
  findings?: DiagramFinding[];
  tags?: string[];
  /** Code view: counts shown on the card. */
  files?: number;
  /** Set by the renderer (the version diff), or by a model to point at what it changed. */
  changed?: boolean;
}

export interface DiagramGroup { id: string; kind: GroupKind; label: string; subtitle?: string; tone?: Tone; parent?: string; collapsed?: boolean }

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Asynchronous (a message, an event, a job): drawn dashed. */
  async?: boolean;
  /** Bundled edges: how many (imports between two folders, calls). */
  count?: number;
  kind?: EdgeKind;
  /** Data (ER): "n:1" reads "many rows of from point at one row of to". */
  cardinality?: Cardinality;
  description?: string;
}

export interface DiagramFlowStep { edge?: string; from?: string; to?: string; label: string; note?: string }
export interface DiagramFlow { id: string; title: string; description?: string; steps: DiagramFlowStep[] }

export interface DiagramLayout {
  /** Which way the layers run (default: right; ER and code read down). */
  direction?: 'right' | 'down' | 'left' | 'up';
  spacing?: 'compact' | 'normal' | 'wide';
  /** Saved positions (top-left corners, world units) by node id: what dragging writes back. */
  positions?: Record<string, { x: number; y: number }>;
}

export interface DiagramSpec {
  version?: 1;
  view: DiagramView;
  title?: string;
  description?: string;
  nodes: DiagramNode[];
  groups?: DiagramGroup[];
  edges?: DiagramEdge[];
  flows?: DiagramFlow[];
  layout?: DiagramLayout;
}

/** The bounds every spec is held to (a hostile or runaway one is refused with which bound it broke). */
export const DIAGRAM_LIMITS = {
  nodes: 600, edges: 2000, groups: 200, groupDepth: 8, flows: 40, steps: 120, fields: 200, links: 30, findings: 50, tags: 12,
  source: 1_500_000, id: 80, title: 160, line: 200, description: 4000,
} as const;

export interface DiagramResult { spec?: DiagramSpec; error?: string; warnings: string[] }

const ID = /^[A-Za-z0-9_][A-Za-z0-9_.:/@-]*$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// Control characters (and the bidirectional overrides that make "evil.exe" read as "exe.live") never reach a label.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

function text(v: unknown, max: number): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined;
}
function para(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(CONTROL, '').replace(/\r\n?/g, '\n').trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined;
}
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
const quote = (s: string) => `"${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`;
const list = (ids: Iterable<string>, n = 8) => { const a = [...ids]; return a.slice(0, n).join(', ') + (a.length > n ? `, … (${a.length})` : ''); };

/** A safe link: http(s) URLs only; workspace files as relative paths without "..". */
function cleanLink(v: unknown): DiagramLink | undefined {
  if (typeof v === 'string') v = /^https?:\/\//i.test(v) ? { url: v } : { file: v };
  if (!isObj(v)) return undefined;
  const label = text(v.label ?? v.title, DIAGRAM_LIMITS.line);
  let url: string | undefined;
  if (typeof v.url === 'string') {
    try { const u = new URL(v.url.trim()); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href.slice(0, 2000); } catch { /* not a URL */ }
  }
  let file: string | undefined;
  if (typeof v.file === 'string' || typeof v.path === 'string') {
    const f = String(v.file ?? v.path).replace(CONTROL, '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (f && f.length <= 400 && !f.split('/').includes('..') && !/^[a-z]+:/i.test(f) && !f.startsWith('/')) file = f;
  }
  if (!url && !file) return undefined;
  const line = typeof v.line === 'number' && Number.isInteger(v.line) && v.line > 0 ? v.line : undefined;
  return { ...(label ? { label } : {}), ...(url ? { url } : {}), ...(file ? { file } : {}), ...(line ? { line } : {}) };
}

/**
 * Reads a diagram (a JSON string or a parsed value). Never throws. On success `spec` is a clean
 * copy; `error` names the first mistake that keeps it from being drawn; `warnings` list what was
 * repaired (an unknown kind drawn as "custom", a flow step with no edge drawn on its own).
 */
export function validateDiagram(raw: unknown): DiagramResult {
  const warnings: string[] = [];
  const fail = (error: string): DiagramResult => ({ error, warnings });
  if (typeof raw === 'string') {
    if (raw.length > DIAGRAM_LIMITS.source) return fail(`the diagram is ${Math.round(raw.length / 1024)} KB of JSON; at most ${DIAGRAM_LIMITS.source / 1000} KB`);
    if (!raw.trim()) return fail('the diagram is empty: write a JSON object with "view" and "nodes"');
    try { raw = JSON.parse(raw); } catch (e) { return fail(`the diagram is not valid JSON: ${(e as Error).message.slice(0, 200)}`); }
  }
  if (!isObj(raw)) return fail('a diagram is a JSON object with "view", "nodes" and usually "edges"');
  const o = raw;
  // ---- view
  let view: DiagramView | undefined;
  const v = norm(o.view ?? o.type ?? 'container');
  const VIEW_ALIASES: Record<string, DiagramView> = { architecture: 'container', containers: 'container', system: 'context', 'system-context': 'context', components: 'component', infrastructure: 'deployment', infra: 'deployment', network: 'deployment', er: 'data', erd: 'data', database: 'data', schema: 'data', dependencies: 'code', dependency: 'code', imports: 'code', flowchart: 'flow', sequence: 'flow', process: 'flow' };
  view = (DIAGRAM_VIEWS as readonly string[]).includes(v) ? v as DiagramView : VIEW_ALIASES[v];
  if (!view) return fail(`"view" is ${quote(String(o.view ?? o.type))}: use one of ${DIAGRAM_VIEWS.join(', ')}`);
  // ---- groups
  const groups: DiagramGroup[] = [];
  const groupIds = new Set<string>();
  if (o.groups !== undefined) {
    if (!Array.isArray(o.groups)) return fail('"groups" must be a list of {id, kind, label}');
    if (o.groups.length > DIAGRAM_LIMITS.groups) return fail(`${o.groups.length} groups: at most ${DIAGRAM_LIMITS.groups}`);
    for (let i = 0; i < o.groups.length; i++) {
      const g = o.groups[i];
      if (!isObj(g)) return fail(`group ${i + 1} is not an object`);
      const id = typeof g.id === 'string' || typeof g.id === 'number' ? String(g.id).trim() : '';
      if (!id) return fail(`group ${i + 1} has no "id"`);
      const idErr = checkId(id, `group ${i + 1}`);
      if (idErr) return fail(idErr);
      if (groupIds.has(id)) return fail(`two groups have the id ${quote(id)}`);
      groupIds.add(id);
      const k = norm(g.kind ?? 'boundary');
      let kind = (GROUP_KINDS as readonly string[]).includes(k) ? k as GroupKind : GROUP_ALIASES[k];
      if (!kind) { warnings.push(`group ${quote(id)} has kind ${quote(String(g.kind))}; drawn as a boundary (kinds: ${GROUP_KINDS.join(', ')})`); kind = 'boundary'; }
      const tone = TONES.includes(norm(g.tone ?? g.color ?? g.colour) as Tone) ? norm(g.tone ?? g.color ?? g.colour) as Tone : undefined;
      const parent = g.parent === undefined || g.parent === null || g.parent === '' ? undefined : String(g.parent).trim();
      groups.push({ id, kind, label: text(g.label ?? g.title ?? g.name, DIAGRAM_LIMITS.title) ?? id, ...(text(g.subtitle, DIAGRAM_LIMITS.line) ? { subtitle: text(g.subtitle, DIAGRAM_LIMITS.line) } : {}), ...(tone ? { tone } : {}), ...(parent ? { parent } : {}), ...(g.collapsed === true ? { collapsed: true } : {}) });
    }
    // Parents exist, are not the group itself, form no cycle and nest at most groupDepth deep.
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const g of groups) {
      if (g.parent === undefined) continue;
      if (!byId.has(g.parent)) return fail(`group ${quote(g.id)} has parent ${quote(g.parent)}, which is not a group id (groups: ${list(groupIds)})`);
      const seen = new Set([g.id]);
      let p: string | undefined = g.parent;
      let depth = 1;
      while (p !== undefined) {
        if (seen.has(p)) return fail(`groups ${list([...seen, p], 6)} contain each other in a cycle: a group cannot be inside itself`);
        seen.add(p);
        if (++depth > DIAGRAM_LIMITS.groupDepth) return fail(`groups nest more than ${DIAGRAM_LIMITS.groupDepth} deep (at ${quote(g.id)})`);
        p = byId.get(p)?.parent;
      }
    }
  }
  // ---- nodes
  if (!Array.isArray(o.nodes)) return fail('no "nodes" list: a diagram needs at least one node {id, kind, title}');
  if (!o.nodes.length) return fail('"nodes" is empty: there is nothing to draw');
  if (o.nodes.length > DIAGRAM_LIMITS.nodes) return fail(`${o.nodes.length} nodes: at most ${DIAGRAM_LIMITS.nodes} (fold the rest into groups or split the diagram)`);
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<string>();
  for (let i = 0; i < o.nodes.length; i++) {
    const n = o.nodes[i];
    if (!isObj(n)) return fail(`node ${i + 1} is not an object`);
    const id = typeof n.id === 'string' || typeof n.id === 'number' ? String(n.id).trim() : '';
    if (!id) return fail(`node ${i + 1}${typeof n.title === 'string' ? ` (${quote(n.title)})` : ''} has no "id"`);
    const idErr = checkId(id, `node ${i + 1}`);
    if (idErr) return fail(idErr);
    if (nodeIds.has(id)) return fail(`two nodes have the id ${quote(id)}: ids must be unique`);
    if (groupIds.has(id)) return fail(`${quote(id)} is both a node and a group id: use different ids`);
    nodeIds.add(id);
    const rawKind = n.kind ?? n.type ?? (view === 'data' ? 'table' : view === 'code' ? 'folder' : 'service');
    const k = norm(rawKind);
    let kind = (NODE_KINDS as readonly string[]).includes(k) ? k as NodeKind : KIND_ALIASES[k] ?? KIND_ALIASES[k.replace(/-/g, ' ')];
    if (!kind) { warnings.push(`node ${quote(id)} has kind ${quote(String(rawKind))}; drawn as "custom"`); kind = 'custom'; }
    const title = text(n.title ?? n.label ?? n.name, DIAGRAM_LIMITS.title) ?? id;
    const node: DiagramNode = { id, kind, title };
    const tech = text(n.tech ?? n.technology, DIAGRAM_LIMITS.line); if (tech) node.tech = tech;
    const description = para(n.description, DIAGRAM_LIMITS.description); if (description) node.description = description;
    if (n.status !== undefined && n.status !== null && n.status !== '') {
      const s = STATUS_ALIASES[String(n.status).trim().toLowerCase()] ?? STATUS_ALIASES[norm(n.status)];
      if (s) node.status = s; else warnings.push(`node ${quote(id)} has status ${quote(String(n.status))}; left without a badge (statuses: ${NODE_STATUSES.join(', ')})`);
    }
    if (n.integrated === true || n.external === true || n.bought === true) node.integrated = true;
    if (n.group !== undefined && n.group !== null && n.group !== '') {
      const g = String(n.group).trim();
      if (!groupIds.has(g)) return fail(`node ${quote(id)} is in group ${quote(g)}, which is not a group id${groupIds.size ? ` (groups: ${list(groupIds)})` : ': add it to "groups"'}`);
      node.group = g;
    }
    const size = text(n.size, DIAGRAM_LIMITS.line); if (size) node.size = size;
    const address = text(n.address ?? n.ip ?? n.host, DIAGRAM_LIMITS.line); if (address) node.address = address;
    if (n.fields !== undefined || n.columns !== undefined) {
      const fs = n.fields ?? n.columns;
      if (!Array.isArray(fs)) return fail(`node ${quote(id)}: "fields" must be a list of {name, type, pk?, fk?, uk?, pii?}`);
      if (fs.length > DIAGRAM_LIMITS.fields) return fail(`node ${quote(id)} has ${fs.length} fields: at most ${DIAGRAM_LIMITS.fields}`);
      node.fields = [];
      for (const [j, f] of fs.entries()) {
        const field = typeof f === 'string' ? { name: f } : f;
        if (!isObj(field)) return fail(`node ${quote(id)} field ${j + 1} is not an object`);
        const name = text(field.name, 80);
        if (!name) return fail(`node ${quote(id)} field ${j + 1} has no "name"`);
        const out: DiagramField = { name };
        const type = text(field.type, 60); if (type) out.type = type;
        if (field.pk === true || field.primary === true) out.pk = true;
        if (field.fk === true) out.fk = true; else { const fk = text(field.fk ?? field.references, 120); if (fk) out.fk = fk; }
        if (field.uk === true || field.unique === true) out.uk = true;
        if (field.pii === true) out.pii = true;
        if (field.nullable === true) out.nullable = true;
        const note = text(field.note, DIAGRAM_LIMITS.line); if (note) out.note = note;
        node.fields.push(out);
      }
    }
    if (n.links !== undefined) {
      if (!Array.isArray(n.links)) return fail(`node ${quote(id)}: "links" must be a list of {label?, file?|url?}`);
      const links = n.links.slice(0, DIAGRAM_LIMITS.links).map(cleanLink).filter((x): x is DiagramLink => !!x);
      if (links.length < Math.min(n.links.length, DIAGRAM_LIMITS.links)) warnings.push(`node ${quote(id)}: links other than http(s) addresses and workspace files were left out`);
      if (links.length) node.links = links;
    }
    if (n.findings !== undefined) {
      if (!Array.isArray(n.findings)) return fail(`node ${quote(id)}: "findings" must be a list of {severity, title, detail?}`);
      const findings: DiagramFinding[] = [];
      for (const f of n.findings.slice(0, DIAGRAM_LIMITS.findings)) {
        const fo = typeof f === 'string' ? { title: f } : f;
        if (!isObj(fo)) continue;
        const t = text(fo.title ?? fo.summary, DIAGRAM_LIMITS.line);
        if (!t) continue;
        const sev = norm(fo.severity ?? 'medium');
        findings.push({ severity: (FINDING_SEVERITIES as readonly string[]).includes(sev) ? sev as FindingSeverity : sev === 'warning' ? 'medium' : sev === 'error' ? 'high' : 'info', title: t, ...(para(fo.detail, 2000) ? { detail: para(fo.detail, 2000) } : {}) });
      }
      if (findings.length) node.findings = findings;
    }
    if (Array.isArray(n.tags)) { const tags = n.tags.map((t) => text(t, 40)).filter((t): t is string => !!t).slice(0, DIAGRAM_LIMITS.tags); if (tags.length) node.tags = tags; }
    if (typeof n.files === 'number' && Number.isFinite(n.files) && n.files >= 0) node.files = Math.round(n.files);
    if (n.changed === true) node.changed = true;
    nodes.push(node);
  }
  // ---- edges
  const edges: DiagramEdge[] = [];
  const edgeIds = new Set<string>();
  if (o.edges !== undefined && !Array.isArray(o.edges)) return fail('"edges" must be a list of {from, to, label?}');
  const rawEdges = (o.edges ?? []) as unknown[];
  if (rawEdges.length > DIAGRAM_LIMITS.edges) return fail(`${rawEdges.length} edges: at most ${DIAGRAM_LIMITS.edges} (bundle parallel edges with "count")`);
  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i];
    if (!isObj(e)) return fail(`edge ${i + 1} is not an object`);
    const from = String(e.from ?? e.source ?? '').trim();
    const to = String(e.to ?? e.target ?? '').trim();
    const where = `edge ${i + 1}${e.label ? ` (${quote(String(e.label))})` : ''}`;
    if (!from || !to) return fail(`${where} needs "from" and "to" (node ids)`);
    for (const [end, id] of [['from', from], ['to', to]] as const) {
      if (!nodeIds.has(id)) return fail(`${where} ${end === 'from' ? 'starts at' : 'goes to'} ${quote(id)}, which is not a node id${groupIds.has(id) ? ' (it is a group: connect a node inside it)' : ` (nodes: ${list(nodeIds)})`}`);
    }
    let id = typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id).trim() : '';
    if (id) {
      const idErr = checkId(id, where);
      if (idErr) return fail(idErr);
      if (edgeIds.has(id)) return fail(`two edges have the id ${quote(id)}`);
    } else {
      id = `e${i + 1}`;
      while (edgeIds.has(id)) id = `${id}_`;
    }
    edgeIds.add(id);
    const edge: DiagramEdge = { id, from, to };
    const label = text(e.label, 120); if (label) edge.label = label;
    if (e.async === true || e.asynchronous === true || norm(e.style) === 'dashed') edge.async = true;
    if (typeof e.count === 'number' && Number.isFinite(e.count) && e.count > 0) edge.count = Math.min(1e9, Math.round(e.count));
    if (e.kind !== undefined) { const k = norm(e.kind); edge.kind = (EDGE_KINDS as readonly string[]).includes(k) ? k as EdgeKind : 'other'; }
    if (e.cardinality !== undefined) {
      const c = String(e.cardinality).trim().toLowerCase().replace(/\s/g, '').replace(/^\*:/, 'n:').replace(/:\*$/, ':n').replace(/^m:/, 'n:').replace('n:n', 'n:m').replace('1:m', '1:n').replace('m:1', 'n:1');
      if ((CARDINALITIES as readonly string[]).includes(c)) edge.cardinality = c as Cardinality;
      else warnings.push(`${where} has cardinality ${quote(String(e.cardinality))}; use one of ${CARDINALITIES.join(', ')}`);
    }
    const d = para(e.description, 1000); if (d) edge.description = d;
    edges.push(edge);
  }
  // ---- flows
  const flows: DiagramFlow[] = [];
  if (o.flows !== undefined) {
    if (!Array.isArray(o.flows)) return fail('"flows" must be a list of {id, title, steps: [{from, to, label}]}');
    if (o.flows.length > DIAGRAM_LIMITS.flows) return fail(`${o.flows.length} flows: at most ${DIAGRAM_LIMITS.flows}`);
    const flowIds = new Set<string>();
    for (let i = 0; i < o.flows.length; i++) {
      const f = o.flows[i];
      if (!isObj(f)) return fail(`flow ${i + 1} is not an object`);
      let id = typeof f.id === 'string' || typeof f.id === 'number' ? String(f.id).trim() : `flow${i + 1}`;
      const idErr = checkId(id, `flow ${i + 1}`);
      if (idErr) return fail(idErr);
      while (flowIds.has(id)) id = `${id}_`;
      flowIds.add(id);
      const title = text(f.title ?? f.name, DIAGRAM_LIMITS.title) ?? id;
      if (!Array.isArray(f.steps) || !f.steps.length) return fail(`flow ${quote(title)} has no "steps": list them as {from, to, label} or {edge, label}`);
      if (f.steps.length > DIAGRAM_LIMITS.steps) return fail(`flow ${quote(title)} has ${f.steps.length} steps: at most ${DIAGRAM_LIMITS.steps}`);
      const steps: DiagramFlowStep[] = [];
      for (let j = 0; j < f.steps.length; j++) {
        const s = f.steps[j];
        if (!isObj(s)) return fail(`flow ${quote(title)} step ${j + 1} is not an object`);
        const where = `flow ${quote(title)} step ${j + 1}`;
        const step: DiagramFlowStep = { label: text(s.label ?? s.title ?? s.action, DIAGRAM_LIMITS.line) ?? '' };
        if (s.edge !== undefined) {
          const eid = String(s.edge).trim();
          if (!edgeIds.has(eid)) return fail(`${where} names edge ${quote(eid)}, which is not an edge id${edgeIds.size ? ` (edges: ${list(edgeIds)})` : ''}`);
          step.edge = eid;
        } else {
          const from = String(s.from ?? '').trim();
          const to = String(s.to ?? '').trim();
          if (!from || !to) return fail(`${where} needs "edge" (an edge id) or "from" and "to" (node ids)`);
          for (const id2 of [from, to]) if (!nodeIds.has(id2)) return fail(`${where} names ${quote(id2)}, which is not a node id (nodes: ${list(nodeIds)})`);
          step.from = from; step.to = to;
          if (!edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) warnings.push(`${where} goes from ${quote(from)} to ${quote(to)} with no edge between them: drawn on its own while the flow plays`);
        }
        if (!step.label) step.label = `Step ${j + 1}`;
        const note = text(s.note, DIAGRAM_LIMITS.line); if (note) step.note = note;
        steps.push(step);
      }
      flows.push({ id, title, ...(para(f.description, 1000) ? { description: para(f.description, 1000) } : {}), steps });
    }
  }
  // ---- layout
  let layout: DiagramLayout | undefined;
  if (o.layout !== undefined) {
    if (!isObj(o.layout)) return fail('"layout" must be an object {direction?, spacing?, positions?}');
    const l = o.layout;
    layout = {};
    const dir = norm(l.direction);
    const DIRS: Record<string, DiagramLayout['direction']> = { right: 'right', lr: 'right', 'left-to-right': 'right', down: 'down', tb: 'down', 'top-down': 'down', 'top-to-bottom': 'down', left: 'left', rl: 'left', up: 'up', bt: 'up' };
    if (DIRS[dir]) layout.direction = DIRS[dir];
    if (l.spacing === 'compact' || l.spacing === 'normal' || l.spacing === 'wide') layout.spacing = l.spacing;
    if (l.positions !== undefined) {
      if (!isObj(l.positions)) return fail('"layout.positions" must be an object {nodeId: {x, y}}');
      const positions: Record<string, { x: number; y: number }> = {};
      for (const [k, p] of Object.entries(l.positions)) {
        if (!nodeIds.has(k) || RESERVED.has(k)) continue; // a node that is gone keeps no position
        if (!isObj(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) return fail(`layout.positions.${k} must be {x, y} with finite numbers`);
        positions[k] = { x: Math.round(p.x), y: Math.round(p.y) };
      }
      if (Object.keys(positions).length) layout.positions = positions;
    }
    if (!Object.keys(layout).length) layout = undefined;
  }
  const spec: DiagramSpec = {
    version: 1, view, ...(text(o.title, DIAGRAM_LIMITS.title) ? { title: text(o.title, DIAGRAM_LIMITS.title) } : {}),
    ...(para(o.description, DIAGRAM_LIMITS.description) ? { description: para(o.description, DIAGRAM_LIMITS.description) } : {}),
    nodes, ...(groups.length ? { groups } : {}), ...(edges.length ? { edges } : {}), ...(flows.length ? { flows } : {}), ...(layout ? { layout } : {}),
  };
  return { spec, warnings };
}

function checkId(id: string, where: string): string | undefined {
  if (id.length > DIAGRAM_LIMITS.id) return `${where}: the id ${quote(id)} is longer than ${DIAGRAM_LIMITS.id} characters`;
  if (RESERVED.has(id)) return `${where}: ${quote(id)} cannot be an id`;
  if (!ID.test(id)) return `${where}: the id ${quote(id)} may only use letters, digits and _ . : / @ -`;
  return undefined;
}

/** The default reading direction of a view. */
export function directionOf(spec: DiagramSpec): NonNullable<DiagramLayout['direction']> {
  return spec.layout?.direction ?? (spec.view === 'data' || spec.view === 'code' ? 'down' : 'right');
}

// ---------------- the version diff: what the "changed" badges mark ----------------

export interface DiagramDiff {
  /** Nodes new in `next`. */
  added: string[];
  /** Nodes in both whose content differs (positions do not count). */
  changed: string[];
  removed: string[];
  /** Edges (by "from->to label") new in `next`, as their ids there. */
  edgesAdded: string[];
  edgesRemoved: number;
  /** added + changed: the nodes that get the "changed" badge. */
  marked: string[];
}

const nodeKey = (n: DiagramNode) => JSON.stringify([n.kind, n.title, n.tech ?? '', n.description ?? '', n.status ?? '', !!n.integrated, n.group ?? '', n.size ?? '', n.address ?? '', n.fields ?? [], n.links ?? [], n.findings ?? [], n.tags ?? [], n.files ?? null]);
const edgeKey = (e: DiagramEdge) => `${e.from}\u0000${e.to}\u0000${e.label ?? ''}\u0000${e.async ? 1 : 0}\u0000${e.cardinality ?? ''}`;

/** What changed between two versions of a diagram (layout aside). */
export function diffDiagrams(prev: DiagramSpec, next: DiagramSpec): DiagramDiff {
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const after = new Map(next.nodes.map((n) => [n.id, n]));
  const added: string[] = []; const changed: string[] = []; const removed: string[] = [];
  for (const n of next.nodes) {
    const p = before.get(n.id);
    if (!p) added.push(n.id); else if (nodeKey(p) !== nodeKey(n)) changed.push(n.id);
  }
  for (const n of prev.nodes) if (!after.has(n.id)) removed.push(n.id);
  const prevEdges = new Map<string, number>();
  for (const e of prev.edges ?? []) prevEdges.set(edgeKey(e), (prevEdges.get(edgeKey(e)) ?? 0) + 1);
  const edgesAdded: string[] = [];
  for (const e of next.edges ?? []) {
    const k = edgeKey(e);
    const left = prevEdges.get(k) ?? 0;
    if (left > 0) prevEdges.set(k, left - 1); else edgesAdded.push(e.id);
  }
  let edgesRemoved = 0;
  for (const v of prevEdges.values()) edgesRemoved += v;
  return { added, changed, removed, edgesAdded, edgesRemoved, marked: [...added, ...changed] };
}

/** One line for a toast: "1 added (Cache), 1 changed, 1 relation removed". */
export function describeDiff(d: DiagramDiff, next: DiagramSpec): string {
  const title = (id: string) => next.nodes.find((n) => n.id === id)?.title ?? id;
  const parts: string[] = [];
  if (d.added.length) parts.push(`${d.added.length} added (${d.added.slice(0, 3).map(title).join(', ')}${d.added.length > 3 ? ', …' : ''})`);
  if (d.changed.length) parts.push(`${d.changed.length} changed`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  if (d.edgesAdded.length) parts.push(`${d.edgesAdded.length} new relation${d.edgesAdded.length === 1 ? '' : 's'}`);
  if (d.edgesRemoved) parts.push(`${d.edgesRemoved} relation${d.edgesRemoved === 1 ? '' : 's'} removed`);
  return parts.join(', ') || 'only the layout changed';
}

// ---------------- flows: steps resolved to edges, and playback ----------------

export interface ResolvedStep {
  index: number;
  label: string;
  note?: string;
  from: string;
  to: string;
  /** The edge it rides (undefined: no edge between them, drawn on its own). */
  edge?: string;
  /** It goes against the edge's direction (a reply). */
  reversed: boolean;
}

/** A flow's steps with the edge each one rides and its direction. */
export function resolveFlow(spec: DiagramSpec, flowId: string): ResolvedStep[] {
  const flow = spec.flows?.find((f) => f.id === flowId);
  if (!flow) return [];
  const edges = spec.edges ?? [];
  return flow.steps.map((s, index) => {
    if (s.edge) {
      const e = edges.find((x) => x.id === s.edge)!;
      return { index, label: s.label, ...(s.note ? { note: s.note } : {}), from: e.from, to: e.to, edge: e.id, reversed: false };
    }
    const fwd = edges.find((e) => e.from === s.from && e.to === s.to);
    const back = fwd ? undefined : edges.find((e) => e.from === s.to && e.to === s.from);
    return { index, label: s.label, ...(s.note ? { note: s.note } : {}), from: s.from!, to: s.to!, ...(fwd ?? back ? { edge: (fwd ?? back)!.id } : {}), reversed: !fwd && !!back };
  });
}

export interface FlowFrame {
  /** Steps shown so far (0..step), each with the edge it lights. */
  shown: ResolvedStep[];
  current?: ResolvedStep;
  /** Nodes on the path so far: everything else dims. */
  lit: Set<string>;
  /** Edges on the path so far. */
  litEdges: Set<string>;
}

/** What is drawn at a step of a flow (step -1: nothing yet). */
export function flowFrame(steps: ResolvedStep[], step: number): FlowFrame {
  const k = Math.min(step, steps.length - 1);
  const shown = k >= 0 ? steps.slice(0, k + 1) : [];
  const lit = new Set<string>();
  const litEdges = new Set<string>();
  for (const s of shown) { lit.add(s.from); lit.add(s.to); if (s.edge) litEdges.add(s.edge); }
  return { shown, current: shown[shown.length - 1], lit, litEdges };
}

export interface PlaybackState { flow: string | null; step: number; playing: boolean; speed: number; length: number }
export type PlaybackAction =
  | { type: 'select'; flow: string | null; length: number }
  | { type: 'play' } | { type: 'pause' } | { type: 'toggle' }
  | { type: 'next' } | { type: 'prev' } | { type: 'tick' } | { type: 'goto'; step: number }
  | { type: 'speed'; speed: number } | { type: 'reset' };

export const PLAYBACK_START: PlaybackState = { flow: null, step: -1, playing: false, speed: 1, length: 0 };
export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;
/** How long a step stays before the next one, at speed 1. */
export const STEP_MS = 1600;

/** The flow player as a reducer: the canvas runs a timer that dispatches `tick` while playing. */
export function playback(s: PlaybackState, a: PlaybackAction): PlaybackState {
  const last = s.length - 1;
  switch (a.type) {
    case 'select': return { ...s, flow: a.flow, length: a.flow ? a.length : 0, step: -1, playing: false };
    case 'play':
      if (!s.flow || s.length === 0) return s;
      // Playing at the end starts over.
      return { ...s, playing: true, step: s.step >= last ? 0 : Math.max(0, s.step) };
    case 'pause': return { ...s, playing: false };
    case 'toggle': return playback(s, { type: s.playing ? 'pause' : 'play' });
    case 'next': return s.flow ? { ...s, playing: false, step: Math.min(last, s.step + 1) } : s;
    case 'prev': return s.flow ? { ...s, playing: false, step: Math.max(-1, s.step - 1) } : s;
    case 'goto': return s.flow ? { ...s, playing: false, step: Math.max(-1, Math.min(last, Math.round(a.step))) } : s;
    case 'tick':
      if (!s.playing) return s;
      if (s.step >= last) return { ...s, playing: false };
      return { ...s, step: s.step + 1, playing: s.step + 1 < last };
    case 'speed': return { ...s, speed: (PLAYBACK_SPEEDS as readonly number[]).includes(a.speed) ? a.speed : 1 };
    case 'reset': return { ...s, step: -1, playing: false };
  }
}

// ---------------- graph questions the canvas asks ----------------

/** A node and everything within `hops` edges of it (either direction). */
export function neighbourhood(spec: DiagramSpec, center: string, hops = 1): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of spec.edges ?? []) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set([center]);
  let frontier = [center];
  for (let h = 0; h < Math.max(0, Math.min(6, hops)); h++) {
    const next: string[] = [];
    for (const f of frontier) for (const t of adj.get(f) ?? []) if (!seen.has(t)) { seen.add(t); next.push(t); }
    if (!next.length) break;
    frontier = next;
  }
  return seen;
}

/** The part of a diagram a set of nodes makes: those nodes, the groups around them, the edges among them. */
export function subDiagram(spec: DiagramSpec, keep: Set<string>): DiagramSpec {
  const nodes = spec.nodes.filter((n) => keep.has(n.id));
  const groupIds = new Set<string>();
  const byId = new Map((spec.groups ?? []).map((g) => [g.id, g]));
  for (const n of nodes) { let g = n.group; while (g && !groupIds.has(g)) { groupIds.add(g); g = byId.get(g)?.parent; } }
  const edges = (spec.edges ?? []).filter((e) => keep.has(e.from) && keep.has(e.to));
  const edgeIds = new Set(edges.map((e) => e.id));
  const flows = (spec.flows ?? []).filter((f) => f.steps.every((s) => (s.edge ? edgeIds.has(s.edge) : keep.has(s.from!) && keep.has(s.to!))));
  return { ...spec, nodes, groups: (spec.groups ?? []).filter((g) => groupIds.has(g.id)), edges, flows, layout: spec.layout ? { ...spec.layout, positions: undefined } : undefined };
}

/** Nodes with no edge at all. */
export function unconnected(spec: DiagramSpec): string[] {
  const linked = new Set<string>();
  for (const e of spec.edges ?? []) { linked.add(e.from); linked.add(e.to); }
  return spec.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
}

export interface DiagramSummary { built: number; integrated: number; relations: number; flows: number; findings: number; nodes: number; groups: number }

/** The counts behind the summary line. */
export function summarizeDiagram(spec: DiagramSpec): DiagramSummary {
  let built = 0; let integrated = 0; let findings = 0;
  for (const n of spec.nodes) {
    if (n.integrated || n.kind === 'external-system' || n.kind === 'internet') integrated++;
    else if (n.kind !== 'person' && n.kind !== 'browser' && n.kind !== 'device' && n.kind !== 'table' && n.kind !== 'file' && n.kind !== 'folder') built++;
    findings += n.findings?.length ?? 0;
  }
  return { built, integrated, relations: spec.edges?.length ?? 0, flows: spec.flows?.length ?? 0, findings, nodes: spec.nodes.length, groups: spec.groups?.length ?? 0 };
}

/** "3 built · 4 integrated · 8 relations · 2 flows · 1 finding" (parts that are 0 are left out, except relations). */
export function summaryLine(s: DiagramSummary, view?: DiagramView): string {
  const p = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (view === 'data') parts.push(p(s.nodes, 'table'));
  else if (view === 'code') parts.push(p(s.nodes, 'module'));
  else { if (s.built) parts.push(`${s.built} built`); if (s.integrated) parts.push(`${s.integrated} integrated`); }
  parts.push(p(s.relations, 'relation'));
  if (s.flows) parts.push(p(s.flows, 'flow'));
  if (s.findings) parts.push(p(s.findings, 'finding'));
  return parts.join(' · ');
}

/**
 * The spec as JSON for an artifact: two-space indentation, with each saved position on one line
 * (`"web": { "x": 120, "y": 40 }`) so a model's find/replace edits stay small and readable.
 */
export function stringifyDiagram(spec: DiagramSpec): string {
  const json = JSON.stringify(spec, null, 2);
  return json.replace(/\{\n\s+"x": (-?\d+(?:\.\d+)?),\n\s+"y": (-?\d+(?:\.\d+)?)\n\s+\}/g, '{ "x": $1, "y": $2 }');
}

/** Saved positions put into a spec's own JSON (the rest of the text is kept as the model wrote it where it can be). */
export function withPositions(source: string, positions: Record<string, { x: number; y: number }>): string {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const layout = (parsed.layout && typeof parsed.layout === 'object' && !Array.isArray(parsed.layout) ? parsed.layout : {}) as Record<string, unknown>;
  const clean: Record<string, { x: number; y: number }> = {};
  for (const [k, p] of Object.entries(positions)) if (!RESERVED.has(k) && Number.isFinite(p.x) && Number.isFinite(p.y)) clean[k] = { x: Math.round(p.x), y: Math.round(p.y) };
  parsed.layout = { ...layout, positions: clean };
  return stringifyDiagram(parsed as unknown as DiagramSpec);
}
