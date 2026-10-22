import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DataService } from '../src/data/service.ts';
import { applyOps, type Actor } from '../src/data/ops.ts';
import { compileDataset } from '../src/data/steps.ts';
import { decodeText, detectLog, flattenRecords, grokToRegex, parseLog, sniffDelimiter, xmlRows } from '../src/data/formats.ts';
import { writeXlsx } from '../src/data/xlsx.ts';
import { tempDir } from './helpers.ts';

// Sources beyond the basics: every log format parsed from a realistic sample into typed columns
// (and a web access log analysed end to end), CSV encodings and delimiters, nested JSON and NDJSON
// flattened (an array unnested), XML records, Excel named ranges and header rows found under a
// title, paginated APIs; a model joining an Excel sheet, a SQLite table and a JSON file (numbers
// equal to sums computed here); a composite model (a live table and an imported one); and the
// cleansing steps compiled to SQL.

const ME: Actor = { kind: 'person', label: 'person:test' };

const SAMPLES: Record<string, { text: string; columns: string[]; first: Record<string, unknown>; rows: number }> = {
  combined: {
    text: [
      '203.0.113.7 - alice [10/Oct/2024:13:55:36 +0200] "GET /api/orders?page=2 HTTP/1.1" 200 2326 "https://shop.example/cart" "Mozilla/5.0 (X11; Linux x86_64)" 0.042',
      '198.51.100.23 - - [10/Oct/2024:13:55:37 +0200] "POST /api/checkout HTTP/1.1" 502 157 "-" "curl/8.4.0" 1.250',
      '203.0.113.7 - - [10/Oct/2024:13:56:01 +0200] "GET /health HTTP/1.1" 200 2 "-" "kube-probe/1.29" 0.001',
    ].join('\n'),
    columns: ['line', 'time', 'host', 'user', 'method', 'path', 'query', 'protocol', 'status', 'bytes', 'referrer', 'user_agent', 'latency_ms'],
    first: { time: '2024-10-10 11:55:36.000', host: '203.0.113.7', user: 'alice', method: 'GET', path: '/api/orders', query: 'page=2', status: 200, bytes: 2326, latency_ms: 42 },
    rows: 3,
  },
  common: {
    text: '127.0.0.1 user-identifier frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326\n10.1.1.1 - - [10/Oct/2000:13:55:40 -0700] "GET /missing HTTP/1.0" 404 -',
    columns: ['time', 'host', 'ident', 'method', 'path', 'status', 'bytes'],
    first: { time: '2000-10-10 20:55:36.000', ident: 'user-identifier', user: 'frank', status: 200, bytes: 2326 },
    rows: 2,
  },
  syslog: {
    text: [
      '<34>Oct 11 22:14:15 mymachine su[230]: \'su root\' failed for lonvick on /dev/pts/8',
      '<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog 1234 ID47 [exampleSDID@32473 iut="3" eventSource="Application"] An application event log entry',
      '<13>Oct 11 22:15:00 mymachine cron: job done',
    ].join('\n'),
    columns: ['time', 'facility', 'level', 'host', 'app', 'pid', 'msgid', 'message'],
    first: { time: '2024-10-11 22:14:15.000', facility: 'auth', level: 'critical', host: 'mymachine', app: 'su', pid: 230 },
    rows: 3,
  },
  jsonl: {
    text: '{"ts":"2024-05-01T10:00:00Z","level":"INFO","msg":"started","http":{"status":200,"path":"/a"}}\n{"ts":"2024-05-01T10:00:02.5Z","level":"warn","msg":"slow","http":{"status":200,"path":"/b"},"duration_ms":812}',
    columns: ['time', 'level', 'message', 'http_status', 'http_path', 'duration_ms'],
    first: { time: '2024-05-01 10:00:00.000', level: 'info', message: 'started', http_status: 200, http_path: '/a' },
    rows: 2,
  },
  logfmt: {
    text: 'time=2024-05-01T10:00:00Z level=error msg="db timeout" service=api latency=1.2s\ntime=2024-05-01T10:00:01Z level=info msg=ok service=web',
    columns: ['time', 'level', 'message', 'service', 'latency'],
    first: { time: '2024-05-01 10:00:00.000', level: 'error', message: 'db timeout', service: 'api' },
    rows: 2,
  },
  cef: {
    text: 'Sep 19 08:26:10 host CEF:0|Security|threatmanager|1.0|100|worm successfully stopped|10|src=10.0.0.1 dst=2.1.2.2 spt=1232 dpt=443 act=blocked msg=Detected a threat. No action needed.',
    columns: ['vendor', 'product', 'signature_id', 'name', 'cef_severity', 'src_ip', 'dst_ip', 'src_port', 'dst_port', 'act', 'msg'],
    first: { vendor: 'Security', product: 'threatmanager', cef_severity: 10, src_ip: '10.0.0.1', dst_port: 443, act: 'blocked', msg: 'Detected a threat. No action needed.' },
    rows: 1,
  },
  leef: {
    text: 'LEEF:2.0|Lancope|StealthWatch|1.0|41|^|src=10.0.1.8^dst=10.0.0.5^sev=5^devTime=2024-05-01 10:00:00^usrName=joe',
    columns: ['vendor', 'product', 'event_id', 'src_ip', 'dst_ip', 'sev', 'usrName', 'time'],
    first: { vendor: 'Lancope', event_id: '41', src_ip: '10.0.1.8', usrName: 'joe', time: '2024-05-01 10:00:00.000' },
    rows: 1,
  },
  w3c: {
    text: '#Software: Microsoft Internet Information Services 10.0\n#Version: 1.0\n#Date: 2024-05-01 00:00:00\n#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken\n2024-05-01 00:00:01 10.0.0.4 GET /default.aspx - 443 - 192.0.2.10 Mozilla/5.0+(Windows+NT+10.0) - 200 0 0 15\n2024-05-01 00:00:02 10.0.0.4 POST /api/login - 443 bob 192.0.2.11 curl/8 - 401 1 0 3',
    columns: ['time', 'server_ip', 'method', 'path', 'query', 'port', 'user', 'client_ip', 'user_agent', 'status', 'latency_ms'],
    first: { time: '2024-05-01 00:00:01.000', method: 'GET', path: '/default.aspx', query: null, status: 200, latency_ms: 15, user_agent: 'Mozilla/5.0 (Windows NT 10.0)' },
    rows: 2,
  },
  cloudtrail: {
    text: JSON.stringify({ Records: [{ eventVersion: '1.08', eventTime: '2024-05-01T12:00:00Z', eventSource: 's3.amazonaws.com', eventName: 'GetObject', awsRegion: 'eu-west-1', sourceIPAddress: '198.51.100.1', userIdentity: { type: 'IAMUser', userName: 'deploy' } }, { eventTime: '2024-05-01T12:00:05Z', eventSource: 'iam.amazonaws.com', eventName: 'CreateUser', awsRegion: 'us-east-1', sourceIPAddress: '198.51.100.2', errorCode: 'AccessDenied', userIdentity: { type: 'AssumedRole' } }] }),
    columns: ['time', 'eventSource', 'eventName', 'awsRegion', 'sourceIPAddress', 'userIdentity_type', 'userIdentity_userName', 'errorCode', 'status'],
    first: { time: '2024-05-01 12:00:00.000', eventName: 'GetObject', userIdentity_userName: 'deploy', status: 'ok' },
    rows: 2,
  },
  alb: {
    text: 'https 2024-05-01T23:39:43.945958Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 10.0.0.1:80 0.086 0.048 0.037 200 200 0 57 "GET https://www.example.com:443/api/items?id=3 HTTP/1.1" "curl/7.46.0" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337281-1d84f3d73c47ec4e58577259" "www.example.com" "arn:aws:acm:us-east-2:123456789012:certificate/12345678-1234-1234-1234-123456789012" 1 2024-05-01T23:39:43.945958Z "forward" "-" "-" "10.0.0.1:80" "200" "-" "-"',
    columns: ['type', 'time', 'client_ip', 'client_port', 'target_ip', 'latency_ms', 'status', 'target_status', 'sent_bytes', 'method', 'host', 'path', 'query', 'user_agent'],
    first: { type: 'https', time: '2024-05-01 23:39:43.945', client_ip: '192.168.131.39', client_port: 2817, status: 200, method: 'GET', host: 'www.example.com', path: '/api/items', query: 'id=3', user_agent: 'curl/7.46.0' },
    rows: 1,
  },
  elb: {
    text: '2024-05-01T23:39:43.945958Z my-loadbalancer 192.168.131.39:2817 10.0.0.1:80 0.000073 0.001048 0.000057 200 200 0 29 "GET http://www.example.com:80/ HTTP/1.1" "curl/7.38.0" - -',
    columns: ['time', 'elb', 'client_ip', 'target_ip', 'latency_ms', 'status', 'path'],
    first: { elb: 'my-loadbalancer', client_ip: '192.168.131.39', status: 200, path: '/' },
    rows: 1,
  },
  docker: {
    text: '{"log":"2024-05-01 10:00:00 INFO server listening on :8080\\n","stream":"stdout","time":"2024-05-01T10:00:00.123456789Z"}\n{"log":"ERROR connection refused\\n","stream":"stderr","time":"2024-05-01T10:00:05Z"}',
    columns: ['time', 'stream', 'level', 'message'],
    first: { time: '2024-05-01 10:00:00.123', stream: 'stdout', message: '2024-05-01 10:00:00 INFO server listening on :8080' },
    rows: 2,
  },
  cri: {
    text: '2024-05-01T10:00:00.000000000Z stdout F {"level":"info","msg":"ready"}\n2024-05-01T10:00:01.000000000Z stderr P partial line one \n2024-05-01T10:00:01.000000000Z stderr F and the rest level=error',
    columns: ['time', 'stream', 'level', 'message'],
    first: { time: '2024-05-01 10:00:00.000', stream: 'stdout', level: 'info' },
    rows: 2,
  },
  'winevent-xml': {
    text: '<Events><Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Name="Microsoft-Windows-Security-Auditing" Guid="{54849625-5478-4994-a5ba-3e3b0328c30d}"/><EventID>4625</EventID><Level>0</Level><Task>12544</Task><Keywords>0x8010000000000000</Keywords><TimeCreated SystemTime="2024-05-01T10:00:00.1234567Z"/><EventRecordID>1001</EventRecordID><Channel>Security</Channel><Computer>DC01.corp.local</Computer><Security/></System><EventData><Data Name="TargetUserName">admin</Data><Data Name="IpAddress">203.0.113.9</Data><Data Name="LogonType">3</Data></EventData></Event><Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Name="Service Control Manager"/><EventID>7036</EventID><Level>4</Level><TimeCreated SystemTime="2024-05-01T10:01:00Z"/><EventRecordID>1002</EventRecordID><Channel>System</Channel><Computer>DC01.corp.local</Computer></System><EventData><Data Name="param1">Windows Update</Data></EventData></Event></Events>',
    columns: ['time', 'event_id', 'level', 'provider', 'channel', 'computer', 'record_id', 'data_TargetUserName', 'data_IpAddress'],
    first: { time: '2024-05-01 10:00:00.123', event_id: 4625, provider: 'Microsoft-Windows-Security-Auditing', channel: 'Security', computer: 'DC01.corp.local', record_id: 1001, data_TargetUserName: 'admin' },
    rows: 2,
  },
  'winevent-csv': {
    text: 'Level,Date and Time,Source,Event ID,Task Category\nError,5/1/2024 10:00:00 AM,Service Control Manager,7000,None,"The service failed to start\r\ndue to the following error"\nInformation,5/1/2024 10:05:00 AM,Microsoft-Windows-Kernel-General,16,None,The access history was cleared.',
    columns: ['time', 'level', 'provider', 'event_id', 'task', 'message'],
    first: { level: 'error', provider: 'Service Control Manager', event_id: 7000 },
    rows: 2,
  },
};

