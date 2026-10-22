// Diagram specs for the tests, the e2e run and the screenshots: one per view (context, container,
// component, deployment with zones, data/ER, code, flow), hostile ones, and a big one for speed.

const ctx = {
  view: 'context', title: 'CRM - system context',
  nodes: [
    { id: 'rep', kind: 'person', title: 'Sales rep', tech: 'Works deals every day' },
    { id: 'customer', kind: 'person', title: 'Customer', tech: 'Self-service portal' },
    { id: 'crm', kind: 'web-app', title: 'CRM', tech: 'Next.js 15 · Postgres', status: 'done', description: 'Deals, contacts and the customer portal.', links: [{ label: 'Repository', url: 'https://example.com/acme/crm' }, { file: 'docs/architecture.md' }] },
    { id: 'idp', kind: 'identity', title: 'Identity provider', tech: 'Entra ID · OIDC', integrated: true, status: 'done' },
    { id: 'mail', kind: 'external-system', title: 'Email', tech: 'SendGrid', integrated: true, status: 'done' },
    { id: 'pay', kind: 'external-system', title: 'Payments', tech: 'Stripe', integrated: true, status: 'in-progress' },
    { id: 'analytics', kind: 'external-system', title: 'Analytics', tech: 'Segment', integrated: true, status: 'planned' },
    { id: 'erp', kind: 'external-system', title: 'Legacy ERP', tech: 'SAP R/3 (to retire)', integrated: true, status: 'planned' },
  ],
  edges: [
    { from: 'rep', to: 'crm', label: 'manages deals' },
    { from: 'customer', to: 'crm', label: 'self-service' },
    { from: 'crm', to: 'idp', label: 'signs in (OIDC)' },
    { from: 'crm', to: 'mail', label: 'sends mail', async: true },
    { from: 'crm', to: 'pay', label: 'charges cards' },
    { from: 'crm', to: 'analytics', label: 'events', async: true },
  ],
};

const container = {
  view: 'container', title: 'CRM - containers',
  groups: [{ id: 'platform', kind: 'boundary', label: 'CRM platform', subtitle: 'built by the CRM team', tone: 'blue' }],
  nodes: [
    { id: 'rep', kind: 'person', title: 'Sales rep' },
    { id: 'web', kind: 'web-app', title: 'Web app', tech: 'React 19 · Vite', group: 'platform', status: 'done' },
    { id: 'api', kind: 'api', title: 'API', tech: 'Node 22 · Fastify', group: 'platform', status: 'done', links: [{ file: 'src/server/app.ts', line: 12 }] },
    { id: 'worker', kind: 'worker', title: 'Jobs worker', tech: 'BullMQ', group: 'platform', status: 'in-progress' },
    { id: 'db', kind: 'relational-db', title: 'Database', tech: 'PostgreSQL 16', group: 'platform', status: 'done' },
    { id: 'queue', kind: 'queue', title: 'Job queue', tech: 'Redis streams', group: 'platform', status: 'done' },
    { id: 'search', kind: 'search', title: 'Search', tech: 'OpenSearch 2', group: 'platform', status: 'failing', findings: [{ severity: 'high', title: 'Index lags the database by 40 minutes', detail: 'The change-data stream stalls when a deal has more than 500 activities.' }] },
    { id: 'secrets', kind: 'secrets', title: 'Secrets', tech: 'HashiCorp Vault', integrated: true, status: 'done' },
    { id: 'mail', kind: 'external-system', title: 'Email', tech: 'SendGrid', integrated: true },
  ],
  edges: [
    { id: 'e-rep-web', from: 'rep', to: 'web', label: 'https' },
    { id: 'e-web-api', from: 'web', to: 'api', label: 'REST / JSON' },
    { id: 'e-api-db', from: 'api', to: 'db', label: 'sql' },
    { id: 'e-api-queue', from: 'api', to: 'queue', label: 'enqueue', async: true },
    { id: 'e-queue-worker', from: 'queue', to: 'worker', label: 'jobs', async: true },
    { id: 'e-worker-mail', from: 'worker', to: 'mail', label: 'sends mail' },
    { id: 'e-api-search', from: 'api', to: 'search', label: 'queries' },
    { id: 'e-worker-search', from: 'worker', to: 'search', label: 'indexes', async: true },
    { id: 'e-api-secrets', from: 'api', to: 'secrets', label: 'env' },
  ],
  flows: [{ id: 'create-deal', title: 'Create a deal', steps: [
    { from: 'rep', to: 'web', label: 'fill in the deal form' },
    { from: 'web', to: 'api', label: 'POST /deals' },
    { from: 'api', to: 'db', label: 'INSERT INTO deals' },
    { from: 'api', to: 'queue', label: 'enqueue "deal-created"' },
    { from: 'queue', to: 'worker', label: 'worker picks the job' },
    { from: 'worker', to: 'mail', label: 'email the account owner' },
  ] }],
};

