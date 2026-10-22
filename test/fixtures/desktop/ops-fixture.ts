// Fixture monitoring for the plugins journey (scripted and live): a Prometheus that answers the
// inventory's queries (checkout fails 21% of requests, its SLO burns), the services' health URLs,
// and an operator inventory (storefront, checkout, payments, search, orders-db on db-1) using them.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export async function startOpsFixture(dir: string): Promise<{ prom: string; health: string; inventory: string; close: () => void }> {
  let inventory = '';

  function vector(v: number, metric: Record<string, string> = {}) { return { status: 'success', data: { resultType: 'vector', result: [{ metric, value: [Date.now() / 1000, String(v)] }] } }; }
  const prom = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const q = u.searchParams.get('query') ?? '';
    const kind = u.pathname.split('/').pop();
    let body: unknown = { status: 'success', data: { resultType: 'vector', result: [] } };
    if (kind === 'parse_query') { res.writeHead(404); res.end('404 page not found'); return; }
    if (q.includes('checkout_errors_total')) body = vector(0.012);
    else if (q.includes('payments_errors_total')) body = vector(0.0004);
    else if (q.includes('search_errors_total')) body = vector(0.0002);
    else if (q.includes('checkout_error_ratio')) body = kind === 'query_range' ? { status: 'success', data: { resultType: 'matrix', result: [{ metric: { job: 'checkout' }, values: Array.from({ length: 12 }, (_, i) => [Date.now() / 1000 - (11 - i) * 30, '0.21']) }] } } : vector(0.21, { job: 'checkout' });
    else if (/^up\b/.test(q)) body = { status: 'success', data: { resultType: 'vector', result: ['storefront', 'checkout', 'payments', 'search'].map((job) => ({ metric: { job, instance: `${job}:8080` }, value: [Date.now() / 1000, '1'] })) } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const health = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`ok ${req.url}`); });
  await Promise.all([new Promise<void>((r) => prom.listen(0, '127.0.0.1', r)), new Promise<void>((r) => health.listen(0, '127.0.0.1', r))]);
  const PROM = `http://127.0.0.1:${(prom.address() as { port: number }).port}`;
  const HEALTH = `http://127.0.0.1:${(health.address() as { port: number }).port}`;

  {
    fs.mkdirSync(dir, { recursive: true });
    const inv = path.join(dir, 'ops-inventory.yaml');
    const slo = (job: string, objective: number) => `      - name: availability\n        objective: ${objective}\n        window: 30d\n        errors: sum(rate(${job}_errors_total[{{window}}]))\n        total: sum(rate(${job}_requests_total[{{window}}]))`;
    fs.writeFileSync(inv, `monitoring:
    prometheus: ${PROM}
  environments: [prod]
  hosts:
    - name: db-1
      address: 10.0.0.5
      env: prod
      role: database
  services:
    - name: storefront
      env: prod
      owner: team-web
      health: ${HEALTH}/storefront
      depends_on: [checkout, search]
    - name: checkout
      env: prod
      owner: team-shop
      health: ${HEALTH}/checkout
      metrics_job: checkout
      depends_on: [payments, orders-db]
      slos:
  ${slo('checkout', 99.9)}
    - name: payments
      env: prod
      owner: team-payments
      health: ${HEALTH}/payments
      metrics_job: payments
      slos:
  ${slo('payments', 99.95)}
    - name: search
      env: prod
      owner: team-web
      health: ${HEALTH}/search
      slos:
  ${slo('search', 99.5)}
    - name: orders-db
      host: db-1
      env: prod
      owner: team-shop
  alerts:
    - name: CheckoutErrorRatio
      expr: checkout_error_ratio > 0.05
      severity: critical
      service: checkout
  `);
    inventory = inv;
  }
  return { prom: PROM, health: HEALTH, inventory, close: () => { prom.close(); health.close(); } };
}