test('every log format: parsed from a realistic sample into typed columns, the format detected', () => {
  for (const [format, s] of Object.entries(SAMPLES)) {
    const p = parseLog(s.text, { format: format as 'combined', year: 2024 });
    assert.equal(p.rows.length, s.rows, `${format}: rows (${p.note})`);
    for (const c of s.columns) assert.ok(p.columns.includes(c), `${format}: column ${c} in ${p.columns.join(', ')}`);
    const first = Object.fromEntries(p.columns.map((c, i) => [c, p.rows[0]![i]]));
    for (const [k, v] of Object.entries(s.first)) assert.deepEqual(first[k], v, `${format}: ${k}`);
    if (p.columns.includes('time')) assert.equal(p.types.time, 'TIMESTAMP');
    if (format !== 'winevent-csv' && format !== 'leef' && format !== 'elb') assert.equal(detectLog(s.text), format === 'common' ? 'common' : format, `${format} detected`);
  }
  // The CRI log joined its partial line; the docker log found the level of the second line.
  const cri = parseLog(SAMPLES.cri!.text, { format: 'cri' });
  assert.equal(cri.rows[1]![cri.columns.indexOf('message')], 'partial line one and the rest level=error');
  assert.equal(cri.rows[1]![cri.columns.indexOf('level')], 'error');
  // A person's own pattern: a regular expression with named groups, or grok.
  const app = '2024-05-01 10:00:00,123 [worker-3] ERROR com.shop.Pay - charge failed id=77 ms=1200\n2024-05-01 10:00:01,002 [worker-1] INFO com.shop.Pay - charge ok id=78 ms=95';
  const g = parseLog(app, { format: 'grok', pattern: '%{TIMESTAMP_ISO8601:time},%{INT:ms_part} \\[%{NOTSPACE:thread}\\] %{LOGLEVEL:level} %{NOTSPACE:logger} - %{DATA:message} id=%{INT:id:int} ms=%{NUMBER:latency_ms:float}' });
  assert.deepEqual(g.rows.map((r) => [r[g.columns.indexOf('level')], r[g.columns.indexOf('id')], r[g.columns.indexOf('latency_ms')]]), [['error', 77, 1200], ['info', 78, 95]]);
  const rx = parseLog(app, { format: 'regex', pattern: '^(?<time>\\S+ \\S+?),\\d+ \\[(?<thread>[^\\]]+)\\] (?<level>\\w+)' });
  assert.equal(rx.rows[0]![rx.columns.indexOf('thread')], 'worker-3');
  assert.throws(() => grokToRegex('%{NOPE:x}'), /unknown pattern/);
  // Most lines not in the format: refused with an example, never invented.
  assert.throws(() => parseLog('hello\nworld\n', { format: 'combined' }), /2 of 2 lines are not combined, e.g. "hello"/);
});