const component = {
  view: 'component', title: 'API - components',
  groups: [{ id: 'api', kind: 'boundary', label: 'API', subtitle: 'Node 22 · Fastify', tone: 'indigo' }],
  nodes: [
    { id: 'routes', kind: 'api', title: 'Deal routes', tech: 'src/routes/deals.ts', group: 'api', status: 'done', links: [{ file: 'src/routes/deals.ts' }] },
    { id: 'auth', kind: 'identity', title: 'Auth middleware', tech: 'JWT · OIDC', group: 'api', status: 'done' },
    { id: 'service', kind: 'service', title: 'Deal service', tech: 'business rules', group: 'api', status: 'in-progress' },
    { id: 'repo', kind: 'service', title: 'Deal repository', tech: 'Drizzle ORM', group: 'api', status: 'done' },
    { id: 'events', kind: 'stream', title: 'Event publisher', tech: 'outbox table', group: 'api', status: 'planned' },
    { id: 'db', kind: 'relational-db', title: 'Database', tech: 'PostgreSQL 16' },
  ],
  edges: [
    { from: 'routes', to: 'auth', label: 'checks token' },
    { from: 'routes', to: 'service', label: 'calls' },
    { from: 'service', to: 'repo', label: 'reads / writes' },
    { from: 'service', to: 'events', label: 'publishes', async: true },
    { from: 'repo', to: 'db', label: 'sql' },
    { from: 'events', to: 'db', label: 'outbox', async: true },
  ],
};

const deployment = {
  view: 'deployment', title: 'CRM - production deployment',
  groups: [
    { id: 'host', kind: 'host', label: 'vm-prod-01', subtitle: 'Ubuntu 24.04 · 8 vCPU · 32 GB' },
    { id: 'dmz', kind: 'zone', label: 'DMZ zone', subtitle: 'subnet dmz 10.42.10.0/24', tone: 'amber', parent: 'host' },
    { id: 'app', kind: 'zone', label: 'App zone', subtitle: 'subnet app 10.42.20.0/24', tone: 'blue', parent: 'host' },
    { id: 'data', kind: 'zone', label: 'Data zone', subtitle: 'subnet data 10.42.29.0/24', tone: 'purple', parent: 'host' },
  ],
  nodes: [
    { id: 'user', kind: 'person', title: 'Sales rep', tech: 'browser' },
    { id: 'proxy', kind: 'reverse-proxy', title: 'Reverse proxy', tech: 'nginx 1.27 · TLS', group: 'dmz', status: 'done', address: '10.42.10.2:443', size: '1 vCPU · 512 MB' },
    { id: 'web', kind: 'web-app', title: 'CRM web app', tech: 'Node 22 · Next.js', group: 'app', status: 'done', address: '10.42.20.5:3000', size: '2 vCPU · 2 GB' },
    { id: 'backup', kind: 'batch-job', title: 'Backup job', tech: 'pg_dump · nightly 02:00', group: 'app', status: 'in-progress', address: '10.42.20.9' },
    { id: 'db', kind: 'relational-db', title: 'CRM database', tech: 'PostgreSQL 16', group: 'data', status: 'done', address: '10.42.29.3:5432', size: '4 vCPU · 8 GB · 200 GB',
      findings: [{ severity: 'medium', title: 'Backups are not encrypted at rest' }] },
    { id: 'secrets', kind: 'secrets', title: 'Secrets', tech: 'HashiCorp Vault', group: 'data', integrated: true, status: 'done', address: '10.42.29.8:8200' },
    { id: 'bucket', kind: 'storage', title: 'Backup bucket', tech: 'S3 · crm-backups', integrated: true, status: 'done' },
  ],
  edges: [
    { id: 'e1', from: 'user', to: 'proxy', label: 'https 443' },
    { id: 'e2', from: 'proxy', to: 'web', label: 'http 3000' },
    { id: 'e3', from: 'web', to: 'db', label: 'sql 5432' },
    { id: 'e4', from: 'web', to: 'secrets', label: 'env · token' },
    { id: 'e5', from: 'backup', to: 'db', label: 'pg_dump' },
    { id: 'e6', from: 'backup', to: 'bucket', label: 'upload', async: true },
    { id: 'e7', from: 'backup', to: 'secrets', label: 'reads creds' },
  ],
  flows: [{ id: 'login', title: 'Login', steps: [
    { edge: 'e1', label: 'POST /login over TLS' },
    { edge: 'e2', label: 'forward to 10.42.20.5:3000' },
    { edge: 'e4', label: 'read the session signing key' },
    { edge: 'e3', label: 'connect 10.42.20.5 -> 10.42.29.3:5432 as crm_app' },
    { from: 'db', to: 'web', label: 'the user row (bcrypt hash)' },
    { from: 'proxy', to: 'user', label: 'Set-Cookie: session' },
  ] }],
};

