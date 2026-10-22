import type { LogFormat } from '../../packages/plugin-ui/src/bi.ts';
import { DataError } from './engine.ts';

// Text formats read without a dependency: the encoding of a text file, a CSV's delimiter, nested
// JSON flattened into columns (and an array turned into rows), XML records, and logs parsed into
// typed columns (time, level, host, status, latency_ms, path, ...) for analytics.

export type ColType = 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP' | 'VARCHAR' | 'DECIMAL(38,10)';
export interface Parsed { columns: string[]; rows: unknown[][]; types: Record<string, ColType>; note?: string }

// ---------------- encodings and delimiters ----------------

/** Text of a file: UTF-8 (with or without its mark), UTF-16 by its mark, else Windows-1252 when the bytes are not UTF-8. */
export function decodeText(buf: Buffer, encoding?: string): { text: string; encoding: string } {
  if (encoding) {
    const e = encoding.toLowerCase().replace(/[^a-z0-9-]/g, '');
    try { return { text: new TextDecoder(e === 'latin1' ? 'windows-1252' : e).decode(buf), encoding: e }; } catch { throw new DataError(`unknown encoding ${encoding}`); }
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; } catch { return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' }; }
}

/** The delimiter of delimited text: the candidate that splits the first lines into the same number (> 1) of fields. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ','; let score = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => splitDelimited(l, d).length);
    if (!counts.length || counts[0]! < 2) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const s = same * 100 + counts[0]!;
    if (s > score) { score = s; best = d; }
  }
  return best;
}
function splitDelimited(line: string, d: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------- nested JSON ----------------

/**
 * Objects to flat rows: nested objects become columns joined with "_" (address.city -> address_city),
 * arrays stay as JSON text unless `unnest` names one (a dotted path), whose items become rows (an
 * item that is an object adds its fields, prefixed with the array's name).
 */
export function flattenRecords(items: unknown[], o: { unnest?: string; depth?: number } = {}): { columns: string[]; rows: unknown[][] } {
  const depth = o.depth ?? 6;
  const flat = (v: unknown, prefix: string, out: Record<string, unknown>, d: number) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && d < depth) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (!entries.length && prefix) out[prefix] = null;
      for (const [k, x] of entries) flat(x, prefix ? `${prefix}_${k}` : k, out, d + 1);
    } else out[prefix || 'value'] = v;
  };
  const rows: Array<Record<string, unknown>> = [];
  for (const it of items) {
    const base: Record<string, unknown> = {};
    if (o.unnest) {
      const parts = o.unnest.split('.');
      let arr: unknown = it;
      for (const p of parts) arr = arr && typeof arr === 'object' ? (arr as Record<string, unknown>)[p] : undefined;
      // The record without the unnested array, then one row per item.
      const rest = JSON.parse(JSON.stringify(it ?? {})) as Record<string, unknown>;
      let cur: Record<string, unknown> | undefined = rest;
      for (const p of parts.slice(0, -1)) cur = cur?.[p] as Record<string, unknown> | undefined;
      if (cur) delete cur[parts.at(-1)!];
      flat(rest, '', base, 0);
      const name = parts.join('_');
      if (!Array.isArray(arr) || !arr.length) { rows.push(base); continue; }
      for (const x of arr) { const r = { ...base }; if (x && typeof x === 'object' && !Array.isArray(x)) flat(x, name, r, 1); else r[name] = x; rows.push(r); }
    } else { flat(it, '', base, 0); rows.push(base); }
  }
  const columns: string[] = []; const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  return { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
}

/** Newline-delimited JSON: one value per line (blank lines skipped; a bad line says where). */
export function parseNdjson(text: string): unknown[] {
  const out: unknown[] = [];
  text.split(/\r?\n/).forEach((l, i) => { if (!l.trim()) return; try { out.push(JSON.parse(l)); } catch { throw new DataError(`line ${i + 1} is not JSON`); } });
  return out;
}

// ---------------- XML ----------------

interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }
const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e.toLowerCase()] ?? m));
const local = (n: string) => n.replace(/^[\w.-]+:/, '');