test('a web access log end to end: requests, errors, p95 latency by path and top client addresses equal the log counted here', async () => {
  const data = await tempDir();
  const files = path.join(data, 'files'); await fs.mkdir(files);
  const paths = ['/api/orders', '/api/checkout', '/health', '/static/app.js'];
  const lines: string[] = []; const truth: Array<{ ip: string; path: string; status: number; ms: number }> = [];
  for (let i = 0; i < 400; i++) {
    const ip = `203.0.113.${(i * 7) % 23}`; const p = paths[(i * 5) % 4]!; const status = i % 17 === 0 ? 503 : i % 11 === 0 ? 404 : 200; const ms = ((i * 37) % 900) + 1;
    truth.push({ ip, path: p, status, ms });
    lines.push(`${ip} - - [01/May/2024:10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} +0000] "GET ${p} HTTP/1.1" ${status} ${100 + i} "-" "probe/1.0" ${(ms / 1000).toFixed(3)}`);
  }
  await fs.writeFile(path.join(files, 'access.log'), `${lines.join('\n')}\n`);
  const svc = new DataService({ dataDir: data, rootsFor: () => [files] });
  const home = svc.home(undefined);
  const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
  await assert.rejects(ops([{ op: 'add_source', source: { name: 'x', type: 'file', path: path.join(files, 'access.log'), log: { format: 'regex' } } }]), /needs log.pattern/);
  await ops([
    { op: 'add_source', source: { id: 'src-web', name: 'Web log', type: 'file', path: path.join(files, 'access.log') } },
    { op: 'define', dataset: { name: 'web', source: 'src-web' } },
    { op: 'add_model', model: { id: 'web', name: 'Web' } },
    { op: 'set_table', model: 'web', table: { name: 'web', dataset: 'web' } },
    { op: 'set_measure', model: 'web', measure: { name: 'Requests', expr: 'count(*)', table: 'web' } },
    { op: 'set_measure', model: 'web', measure: { name: 'Errors', expr: 'count(*)', table: 'web', filter: 'web.status >= 500' } },
    { op: 'set_measure', model: 'web', measure: { name: 'p95 latency', expr: 'quantile_cont(web.latency_ms, 0.95)' } },
  ]);
  assert.match((await ops([{ op: 'test_source', id: 'src-web' }])).results[0]!.message, /combined: 400 rows/);
  const types = Object.fromEntries((await svc.sql(home, 'SELECT * FROM web LIMIT 1')).columns.map((c) => [c.name, c.type]));
  assert.equal(types.time, 'TIMESTAMP'); assert.equal(types.status, 'BIGINT'); assert.equal(types.latency_ms, 'DOUBLE');
  const byPath = await svc.query(home, { model: 'web', dims: ['web.path'], measures: ['Requests', 'Errors', 'p95 latency'], sort: [{ by: 'web.path' }] });
  for (const row of byPath.rows) {
    const t = truth.filter((x) => x.path === row[0]);
    const ms = t.map((x) => x.ms).sort((a, b) => a - b);
    const pos = 0.95 * (ms.length - 1); const lo = Math.floor(pos);
    const p95 = ms[lo]! + (ms[Math.min(lo + 1, ms.length - 1)]! - ms[lo]!) * (pos - lo);
    assert.deepEqual([row[1], row[2]], [t.length, t.filter((x) => x.status >= 500).length], `${row[0]} requests and errors`);
    assert.ok(Math.abs(Number(row[3]) - p95) < 1e-6, `${row[0]} p95 ${row[3]} != ${p95}`);
  }
  const top = await svc.query(home, { model: 'web', dims: ['web.host'], measures: ['Requests'], sort: [{ by: 'Requests', desc: true }, { by: 'web.host' }], limit: 3 });
  const counts = new Map<string, number>(); for (const x of truth) counts.set(x.ip, (counts.get(x.ip) ?? 0) + 1);
  assert.deepEqual(top.rows, [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([ip, n]) => [ip, n]));
});