const data = {
  view: 'data', title: 'CRM - data model',
  nodes: [
    { id: 'accounts', kind: 'table', title: 'accounts', fields: [
      { name: 'id', type: 'uuid', pk: true }, { name: 'name', type: 'text' }, { name: 'domain', type: 'text', uk: true }, { name: 'owner_id', type: 'uuid', fk: 'users.id' }, { name: 'created_at', type: 'timestamptz' },
    ] },
    { id: 'contacts', kind: 'table', title: 'contacts', fields: [
      { name: 'id', type: 'uuid', pk: true }, { name: 'account_id', type: 'uuid', fk: 'accounts.id' }, { name: 'email', type: 'citext', uk: true, pii: true }, { name: 'full_name', type: 'text', pii: true },
      { name: 'phone', type: 'text', pii: true }, { name: 'title', type: 'text' }, { name: 'linkedin', type: 'text' }, { name: 'consent', type: 'boolean' }, { name: 'source', type: 'text' }, { name: 'created_at', type: 'timestamptz' }, { name: 'updated_at', type: 'timestamptz' },
    ] },
    { id: 'deals', kind: 'table', title: 'deals', status: 'done', fields: [
      { name: 'id', type: 'uuid', pk: true }, { name: 'account_id', type: 'uuid', fk: 'accounts.id' }, { name: 'owner_id', type: 'uuid', fk: 'users.id' }, { name: 'stage', type: 'deal_stage' }, { name: 'amount', type: 'numeric(12,2)' }, { name: 'closes_on', type: 'date' },
    ] },
    { id: 'activities', kind: 'table', title: 'activities', status: 'in-progress', fields: [
      { name: 'id', type: 'bigint', pk: true }, { name: 'deal_id', type: 'uuid', fk: 'deals.id' }, { name: 'contact_id', type: 'uuid', fk: 'contacts.id' }, { name: 'kind', type: 'text' }, { name: 'body', type: 'text', pii: true }, { name: 'at', type: 'timestamptz' },
    ] },
    { id: 'users', kind: 'table', title: 'users', fields: [
      { name: 'id', type: 'uuid', pk: true }, { name: 'email', type: 'citext', uk: true, pii: true }, { name: 'role', type: 'text' },
    ] },
  ],
  edges: [
    { from: 'contacts', to: 'accounts', cardinality: 'n:1', label: 'account_id' },
    { from: 'deals', to: 'accounts', cardinality: 'n:1', label: 'account_id' },
    { from: 'deals', to: 'users', cardinality: 'n:1', label: 'owner_id' },
    { from: 'accounts', to: 'users', cardinality: 'n:1', label: 'owner_id' },
    { from: 'activities', to: 'deals', cardinality: 'n:1', label: 'deal_id' },
    { from: 'activities', to: 'contacts', cardinality: 'n:1', label: 'contact_id' },
  ],
};