/** A small XML parser (elements, attributes, text, CDATA; comments, processing instructions and doctypes skipped). */
export function parseXml(text: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) { if (stack.length > 1) stack.pop(); }
    else if (m[4]) {
      const node: XNode = { name: local(m[4]), attrs: {}, children: [], text: '' };
      for (const a of (m[5] ?? '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (!a[1]!.startsWith('xmlns')) node.attrs[local(a[1]!)] = unent(a[2] ?? a[3] ?? '');
      top.children.push(node);
      if (!m[6]) stack.push(node);
    } else if (m[7] !== undefined) top.text += unent(m[7]);
  }
  return root;
}
function* walk(n: XNode, path: string[] = []): Generator<{ node: XNode; path: string[] }> {
  for (const c of n.children) { const p = [...path, c.name]; yield { node: c, path: p }; yield* walk(c, p); }
}
/** A record element as a flat object: its attributes, then its children (nested ones joined with "_"; repeated ones numbered). */
function xmlRecord(n: XNode, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(n.attrs)) out[prefix ? `${prefix}_${k}` : k] = v;
  const counts = new Map<string, number>();
  for (const c of n.children) {
    const n0 = counts.get(c.name) ?? 0; counts.set(c.name, n0 + 1);
    const key = `${prefix ? `${prefix}_` : ''}${c.name}${n0 ? `_${n0 + 1}` : ''}`;
    if (c.children.length || Object.keys(c.attrs).length) { xmlRecord(c, key, out); if (c.text.trim()) out[key] = c.text.trim(); }
    else out[key] = c.text.trim() || null;
  }
  return out;
}
/** XML records as rows: the elements at `path` ("Orders/Order" or just "Order"), else the most repeated element with children. */
export function xmlRows(text: string, path?: string): { columns: string[]; rows: unknown[][] } {
  const root = parseXml(text);
  const want = path?.split('/').filter(Boolean).map(local);
  let recs: XNode[] = [];
  if (want?.length) recs = [...walk(root)].filter((x) => x.path.slice(-want.length).join('/') === want.join('/')).map((x) => x.node);
  else {
    const byName = new Map<string, XNode[]>();
    for (const x of walk(root)) if (x.node.children.length || Object.keys(x.node.attrs).length) { const k = x.path.join('/'); byName.set(k, [...(byName.get(k) ?? []), x.node]); }
    recs = [...byName.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  }
  if (!recs.length) throw new DataError(`no records${path ? ` at ${path}` : ''} in the XML`);
  return flattenRecords(recs.map((r) => xmlRecord(r)));
}

// ---------------- logs ----------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** A time as UTC "YYYY-MM-DD HH:MM:SS.mmm" (what DuckDB reads as TIMESTAMP); null when it is not one. */
export function isoTime(s: string | number | undefined | null, year?: number): string | null {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') { const ms = s > 1e14 ? s / 1000 : s > 1e11 ? s : s * 1000; return fmt(new Date(ms)); }
  let m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*([+-]\d{4})?$/.exec(s);
  if (m) return fmt(new Date(`${m[3]}-${pad(MONTHS[m[2]!.toLowerCase()]!)}-${pad(Number(m[1]))}T${m[4]}:${m[5]}:${m[6]}${m[7] ? `.${m[7]}` : ''}${m[8] ? `${m[8].slice(0, 3)}:${m[8].slice(3)}` : 'Z'}`));
  m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) return fmt(new Date(Date.UTC(year ?? new Date().getUTCFullYear(), MONTHS[m[1]!.toLowerCase()]! - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))));
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    const t = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`);
    return Number.isNaN(d.getTime()) ? null : fmt(d);
  }
  if (/^\d{9,16}(\.\d+)?$/.test(s)) return isoTime(Number(s));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : fmt(d);
}
function fmt(d: Date): string | null { return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').replace('Z', ''); }

const SEVERITY = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const FACILITY = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];
const LEVELS: Record<string, string> = { trace: 'trace', debug: 'debug', dbg: 'debug', info: 'info', information: 'info', informational: 'info', notice: 'notice', warn: 'warning', warning: 'warning', err: 'error', error: 'error', fatal: 'critical', crit: 'critical', critical: 'critical', alert: 'alert', emerg: 'emergency', panic: 'emergency' };
const level = (v: unknown) => (v === null || v === undefined ? null : LEVELS[String(v).toLowerCase()] ?? String(v).toLowerCase());
const num = (v: unknown) => { if (v === null || v === undefined || v === '' || v === '-') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const nul = (v: string | undefined) => (v === undefined || v === '-' || v === '' ? null : v);

/** The request line of an access log: method, path (without the query), query and protocol. */
function request(r: string | null): { method: string | null; path: string | null; query: string | null; protocol: string | null } {
  const m = /^(\S+)\s+(\S+)(?:\s+(\S+))?$/.exec(r ?? '');
  if (!m) return { method: null, path: r ?? null, query: null, protocol: null };
  const q = m[2]!.indexOf('?');
  return { method: m[1]!, path: q >= 0 ? m[2]!.slice(0, q) : m[2]!, query: q >= 0 ? m[2]!.slice(q + 1) : null, protocol: m[3] ?? null };
}
/** Space-separated tokens with "quoted strings" and [bracketed] times kept whole. */
function tokens(line: string): string[] {
  const out: string[] = []; const re = /"((?:[^"\\]|\\.)*)"|\[([^\]]*)\]|(\S+)/g; let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2] !== undefined ? m[2] : m[3]!);
  return out;
}
/** key=value pairs (values quoted with " when they hold spaces). */
function logfmt(line: string): Record<string, string> {
  const out: Record<string, string> = {}; const re = /([\w.@/-]+)=("(?:[^"\\]|\\.)*"|\S*)/g; let m;
  while ((m = re.exec(line))) out[m[1]!] = m[2]!.startsWith('"') ? m[2]!.slice(1, -1).replace(/\\(.)/g, '$1') : m[2]!;
  return out;
}

type Row = Record<string, unknown>;
const TYPES: Record<string, ColType> = { time: 'TIMESTAMP', status: 'BIGINT', bytes: 'BIGINT', latency_ms: 'DOUBLE', line: 'BIGINT', pid: 'BIGINT', severity_code: 'BIGINT', facility_code: 'BIGINT', event_id: 'BIGINT', record_id: 'BIGINT', received_bytes: 'BIGINT', sent_bytes: 'BIGINT', target_status: 'BIGINT', client_port: 'BIGINT', target_port: 'BIGINT', port: 'BIGINT', request_time: 'DOUBLE', target_time: 'DOUBLE', response_time: 'DOUBLE', cef_severity: 'BIGINT', src_port: 'BIGINT', dst_port: 'BIGINT' };

const ACCESS = /^(\S+) (\S+) (\S+) \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}|-) (\d+|-)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?(?: (\d+(?:\.\d+)?))?/;
function access(line: string): Row | null {
  const m = ACCESS.exec(line); if (!m) return null;
  const rq = request(m[5]!.replace(/\\"/g, '"'));
  // A trailing number (nginx $request_time in seconds, or Apache %D in microseconds) is the latency.
  const lat = m[10] ? (m[10].includes('.') ? Number(m[10]) * 1000 : Number(m[10]) / 1000) : null;
  return { time: isoTime(m[4]!), host: m[1], ident: nul(m[2]), user: nul(m[3]), ...rq, status: num(m[6]), bytes: num(m[7]) ?? 0, referrer: nul(m[8]), user_agent: nul(m[9]), latency_ms: lat };
}
function syslog(line: string, year?: number): Row | null {
  let m = /^(?:<(\d{1,3})>)1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|(?:\[(?:[^\]\\]|\\.)*\])+) ?(.*)$/.exec(line);
  if (m) {
    const pri = m[1] ? Number(m[1]) : null;
    return { time: isoTime(nul(m[2]) ?? ''), ...(pri !== null ? { facility: FACILITY[pri >> 3] ?? String(pri >> 3), level: SEVERITY[pri & 7] } : { facility: null, level: null }), host: nul(m[3]), app: nul(m[4]), pid: num(m[5]), msgid: nul(m[6]), structured: nul(m[7]), message: m[8]!.replace(/^\uFEFF/, '') };
  }
  m = /^(?:<(\d{1,3})>)?([A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\S+) (\S+) ([^:[\s]+)(?:\[(\d+)\])?: ?(.*)$/.exec(line);
  if (!m) return null;
  const pri = m[1] ? Number(m[1]) : null;
  return { time: isoTime(m[2]!, year), ...(pri !== null ? { facility: FACILITY[pri >> 3] ?? String(pri >> 3), level: SEVERITY[pri & 7] } : { facility: null, level: null }), host: m[3], app: m[4], pid: num(m[5]), msgid: null, structured: null, message: m[6] };
}
/** time and level from the usual field names of structured logs. */
function normalise(o: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  const t = ['time', 'timestamp', 'ts', '@timestamp', 'datetime', 'date', 'eventTime', 't'].find((k) => out[k] !== undefined && out[k] !== null);
  if (t) { const iso = isoTime(out[t] as string); if (iso) { delete out[t]; out.time = iso; } }
  const l = ['level', 'lvl', 'severity', 'loglevel', 'log.level', 'log_level'].find((k) => out[k] !== undefined);
  if (l) { const v = level(out[l]); delete out[l]; out.level = v; }
  const msg = ['msg', 'message', 'log'].find((k) => typeof out[k] === 'string');
  if (msg && msg !== 'message') { out.message = out[msg]; delete out[msg]; }
  return out;
}
function cefLeef(line: string): Row | null {
  const at = line.search(/(CEF|LEEF):\d/);
  if (at < 0) return null;
  const head = line.slice(0, at).trim();
  const body = line.slice(at);
  const fields: string[] = []; let cur = ''; let rest = '';
  const isCef = body.startsWith('CEF');
  const n = isCef ? 7 : 5;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) { cur += body[++i]; continue; }
    if (ch === '|' && fields.length < n) { fields.push(cur); cur = ''; if (fields.length === n) { rest = body.slice(i + 1); break; } continue; }
    cur += ch;
  }
  if (fields.length < n) return null;
  const out: Row = {};
  const pre = head ? syslog(`${head} x: `) : null;
  if (pre) { out.time = pre.time; out.host = pre.host; }
  if (isCef) {
    Object.assign(out, { format_version: fields[0]!.split(':')[1], vendor: fields[1], product: fields[2], product_version: fields[3], signature_id: fields[4], name: fields[5], cef_severity: num(fields[6]) });
    // Extension: key=value pairs; a value runs until the next " key=".
    for (const m of rest.matchAll(/(\w+)=((?:[^=\\]|\\.)*?)(?=\s+\w+=|$)/g)) out[m[1]!] = m[2]!.replace(/\\(.)/g, '$1');
  } else {
    Object.assign(out, { format_version: fields[0]!.split(':')[1], vendor: fields[1], product: fields[2], product_version: fields[3], event_id: fields[4] });
    // LEEF 2.0 may name its delimiter (a character or x09) before the attributes.
    let attrs = rest; let delim = '\t';
    const d = /^(x[0-9a-f]{2}|.)\|/i.exec(attrs);
    if (fields[0]!.startsWith('LEEF:2') && d) { delim = d[1]!.length > 1 ? String.fromCharCode(parseInt(d[1]!.slice(1), 16)) : d[1]!; attrs = attrs.slice(d[0].length); }
    for (const kv of attrs.split(delim)) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
    if (out.devTime) { out.time = isoTime(String(out.devTime)) ?? out.time; }
  }
  if (out.rt) out.time = isoTime(/^\d+$/.test(String(out.rt)) ? Number(out.rt) : String(out.rt)) ?? out.time;
  for (const [k, to] of [['src', 'src_ip'], ['dst', 'dst_ip'], ['spt', 'src_port'], ['dpt', 'dst_port'], ['srcPort', 'src_port'], ['dstPort', 'dst_port']] as const) if (out[k] !== undefined) { out[to] = to.endsWith('port') ? num(out[k]) : out[k]; delete out[k]; }
  return out;
}
function albElb(line: string, alb: boolean): Row | null {
  const t = tokens(line);
  const off = alb ? 1 : 0;
  if (t.length < 12 + off) return null;
  const [cip, cport] = (t[2 + off] ?? '').split(/:(?=\d+$)/);
  const [tip, tport] = (t[3 + off] ?? '').split(/:(?=\d+$)/);
  const times = [num(t[4 + off]), num(t[5 + off]), num(t[6 + off])];
  const rq = request(t[11 + off] ?? null);
  const u = rq.path && /^\w+:\/\//.test(rq.path) ? new URL(rq.path) : undefined;
  const ok = times.every((x) => x !== null && x >= 0);
  return { ...(alb ? { type: t[0] } : {}), time: isoTime(t[off]!), elb: t[1 + off], client_ip: cip, client_port: num(cport), target_ip: nul(tip), target_port: num(tport), request_time: times[0], target_time: times[1], response_time: times[2], latency_ms: ok ? (times[0]! + times[1]! + times[2]!) * 1000 : null, status: num(t[7 + off]), target_status: num(t[8 + off]), received_bytes: num(t[9 + off]), sent_bytes: num(t[10 + off]), method: rq.method, host: u?.host ?? null, path: u ? u.pathname : rq.path, query: rq.query ?? (u ? u.search.slice(1) || null : null), protocol: rq.protocol, user_agent: nul(t[12 + off]), ssl_cipher: nul(t[13 + off]), ssl_protocol: nul(t[14 + off]) };
}
const W3C_NAMES: Record<string, string> = { 'c-ip': 'client_ip', 's-ip': 'server_ip', 'cs-method': 'method', 'cs-uri-stem': 'path', 'cs-uri-query': 'query', 's-port': 'port', 'cs-username': 'user', 'cs(user-agent)': 'user_agent', 'cs(referer)': 'referrer', 'sc-status': 'status', 'sc-substatus': 'substatus', 'sc-win32-status': 'win32_status', 'time-taken': 'latency_ms', 'sc-bytes': 'bytes', 'cs-bytes': 'received_bytes', 's-computername': 'host', 's-sitename': 'site', 'cs-host': 'host' };
const WIN_LEVEL: Record<string, string> = { '0': 'info', '1': 'critical', '2': 'error', '3': 'warning', '4': 'info', '5': 'verbose' };

/** Converts grok-like %{PATTERN:name[:int|:float]} to a regular expression with named groups. */
export function grokToRegex(p: string): { re: RegExp; casts: Record<string, 'int' | 'float'> } {
  const G: Record<string, string> = {
    INT: '[+-]?\\d+', POSINT: '\\d+', NUMBER: '[+-]?\\d+(?:\\.\\d+)?', WORD: '\\w+', NOTSPACE: '\\S+', SPACE: '\\s*', DATA: '.*?', GREEDYDATA: '.*', QUOTEDSTRING: '"(?:[^"\\\\]|\\\\.)*"', QS: '"(?:[^"\\\\]|\\\\.)*"',
    IP: '(?:\\d{1,3}\\.){3}\\d{1,3}|[0-9a-fA-F:]+:[0-9a-fA-F:]*', IPV4: '(?:\\d{1,3}\\.){3}\\d{1,3}', HOSTNAME: '[\\w.-]+', USER: '[\\w.@-]+', USERNAME: '[\\w.@-]+', UUID: '[0-9a-fA-F-]{36}',
    LOGLEVEL: '(?:TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERR(?:OR)?|CRIT(?:ICAL)?|FATAL|SEVERE|ALERT|EMERG(?:ENCY)?|trace|debug|info|notice|warn(?:ing)?|err(?:or)?|crit(?:ical)?|fatal)',
    TIMESTAMP_ISO8601: '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?', HTTPDATE: '\\d{2}/\\w{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4}', SYSLOGTIMESTAMP: '\\w{3}\\s+\\d{1,2} \\d{2}:\\d{2}:\\d{2}',
    URIPATH: '/[^\\s?#]*', URIPATHPARAM: '/[^\\s#]*', URI: '\\w+://\\S+', PATH: '(?:/[^\\s]*)+',
  };
  const casts: Record<string, 'int' | 'float'> = {};
  const src = p.replace(/%\{(\w+)(?::([\w.]+))?(?::(int|float))?\}/g, (_m, pat: string, name?: string, cast?: string) => {
    const body = G[pat];
    if (!body) throw new DataError(`grok: unknown pattern %{${pat}} (known: ${Object.keys(G).join(', ')})`);
    if (!name) return `(?:${body})`;
    const n = name.replace(/\W/g, '_');
    if (cast) casts[n] = cast as 'int';
    return `(?<${n}>${body})`;
  });
  try { return { re: new RegExp(src), casts }; } catch (e) { throw new DataError(`grok: ${(e as Error).message}`); }
}

const DETECT: Array<[Exclude<LogFormat, 'auto' | 'regex' | 'grok' | 'cloudtrail' | 'winevent-xml' | 'winevent-csv' | 'w3c'>, RegExp]> = [
  ['cri', /^\d{4}-\d{2}-\d{2}T\S+ (stdout|stderr) [PF] /],
  ['docker', /^\{"log":/],
  ['alb', /^(http|https|h2|grpcs|ws|wss) \d{4}-\d{2}-\d{2}T\S+ \S+ [\d.:a-f]+:\d+ /],
  ['elb', /^\d{4}-\d{2}-\d{2}T\S+Z \S+ [\d.]+:\d+ \S+ -?[\d.]+ -?[\d.]+ -?[\d.]+ \d{3} /],
  ['combined', /^\S+ \S+ \S+ \[[^\]]+\] "[^"]*" (\d{3}|-) (\d+|-) "/],
  ['common', /^\S+ \S+ \S+ \[[^\]]+\] "[^"]*" (\d{3}|-) (\d+|-)/],
  ['cef', /(^|\s)CEF:\d\|/],
  ['leef', /(^|\s)LEEF:\d(\.\d)?\|/],
  ['syslog', /^(<\d{1,3}>)?(1 \S+ |[A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \S+ )/],
  ['jsonl', /^\s*\{.*\}\s*$/],
  ['logfmt', /^(\s*[\w.@/-]+=("[^"]*"|\S*)){2,}\s*$/],
];

/** Detects a log's format from its first lines (the first that most lines match). */
export function detectLog(text: string): LogFormat {
  const head = text.slice(0, 64_000);
  if (/^\s*\{\s*"Records"\s*:/.test(head)) return 'cloudtrail';
  if (/^#(Software|Version|Fields):/m.test(head)) return 'w3c';
  if (/<Event[\s>][\s\S]*<System>/.test(head)) return 'winevent-xml';
  if (/^\uFEFF?"?Level"?,"?Date and Time"?,"?Source"?,"?Event ID"?/.test(head)) return 'winevent-csv';
  const lines = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, 50);
  let best: LogFormat = 'auto'; let hits = 0;
  for (const [f, re] of DETECT) { const n = lines.filter((l) => re.test(l)).length; if (n > hits) { hits = n; best = f; } }
  if (!hits) throw new DataError('could not tell the log format: name it (log.format), or give a regex or grok pattern');
  return best;
}

/**
 * A log as typed rows. Each row keeps its line number; lines that do not parse are counted (and
 * refused when most do not, with an example), never invented.
 */
export function parseLog(text: string, o: { format?: LogFormat; pattern?: string; year?: number } = {}): Parsed {
  const format = !o.format || o.format === 'auto' ? detectLog(text) : o.format;
  const rows: Row[] = [];
  let bad = 0; let example = '';
  const push = (r: Row | null, line: string, n: number) => { if (r) rows.push({ line: n, ...r }); else if (line.trim()) { bad++; if (!example) example = line.slice(0, 160); } };
  const lines = () => text.split(/\r?\n/);
  switch (format) {
    case 'common': case 'combined': lines().forEach((l, i) => push(access(l), l, i + 1)); break;
    case 'syslog': lines().forEach((l, i) => push(syslog(l, o.year), l, i + 1)); break;
    case 'jsonl': lines().forEach((l, i) => {
      if (!l.trim()) return;
      let v: unknown; try { v = JSON.parse(l); } catch { push(null, l, i + 1); return; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) { push(null, l, i + 1); return; }
      const t = flattenRecords([v]); const r: Row = {}; t.columns.forEach((c, k) => { r[c] = t.rows[0]![k]; });
      push(normalise(r), l, i + 1);
    }); break;
    case 'logfmt': lines().forEach((l, i) => { const kv = l.trim() ? logfmt(l) : {}; push(Object.keys(kv).length ? normalise(kv) : null, l, i + 1); }); break;
    case 'cef': case 'leef': lines().forEach((l, i) => push(cefLeef(l), l, i + 1)); break;
    case 'alb': case 'elb': lines().forEach((l, i) => push(l.trim() ? albElb(l, format === 'alb') : null, l, i + 1)); break;
    case 'docker': lines().forEach((l, i) => { if (!l.trim()) return; try { const v = JSON.parse(l) as { log?: string; stream?: string; time?: string }; push({ time: isoTime(v.time ?? ''), stream: v.stream ?? null, ...lineLevel(String(v.log ?? '').replace(/\r?\n$/, '')) }, l, i + 1); } catch { push(null, l, i + 1); } }); break;
    case 'cri': {
      // Partial lines (P) are joined with the next until a full one (F).
      let part = ''; let start = 0;
      lines().forEach((l, i) => {
        const m = /^(\S+) (stdout|stderr) ([PF]) ?(.*)$/.exec(l);
        if (!m) { push(null, l, i + 1); return; }
        if (!part) start = i + 1;
        part += m[4];
        if (m[3] === 'F') { push({ time: isoTime(m[1]!), stream: m[2], ...lineLevel(part) }, l, start); part = ''; }
      });
      break;
    }
    case 'w3c': {
      let fields: string[] = [];
      lines().forEach((l, i) => {
        if (l.startsWith('#')) { const f = /^#Fields:\s*(.*)$/.exec(l); if (f) fields = f[1]!.trim().split(/\s+/); return; }
        if (!l.trim()) return;
        if (!fields.length) { push(null, l, i + 1); return; }
        const v = l.trim().split(/\s+/);
        const r: Row = {};
        fields.forEach((f, k) => { const key = W3C_NAMES[f.toLowerCase()] ?? f.toLowerCase().replace(/[^a-z0-9]+/g, '_'); r[key] = nul(v[k]); });
        if (r.date || r.time) { r.time = isoTime(`${r.date ?? ''} ${r.time ?? ''}`.trim()); delete r.date; }
        if (typeof r.user_agent === 'string') r.user_agent = (r.user_agent as string).replace(/\+/g, ' ');
        for (const k of ['status', 'substatus', 'win32_status', 'port', 'bytes', 'received_bytes', 'latency_ms']) if (k in r) r[k] = num(r[k]);
        push(r, l, i + 1);
      });
      break;
    }
    case 'cloudtrail': {
      let recs: unknown[];
      try { const j = JSON.parse(text) as { Records?: unknown[] }; recs = Array.isArray(j.Records) ? j.Records : Array.isArray(j) ? j as unknown[] : []; } catch { recs = parseNdjson(text); }
      const t = flattenRecords(recs);
      t.rows.forEach((r, i) => { const o: Row = {}; t.columns.forEach((c, k) => { o[c] = r[k]; }); const out = normalise(o); out.status = o.errorCode ? 'error' : 'ok'; push(out, '', i + 1); });
      break;
    }
    case 'winevent-xml': {
      const root = parseXml(text);
      let n = 0;
      for (const x of walk(root)) {
        if (x.node.name !== 'Event') continue;
        n++;
        const sys = x.node.children.find((c) => c.name === 'System');
        const g = (name: string) => sys?.children.find((c) => c.name === name);
        const r: Row = { time: isoTime(g('TimeCreated')?.attrs.SystemTime ?? ''), event_id: num(g('EventID')?.text.trim()), level: WIN_LEVEL[g('Level')?.text.trim() ?? ''] ?? null, provider: g('Provider')?.attrs.Name ?? null, channel: g('Channel')?.text.trim() || null, computer: g('Computer')?.text.trim() || null, record_id: num(g('EventRecordID')?.text.trim()), task: num(g('Task')?.text.trim()), keywords: g('Keywords')?.text.trim() || null, user_sid: g('Security')?.attrs.UserID ?? null };
        const data = x.node.children.find((c) => c.name === 'EventData' || c.name === 'UserData');
        data?.children.forEach((d, k) => { r[`data_${(d.attrs.Name ?? `${k + 1}`).replace(/\W+/g, '_')}`] = d.text.trim() || null; });
        const msg = x.node.children.find((c) => c.name === 'RenderingInfo')?.children.find((c) => c.name === 'Message');
        if (msg) r.message = msg.text.trim();
        push(r, '', n);
      }
      break;
    }
    case 'winevent-csv': {
      const all = lines(); const head = splitDelimited(all[0]!.replace(/^\uFEFF/, ''), ',');
      // Event Viewer's export: the message runs over several lines inside quotes.
      const recs: string[] = []; let cur = ''; let q = 0;
      for (const l of all.slice(1)) { cur = cur ? `${cur}\n${l}` : l; q += (l.match(/"/g) ?? []).length; if (q % 2 === 0) { if (cur.trim()) recs.push(cur); cur = ''; q = 0; } }
      recs.forEach((rec, i) => {
        const v = splitDelimited(rec, ',');
        const o: Row = {}; head.forEach((h, k) => { o[h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')] = v[k] ?? null; });
        push({ time: isoTime(String(o.date_and_time ?? '')), level: level(o.level), provider: o.source ?? null, event_id: num(o.event_id), task: o.task_category ?? null, message: v.slice(head.length).join(',') || null }, rec, i + 2);
      });
      break;
    }
    case 'regex': case 'grok': {
      if (!o.pattern) throw new DataError(`a ${format} log needs log.pattern`);
      let re: RegExp; let casts: Record<string, 'int' | 'float'> = {};
      if (format === 'grok') ({ re, casts } = grokToRegex(o.pattern));
      else { try { re = new RegExp(o.pattern); } catch (e) { throw new DataError(`log.pattern: ${(e as Error).message}`); } }
      if (!/\(\?<\w+>/.test(re.source)) throw new DataError('the pattern needs named groups, e.g. (?<status>\\d{3}) or %{INT:status}');
      lines().forEach((l, i) => {
        const m = re.exec(l);
        if (!m?.groups) { push(null, l, i + 1); return; }
        const r: Row = {};
        for (const [k, v] of Object.entries(m.groups)) r[k] = casts[k] ? num(v) : v ?? null;
        push(normalise(r), l, i + 1);
      });
      break;
    }
    default: throw new DataError(`log format ${String(format)} is not one of the known formats`);
  }
  const total = rows.length + bad;
  if (!rows.length || bad > total / 2) throw new DataError(`${bad} of ${total} lines are not ${format}${example ? `, e.g. "${example}"` : ''}: name the format (log.format) or give a pattern`);
  const columns: string[] = []; const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  const types: Record<string, ColType> = {};
  for (const c of columns) if (TYPES[c]) types[c] = TYPES[c]!;
  return { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)), types, note: `${format}: ${rows.length} rows${bad ? `, ${bad} lines skipped` : ''}` };
}
/** A container log line: its level when it says one ("ERROR ...", level=warn, {"level":"info"}). */
function lineLevel(msg: string): Row {
  let lv: string | null = null;
  const j = /^\s*\{/.test(msg) ? (() => { try { return JSON.parse(msg) as Row; } catch { return undefined; } })() : undefined;
  if (j) lv = level(j.level ?? j.lvl ?? j.severity);
  else { const m = /\blevel=(\w+)|^\s*\[?(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\]?\b/i.exec(msg); if (m) lv = level(m[1] ?? m[2]); }
  return { level: lv, message: msg };
}