test('files: CSV encodings and delimiters detected, nested JSON and NDJSON flattened (an array unnested), XML records, Excel named ranges and a header under a title', async () => {
  const data = await tempDir();
  const files = path.join(data, 'files'); await fs.mkdir(files);
  // Windows-1252 with semicolons (a European export), and UTF-16 with its mark.
  await fs.writeFile(path.join(files, 'eu.csv'), Buffer.from('ville;montant\nZürich;10,5\nSão Paulo;20\nCôte;3\n', 'latin1'));
  await fs.writeFile(path.join(files, 'u16.csv'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('city,n\nKöln,1\nMálaga,2\n', 'utf16le')]));
  assert.equal(decodeText(await fs.readFile(path.join(files, 'eu.csv'))).encoding, 'windows-1252');
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n"x;y";2;3\n'), ';');
  await fs.writeFile(path.join(files, 'orders.json'), JSON.stringify({ data: [
    { id: 1, customer: { name: 'Ada', address: { city: 'Paris' } }, lines: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] },
    { id: 2, customer: { name: 'Bo', address: { city: 'Lyon' } }, lines: [{ sku: 'A', qty: 5 }] },
  ] }));
  await fs.writeFile(path.join(files, 'events.ndjson'), '{"id":1,"user":{"id":"u1","plan":"pro"},"ok":true}\n{"id":2,"user":{"id":"u2","plan":"free"},"ok":false}\n');
  await fs.writeFile(path.join(files, 'catalog.xml'), '<?xml version="1.0"?><catalog><!-- items --><book id="b1" lang="en"><title>Dune</title><price currency="EUR">9.50</price></book><book id="b2"><title>Solaris &amp; more</title><price currency="EUR">7</price></book></catalog>');
  await fs.writeFile(path.join(files, 'report.xlsx'), writeXlsx([
    { name: 'Summary', columns: ['Quarterly sales report'], rows: [['Prepared by finance'], [], ['region', 'quarter', 'amount'], ['EU', 'Q1', 100], ['US', 'Q1', 80], ['EU', 'Q2', 120]] },
    { name: 'Lookup', columns: ['note'], rows: [['ignore'], [], [null, 'code', 'label'], [null, 'EU', 'Europe'], [null, 'US', 'United States']] },
  ], [{ name: 'Regions', sheet: 'Lookup', range: 'B4:C6' }]));
  const svc = new DataService({ dataDir: data, rootsFor: () => [files] });
  const home = svc.home(undefined);
  const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
  const src = (id: string, file: string, extra: Record<string, unknown> = {}) => ({ op: 'add_source', source: { id, name: id, type: 'file', path: path.join(files, file), ...extra } });
  await ops([
    src('s-eu', 'eu.csv'), src('s-u16', 'u16.csv'), src('s-json', 'orders.json', { rowsPath: 'data' }), src('s-lines', 'orders.json', { rowsPath: 'data', unnest: 'lines' }), src('s-nd', 'events.ndjson'), src('s-xml', 'catalog.xml'), src('s-x', 'report.xlsx'),
    { op: 'define', dataset: { name: 'eu', source: 's-eu', steps: [{ op: 'replace', column: 'montant', find: '10,5', with: '10.5' }, { op: 'type', column: 'montant', to: 'double' }] } },
    { op: 'define', dataset: { name: 'u16', source: 's-u16' } },
    { op: 'define', dataset: { name: 'orders', source: 's-json' } },
    { op: 'define', dataset: { name: 'lines', source: 's-lines' } },
    { op: 'define', dataset: { name: 'events', source: 's-nd' } },
    { op: 'define', dataset: { name: 'books', source: 's-xml', from: 'book' } },
    { op: 'define', dataset: { name: 'summary', source: 's-x', from: 'Summary' } },
    { op: 'define', dataset: { name: 'regions', source: 's-x', from: 'Regions' } },
  ]);
  const q = async (sql: string) => (await svc.sql(home, sql)).rows;
  assert.deepEqual(await q('SELECT ville, montant FROM eu ORDER BY ville'), [['Côte', 3], ['São Paulo', 20], ['Zürich', 10.5]]);
  assert.deepEqual(await q('SELECT city, n FROM u16 ORDER BY n'), [['Köln', 1], ['Málaga', 2]]);
  assert.deepEqual(await q('SELECT id, customer_name, customer_address_city FROM orders ORDER BY id'), [[1, 'Ada', 'Paris'], [2, 'Bo', 'Lyon']]);
  assert.deepEqual(await q('SELECT lines_sku, sum(lines_qty) FROM lines GROUP BY 1 ORDER BY 1'), [['A', 7], ['B', 1]]);
  assert.deepEqual(await q('SELECT user_plan, count(*) FROM events GROUP BY 1 ORDER BY 1'), [['free', 1], ['pro', 1]]);
  assert.deepEqual(await q('SELECT id, title, price, price_currency FROM books ORDER BY id'), [['b1', 'Dune', '9.50', 'EUR'], ['b2', 'Solaris & more', '7', 'EUR']]);
  assert.deepEqual(await q('SELECT region, quarter, amount FROM summary ORDER BY amount'), [['US', 'Q1', 80], ['EU', 'Q1', 100], ['EU', 'Q2', 120]], 'the header found under the title and the note');
  assert.deepEqual(await q('SELECT code, label FROM regions ORDER BY code'), [['EU', 'Europe'], ['US', 'United States']], 'a named range');
  assert.match((await ops([{ op: 'test_source', id: 's-x' }])).results[0]!.message, /1 named range/);
  // Pure helpers.
  assert.deepEqual(flattenRecords([{ a: { b: 1, c: [1, 2] } }]), { columns: ['a_b', 'a_c'], rows: [[1, [1, 2]]] });
  assert.deepEqual(xmlRows('<r><x n="1"><v>a</v></x><x n="2"><v>b</v></x></r>').rows, [['1', 'a'], ['2', 'b']]);
});