const code = {
  view: 'code', title: 'harness-web - code map',
  groups: [
    { id: 'src', kind: 'boundary', label: 'src', subtitle: '412 files', tone: 'blue' },
    { id: 'packages', kind: 'boundary', label: 'packages', subtitle: '96 files', tone: 'purple' },
    { id: 'apps', kind: 'boundary', label: 'apps', subtitle: '58 files', tone: 'teal' },
  ],
  nodes: [
    { id: 'src/core', kind: 'folder', title: 'core', tech: '61 files · 22.4k lines', files: 61, group: 'src' },
    { id: 'src/server', kind: 'folder', title: 'server', tech: '14 files · 6.1k lines', files: 14, group: 'src' },
    { id: 'src/tools', kind: 'folder', title: 'tools', tech: '48 files · 11.9k lines', files: 48, group: 'src' },
    { id: 'src/providers', kind: 'folder', title: 'providers', tech: '19 files · 5.2k lines', files: 19, group: 'src' },
    { id: 'src/util', kind: 'folder', title: 'util', tech: '22 files · 2.8k lines', files: 22, group: 'src' },
    { id: 'packages/ui', kind: 'folder', title: 'ui', tech: '52 files · 9.7k lines', files: 52, group: 'packages' },
    { id: 'packages/client', kind: 'folder', title: 'client', tech: '5 files · 1.0k lines', files: 5, group: 'packages' },
    { id: 'packages/plugin-ui', kind: 'folder', title: 'plugin-ui', tech: '6 files · 1.6k lines', files: 6, group: 'packages' },
    { id: 'apps/desktop', kind: 'folder', title: 'desktop', tech: '58 files · 8.3k lines', files: 58, group: 'apps' },
    { id: 'scripts', kind: 'folder', title: 'scripts', tech: '9 files · 0.9k lines', files: 9 },
    { id: 'bench', kind: 'folder', title: 'bench', tech: '3 files · 0.4k lines', files: 3 },
  ],
  edges: [
    { from: 'src/server', to: 'src/core', count: 64 }, { from: 'src/server', to: 'src/tools', count: 12 }, { from: 'src/core', to: 'src/tools', count: 41 },
    { from: 'src/core', to: 'src/providers', count: 23 }, { from: 'src/core', to: 'src/util', count: 37 }, { from: 'src/tools', to: 'src/util', count: 29 },
    { from: 'src/providers', to: 'src/util', count: 8 }, { from: 'src/core', to: 'packages/plugin-ui', count: 3 },
    { from: 'packages/ui', to: 'packages/plugin-ui', count: 14 }, { from: 'apps/desktop', to: 'packages/ui', count: 38 }, { from: 'apps/desktop', to: 'packages/client', count: 21 },
    { from: 'apps/desktop', to: 'packages/plugin-ui', count: 17 }, { from: 'src/server', to: 'packages/plugin-ui', count: 2 },
  ],
};

const flow = {
  view: 'flow', title: 'Checkout',
  nodes: [
    { id: 'shopper', kind: 'person', title: 'Shopper' },
    { id: 'shop', kind: 'web-app', title: 'Shop', tech: 'storefront' },
    { id: 'orders', kind: 'service', title: 'Orders', tech: 'order service' },
    { id: 'pay', kind: 'external-system', title: 'Payment provider', tech: 'Stripe', integrated: true },
    { id: 'db', kind: 'relational-db', title: 'Orders DB', tech: 'PostgreSQL' },
    { id: 'bus', kind: 'stream', title: 'Order events', tech: 'Kafka' },
    { id: 'mail', kind: 'worker', title: 'Mailer', tech: 'receipts' },
  ],
  edges: [
    { id: 'f1', from: 'shopper', to: 'shop', label: 'checkout' },
    { id: 'f2', from: 'shop', to: 'orders', label: 'place order' },
    { id: 'f3', from: 'orders', to: 'pay', label: 'authorise' },
    { id: 'f4', from: 'orders', to: 'db', label: 'save' },
    { id: 'f5', from: 'orders', to: 'bus', label: 'order.placed', async: true },
    { id: 'f6', from: 'bus', to: 'mail', label: 'consume', async: true },
  ],
  flows: [
    { id: 'happy', title: 'Happy path', steps: [
      { edge: 'f1', label: 'press Pay' }, { edge: 'f2', label: 'POST /orders' }, { edge: 'f3', label: 'authorise 49.90 EUR' },
      { from: 'pay', to: 'orders', label: 'authorised' }, { edge: 'f4', label: 'status = paid' }, { edge: 'f5', label: 'publish order.placed' }, { edge: 'f6', label: 'send the receipt' },
    ] },
    { id: 'declined', title: 'Card declined', steps: [{ edge: 'f1', label: 'press Pay' }, { edge: 'f2', label: 'POST /orders' }, { edge: 'f3', label: 'authorise' }, { from: 'pay', to: 'orders', label: 'declined' }, { from: 'orders', to: 'shop', label: '402: try another card' }] },
  ],
};

