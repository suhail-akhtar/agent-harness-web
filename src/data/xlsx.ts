import zlib from 'node:zlib';

// Excel workbooks (.xlsx) without a dependency: an xlsx is a zip of XML parts. Reading takes every
// sheet's cells with their types (numbers, text, booleans, and dates told apart by the cell's
// number format); writing makes a plain workbook (one sheet per table, a bold header row, dates
// formatted as dates) for exports.

export type Cell = string | number | boolean | null;
export interface Sheet { name: string; rows: Cell[][]; dates: Set<string> }

// ---------------- zip ----------------

function unzip(buf: Buffer): Map<string, Buffer> {
  // The end of central directory record: the last 0x06054b50 within 64 KB of the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not an xlsx workbook (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    total += usize;
    if (total > 512 * 1024 * 1024) throw new Error('the workbook is larger than 512 MB unpacked');
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(lstart, lstart + csize);
    out.set(name.replace(/^\/+/, ''), method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) * 2 + 1024 }));
  }
  return out;
}

function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = []; const dir: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const crc = zlib.crc32(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc >>> 0, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, comp); dir.push(c, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(dir);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

// ---------------- reading ----------------

const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!;
});
const attr = (tag: string, name: string) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unescapeXml(m[1]!) : undefined; };
/** The text of every <t> inside a fragment (rich text runs joined; phonetic runs skipped). */
const textOf = (frag: string) => { let s = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>|<rPh[\s\S]*?<\/rPh>/g; let m; while ((m = re.exec(frag))) if (m[1] !== undefined && !m[0].startsWith('<rPh')) s += unescapeXml(m[1]); return s; };

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateFormat = (code: string) => /[dmyhs]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"|\\./g, '')) && !/^(general|0|#)/i.test(code.trim());

function colIndex(ref: string): number { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; }

/** Excel's serial day to ISO text (the 1900 system's leap-year bug included, as Excel counts). */
function serialToIso(v: number, date1904: boolean): string {
  const ms = Math.round((v + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return Math.abs(v - Math.floor(v)) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

export function readXlsx(buf: Buffer): Sheet[] {
  const files = unzip(buf);
  const get = (n: string) => files.get(n)?.toString('utf8');
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('not an xlsx workbook (no xl/workbook.xml)');
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(wb);
  const rels = new Map<string, string>();
  for (const m of (get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) { const id = attr(m[0], 'Id'); const t = attr(m[0], 'Target'); if (id && t) rels.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`); }
  const shared: string[] = [];
  for (const m of (get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');
  // Which cell styles are dates.
  const styles = get('xl/styles.xml') ?? '';
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '');
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*?(?:\/>|>)/g)].map((m) => { const id = Number(attr(m[0], 'numFmtId') ?? 0); return BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!)); });
  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const target = rels.get(attr(m[0], 'r:id') ?? '');
    const xml = target ? get(target) : undefined;
    if (!xml) continue;
    const rows: Cell[][] = [];
    const dates = new Set<string>();
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const ri = Number(attr(r[1]!, 'r') ?? rows.length + 1) - 1;
      const row: Cell[] = [];
      let ci = -1;
      for (const c of r[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1]!; const body = c[2] ?? '';
        const ref = attr(a, 'r');
        ci = ref ? colIndex(ref) : ci + 1;
        const t = attr(a, 't') ?? 'n';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val: Cell = null;
        if (t === 's') val = v !== undefined ? shared[Number(v)] ?? '' : null;
        else if (t === 'inlineStr') val = textOf(body);
        else if (t === 'str') val = v !== undefined ? unescapeXml(v) : null;
        else if (t === 'b') val = v === '1';
        else if (t === 'e') val = null;
        else if (v !== undefined && v !== '') {
          const n = Number(v);
          if (dateStyle[Number(attr(a, 's') ?? 0)] && Number.isFinite(n)) { val = serialToIso(n, date1904); dates.add(`${ri}:${ci}`); } else val = n;
        }
        row[ci] = val;
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
      rows[ri] = row;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name, rows, dates });
  }
  return sheets;
}

export interface Table { columns: Array<{ name: string; type: 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP' | 'VARCHAR' }>; rows: Cell[][] }

/**
 * A sheet as a table: the first non-empty row is the header (blank or repeated names made unique),
 * trailing empty rows dropped, and each column typed from its cells (mixed columns are text).
 */
export function sheetTable(s: Sheet): Table {
  const start = s.rows.findIndex((r) => r.some((v) => v !== null && v !== ''));
  if (start < 0) return { columns: [], rows: [] };
  const head = s.rows[start]!;
  let body = s.rows.slice(start + 1);
  while (body.length && !body[body.length - 1]!.some((v) => v !== null && v !== '')) body.pop();
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const seen = new Map<string, number>();
  const names = Array.from({ length: width }, (_, i) => {
    let n = String(head[i] ?? '').trim() || `column${i + 1}`;
    const k = n.toLowerCase();
    if (seen.has(k)) { seen.set(k, seen.get(k)! + 1); n = `${n}_${seen.get(k)}`; } else seen.set(k, 1);
    return n;
  });
  const columns = names.map((name, i) => {
    let kind: Table['columns'][number]['type'] | undefined;
    for (let r = 0; r < body.length; r++) {
      const v = body[r]![i];
      if (v === null || v === undefined || v === '') continue;
      const isDate = s.dates.has(`${start + 1 + r}:${i}`);
      const k = isDate ? (String(v).length > 10 ? 'TIMESTAMP' : 'DATE') : typeof v === 'number' ? (Number.isInteger(v) ? 'BIGINT' : 'DOUBLE') : typeof v === 'boolean' ? 'BOOLEAN' : 'VARCHAR';
      if (!kind) kind = k;
      else if (kind !== k) kind = (kind === 'BIGINT' && k === 'DOUBLE') || (kind === 'DOUBLE' && k === 'BIGINT') ? 'DOUBLE' : (kind === 'DATE' && k === 'TIMESTAMP') || (kind === 'TIMESTAMP' && k === 'DATE') ? 'TIMESTAMP' : 'VARCHAR';
    }
    return { name, type: kind ?? 'VARCHAR' };
  });
  const rows = body.map((r) => columns.map((c, i) => { const v = r[i] ?? null; return v === '' ? null : c.type === 'VARCHAR' && v !== null ? String(v) : v; }));
  return { columns, rows };
}

// ---------------- writing ----------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const isoDate = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
function isoToSerial(s: string): number { const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s.replace(' ', 'T')}Z`); return t / 86_400_000 + 25569; }

/** A workbook from tables (one sheet each): header row bold, numbers as numbers, ISO dates as dates. */
export function writeXlsx(sheets: Array<{ name: string; columns: string[]; rows: Cell[][] }>): Buffer {
  const used = new Set<string>();
  const names = sheets.map((s, i) => {
    let n = (s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`;
    while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)}_${i + 1}`;
    used.add(n.toLowerCase());
    return n;
  });
  const sheetXml = (s: { columns: string[]; rows: Cell[][] }) => {
    const rows = [s.columns, ...s.rows].map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (v === null || v === undefined) return '';
      if (ri === 0) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${esc(String(v))}</t></is></c>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      if (typeof v === 'string' && isoDate.test(v)) return `<c r="${ref}" s="${v.length > 10 ? 3 : 2}"><v>${isoToSerial(v)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows}</sheetData></worksheet>`;
  };
  const x = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: x(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`) },
    { name: '_rels/.rels', data: x('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: x(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: x(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: x('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>') },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x(sheetXml(s).replace(/^<\?xml[^>]*>\n/, '')) })),
  ]);
}