test('a paginated API (pages, offsets, a cursor, the Link header) is read to its last page', async () => {
  const items = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, v: (i + 1) * 10 }));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const size = Number(u.searchParams.get('per_page') ?? u.searchParams.get('limit') ?? 10);
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/pages') { const p = Number(u.searchParams.get('page') ?? 1); res.end(JSON.stringify({ items: items.slice((p - 1) * size, p * size) })); return; }
    if (u.pathname === '/offset') { const o = Number(u.searchParams.get('offset') ?? 0); res.end(JSON.stringify(items.slice(o, o + size))); return; }
    if (u.pathname === '/cursor') { const c = Number(u.searchParams.get('cursor') ?? 0); const page = items.slice(c, c + 10); res.end(JSON.stringify({ data: page, meta: { next: c + 10 < items.length ? c + 10 : null } })); return; }
    if (u.pathname === '/link') { const p = Number(u.searchParams.get('p') ?? 1); if (p < 3) res.setHeader('link', `</link?p=${p + 1}>; rel="next"`); res.end(JSON.stringify(items.slice((p - 1) * 10, p * 10))); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const prev = process.env.HARNESS_DATA_PRIVATE_HOSTS; process.env.HARNESS_DATA_PRIVATE_HOSTS = host;
  try {
    const svc = new DataService({ dataDir: await tempDir() });
    const home = svc.home(undefined);
    const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
    await ops([
      { op: 'add_source', source: { id: 'a', name: 'pages', type: 'http', url: `http://${host}/pages`, rowsPath: 'items', paginate: { kind: 'page', size: 10 } } },
      { op: 'add_source', source: { id: 'b', name: 'offset', type: 'http', url: `http://${host}/offset`, paginate: { kind: 'offset', size: 5 } } },
      { op: 'add_source', source: { id: 'c', name: 'cursor', type: 'http', url: `http://${host}/cursor`, rowsPath: 'data', paginate: { kind: 'cursor', cursorPath: 'meta.next' } } },
      { op: 'add_source', source: { id: 'd', name: 'link', type: 'http', url: `http://${host}/link`, paginate: { kind: 'link' } } },
      { op: 'define', dataset: { name: 'pa', source: 'a' } }, { op: 'define', dataset: { name: 'pb', source: 'b' } }, { op: 'define', dataset: { name: 'pc', source: 'c' } }, { op: 'define', dataset: { name: 'pd', source: 'd' } },
    ]);
    for (const t of ['pa', 'pb', 'pc', 'pd']) assert.deepEqual((await svc.sql(home, `SELECT count(*), sum(v), count(DISTINCT id) FROM ${t}`)).rows[0], [23, 2760, 23], t);
  } finally { if (prev === undefined) delete process.env.HARNESS_DATA_PRIVATE_HOSTS; else process.env.HARNESS_DATA_PRIVATE_HOSTS = prev; server.close(); }
});