export const DIAGRAMS = { context: ctx, container, component, deployment, data, code, flow } as const;
export type DiagramFixture = keyof typeof DIAGRAMS;
export const json = (v: unknown) => JSON.stringify(v, null, 2);

/** The deployment after "add a cache in front of the database": a new node, the web app now reads through it. */
export const DEPLOYMENT_WITH_CACHE = {
  ...deployment,
  nodes: [...deployment.nodes, { id: 'cache', kind: 'cache', title: 'Cache', tech: 'Redis 7', group: 'data', status: 'planned', address: '10.42.29.5:6379' }],
  edges: [...deployment.edges.filter((e) => e.id !== 'e3'), { id: 'e3', from: 'web', to: 'cache', label: 'get / set' }, { id: 'e8', from: 'cache', to: 'db', label: 'on a miss' }],
  flows: [{ ...deployment.flows[0]!, steps: deployment.flows[0]!.steps.map((s) => (s.edge === 'e3' ? { from: 'web', to: 'db', label: s.label } : s)) }],
};

/** Hostile and broken specs: each must give a readable error (or draw safely), never markup. */
export const HOSTILE = {
  scriptTitle: { view: 'container', title: '<img src=x onerror="alert(1)">', nodes: [{ id: 'a', kind: 'service', title: '<script>alert("xss")</script>', tech: '"><svg onload=alert(2)>' }, { id: 'b', kind: 'web-app', title: 'B' }], edges: [{ from: 'a', to: 'b', label: '</text><script>alert(3)</script>' }] },
  unknownEdge: { view: 'container', nodes: [{ id: 'web', kind: 'web-app', title: 'Web' }, { id: 'api', kind: 'api', title: 'API' }], edges: [{ from: 'web', to: 'dbx', label: 'sql' }] },
  unknownGroup: { view: 'deployment', groups: [{ id: 'dmz', kind: 'zone', label: 'DMZ' }], nodes: [{ id: 'proxy', kind: 'reverse-proxy', title: 'Proxy', group: 'dmzz' }] },
  groupCycle: { view: 'deployment', groups: [{ id: 'a', kind: 'zone', label: 'A', parent: 'b' }, { id: 'b', kind: 'zone', label: 'B', parent: 'a' }], nodes: [{ id: 'n', kind: 'service', title: 'N', group: 'a' }] },
  duplicateIds: { view: 'container', nodes: [{ id: 'x', kind: 'service', title: 'X' }, { id: 'x', kind: 'api', title: 'X again' }] },
  protoId: { view: 'container', nodes: [{ id: '__proto__', kind: 'service', title: 'P' }] },
  badLinks: { view: 'container', nodes: [{ id: 'a', kind: 'service', title: 'A', links: [{ url: 'javascript:alert(1)' }, { file: '../../etc/passwd' }, { file: '/etc/shadow' }, { url: 'https://ok.example.com/x' }, { file: 'src/ok.ts' }] }] },
  badFlow: { view: 'flow', nodes: [{ id: 'a', kind: 'service', title: 'A' }, { id: 'b', kind: 'service', title: 'B' }], edges: [{ id: 'ab', from: 'a', to: 'b' }], flows: [{ id: 'f', title: 'F', steps: [{ edge: 'nope', label: 'x' }] }] },
  notJson: '{"view": "container", "nodes": [',
  noNodes: { view: 'container', nodes: [] },
  badView: { view: 'galaxy', nodes: [{ id: 'a', title: 'A' }] },
};

/** A large diagram: n nodes in groups, m edges, for the speed checks. */
export function bigDiagram(n = 300, m = 600): Record<string, unknown> {
  const kinds = ['service', 'api', 'relational-db', 'cache', 'queue', 'worker', 'web-app', 'storage'];
  const groups = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, kind: i % 3 === 0 ? 'zone' : 'boundary', label: `Group ${i}` }));
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: kinds[i % kinds.length], title: `Node ${i}`, tech: `tech ${i % 17}`, group: `g${i % 12}`, status: ['done', 'in-progress', 'failing', 'planned'][i % 4] }));
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const edges = Array.from({ length: m }, (_, i) => { const a = Math.floor(rnd() * n); let b = Math.floor(rnd() * n); if (b === a) b = (a + 1) % n; return { id: `e${i}`, from: `n${a}`, to: `n${b}`, ...(i % 5 === 0 ? { label: `call ${i}` } : {}), ...(i % 7 === 0 ? { async: true } : {}) }; });
  return { view: 'container', title: 'Big', groups, nodes, edges };
}