test('one model over three sources (an Excel sheet, a SQLite table, a JSON file): relationships across them, numbers equal to sums computed here; a composite model keeps a live table live and an imported one until refreshed', async () => {
  const data = await tempDir();
  const files = path.join(data, 'files'); await fs.mkdir(files);
  const products = [['P1', 'Tea', 4.5], ['P2', 'Coffee', 7.25], ['P3', 'Cocoa', 3]] as const;
  await fs.writeFile(path.join(files, 'products.xlsx'), writeXlsx([{ name: 'Products', columns: ['Price list 2024'], rows: [[], ['sku', 'name', 'price'], ...products.map((p) => [...p])] }]));
  const customers = [{ id: 'c1', profile: { name: 'Ada', country: 'France' } }, { id: 'c2', profile: { name: 'Bo', country: 'Canada' } }, { id: 'c3', profile: { name: 'Cy', country: 'France' } }];
  await fs.writeFile(path.join(files, 'customers.json'), JSON.stringify(customers));
  const orders: Array<[number, string, string, number]> = [];
  for (let i = 1; i <= 60; i++) orders.push([i, `c${(i % 3) + 1}`, `P${(i % 3) + 1}`, (i % 4) + 1]);
  const db = new DatabaseSync(path.join(files, 'shop.sqlite'));
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, sku TEXT, qty INTEGER)');
  const ins = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
  for (const o of orders) ins.run(...o);
  db.close();
  const svc = new DataService({ dataDir: data, rootsFor: () => [files] });
  const home = svc.home(undefined);
  const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
  await ops([
    { op: 'add_source', source: { id: 'x', name: 'Price list', type: 'file', path: path.join(files, 'products.xlsx') } },
    { op: 'add_source', source: { id: 'q', name: 'Shop DB', type: 'sqlite', path: path.join(files, 'shop.sqlite') } },
    { op: 'add_source', source: { id: 'j', name: 'Customers', type: 'file', path: path.join(files, 'customers.json') } },
    { op: 'define', dataset: { name: 'products', source: 'x', from: 'Products' } },
    { op: 'define', dataset: { name: 'orders', source: 'q', from: 'orders' } },
    { op: 'define', dataset: { name: 'customers', source: 'j' } },
    { op: 'add_model', model: { id: 'shop', name: 'Shop' } },
    { op: 'set_table', model: 'shop', table: { name: 'orders', dataset: 'orders' } },
    { op: 'set_table', model: 'shop', table: { name: 'products', dataset: 'products' } },
    { op: 'set_table', model: 'shop', table: { name: 'customers', dataset: 'customers' } },
    { op: 'set_relationship', model: 'shop', relationship: { from: 'orders.sku', to: 'products.sku', cardinality: 'n:1', crossFilter: 'single' } },
    { op: 'set_relationship', model: 'shop', relationship: { from: 'orders.customer', to: 'customers.id', cardinality: 'n:1', crossFilter: 'both' } },
    { op: 'set_measure', model: 'shop', measure: { name: 'Sales', expr: 'sum(orders.qty * products.price)' } },
    { op: 'set_measure', model: 'shop', measure: { name: 'Customers', expr: 'count(DISTINCT customers.id)' } },
  ]);
  const price = new Map<string, number>(products.map((p) => [p[0], p[2]]));
  const country = new Map(customers.map((c) => [c.id, c.profile.country]));
  const truthBy = (rows: typeof orders) => { const m = new Map<string, number>(); for (const [, c, s, q] of rows) m.set(country.get(c)!, Math.round(((m.get(country.get(c)!) ?? 0) + q * price.get(s)!) * 100) / 100); return [...m].sort((a, b) => a[0].localeCompare(b[0])); };
  const byCountry = async () => (await svc.query(home, { model: 'shop', dims: ['customers.profile_country'], measures: ['Sales'], sort: [{ by: 'customers.profile_country' }] })).rows.map((r) => [r[0], Math.round(Number(r[1]) * 100) / 100]);
  assert.deepEqual(await byCountry(), truthBy(orders), 'sales by the JSON customers\' country, priced from Excel, counted from SQLite');
  // Both-way cross-filter: customers who bought Coffee.
  const coffee = await svc.query(home, { model: 'shop', measures: ['Customers'], filters: [{ field: 'products.name', op: 'eq', value: 'Coffee' }] });
  assert.equal(coffee.rows[0]![0], new Set(orders.filter((o) => o[2] === 'P2').map((o) => o[1])).size);
  const cat = (await home.catalog()).spec;
  assert.deepEqual(cat.datasets.map((d) => cat.sources.find((s) => s.id === d.source)!.type), ['file', 'sqlite', 'file']);

  // Composite: orders live (read at query time), products imported.
  await ops([{ op: 'set_storage', dataset: 'orders', storage: 'live', ttl: 0 }]);
  await assert.rejects(ops([{ op: 'set_storage', dataset: 'orders', storage: 'cache' }]), /import .* or live/);
  const db2 = new DatabaseSync(path.join(files, 'shop.sqlite'));
  db2.exec("INSERT INTO orders VALUES (61, 'c2', 'P1', 10)");
  db2.close();
  orders.push([61, 'c2', 'P1', 10]);
  assert.deepEqual(await byCountry(), truthBy(orders), 'the live table shows the new order at once');
  const live = await svc.query(home, { model: 'shop', measures: ['Sales'] });
  assert.ok(live.lineage.datasets.some((d) => d.name === 'orders' && d.live), 'lineage marks the live table');
  // The imported price list keeps its extract until it is refreshed.
  await fs.writeFile(path.join(files, 'products.xlsx'), writeXlsx([{ name: 'Products', columns: ['Price list 2024'], rows: [[], ['sku', 'name', 'price'], ['P1', 'Tea', 100], ['P2', 'Coffee', 7.25], ['P3', 'Cocoa', 3]] }]));
  assert.deepEqual(await byCountry(), truthBy(orders), 'an imported table does not change before its refresh');
  await ops([{ op: 'refresh', dataset: 'products' }]);
  price.set('P1', 100);
  assert.deepEqual(await byCountry(), truthBy(orders), 'after the refresh, the new price');
});

test('cleansing steps compile to the SQL they mean and clean the rows', async () => {
  const sql = compileDataset({ id: 'd', name: 'd', steps: [
    { op: 'trim', columns: ['name'] },
    { op: 'case', columns: ['name'], to: 'title' },
    { op: 'nulls', columns: ['city'], action: 'fill', value: 'unknown' },
    { op: 'nulls', columns: ['amount'], action: 'drop' },
    { op: 'parse_date', column: 'day', formats: ['%d/%m/%Y', '%Y.%m.%d'] },
    { op: 'outliers', column: 'amount', method: 'iqr', k: 1.5 },
    { op: 'dedupe', columns: ['id'] },
  ] }, 'src');
  for (const frag of [
    `NULLIF(trim(CAST("name" AS VARCHAR)), '') AS "name"`,
    `upper(w[1]) || w[2:]`,
    `coalesce("city", 'unknown') AS "city"`,
    `WHERE "amount" IS NOT NULL`,
    `coalesce(try_strptime(CAST("day" AS VARCHAR), '%d/%m/%Y'), try_strptime(CAST("day" AS VARCHAR), '%Y.%m.%d'), TRY_CAST(CAST("day" AS VARCHAR) AS TIMESTAMP))`,
    `quantile_cont(CAST("amount" AS DOUBLE), 0.25) OVER ()`,
    `AS "amount_outlier"`,
    `QUALIFY row_number() OVER (PARTITION BY "id" ORDER BY __rn) = 1`,
  ]) assert.ok(sql.includes(frag), `the SQL has ${frag}\n${sql}`);
  // And on real rows.
  const data = await tempDir();
  const files = path.join(data, 'files'); await fs.mkdir(files);
  await fs.writeFile(path.join(files, 'dirty.csv'), 'id,name,city,amount,day\n1,  ada lovelace ,Paris,10,01/02/2024\n1,  ada lovelace ,Paris,10,01/02/2024\n2,BO,,12,2024.03.05\n3,cy,Lyon,,2024-04-01\n4,dee,Nice,11,2024-04-02\n5,eve,Nice,13,2024-04-03\n6,fay,Nice,9,2024-04-04\n7,gil,Nice,500,2024-04-05\n');
  const svc = new DataService({ dataDir: data, rootsFor: () => [files] });
  const home = svc.home(undefined);
  const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
  await assert.rejects(ops([{ op: 'add_source', source: { id: 's', name: 's', type: 'file', path: path.join(files, 'dirty.csv') } }, { op: 'define', dataset: { name: 'bad', source: 's', steps: [{ op: 'case', columns: ['name'], to: 'shout' }] } }]), /upper, lower or title/);
  await ops([{ op: 'add_source', source: { id: 's', name: 's', type: 'file', path: path.join(files, 'dirty.csv') } }, { op: 'define', dataset: { name: 'clean', source: 's', steps: [
    { op: 'type', column: 'day', to: 'text' }, { op: 'trim', columns: ['name'] }, { op: 'case', columns: ['name'], to: 'title' }, { op: 'nulls', columns: ['city'], action: 'fill', value: 'unknown' }, { op: 'nulls', columns: ['amount'], action: 'drop' },
    { op: 'parse_date', column: 'day', formats: ['%d/%m/%Y', '%Y.%m.%d'] }, { op: 'outliers', column: 'amount' }, { op: 'dedupe', columns: ['id'] },
  ] } }]);
  assert.deepEqual((await svc.sql(home, 'SELECT id, name, city, day, amount_outlier FROM clean ORDER BY id')).rows, [
    [1, 'Ada Lovelace', 'Paris', '2024-02-01', false], [2, 'Bo', 'unknown', '2024-03-05', false], [4, 'Dee', 'Nice', '2024-04-02', false], [5, 'Eve', 'Nice', '2024-04-03', false], [6, 'Fay', 'Nice', '2024-04-04', false], [7, 'Gil', 'Nice', '2024-04-05', true],
  ]);
});
