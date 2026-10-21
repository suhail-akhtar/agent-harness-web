// A small YAML reader for inventory files: block mappings and sequences,
// flow lists and maps ([a, b], {k: v}), quoted and plain scalars, comments,
// literal and folded block scalars (| and >). No anchors, tags or multiple
// documents: an inventory needs none, and a parse error names the line.

export class YamlError extends Error {
  constructor(message, line) { super(line ? `line ${line}: ${message}` : message); this.line = line; }
}

/** Strips a trailing comment that is not inside quotes. */
function stripComment(s) {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && !(q === '"' && s[i - 1] === '\\')) q = ''; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function scalar(raw, line) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(`unterminated string ${s}`, line);
    try { return JSON.parse(s); } catch { throw new YamlError(`bad double-quoted string ${s}`, line); }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`unterminated string ${s}`, line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') || s.startsWith('{')) return flow(s, line);
  if (/^(true|True|TRUE|yes|Yes|on|On)$/.test(s)) return true;
  if (/^(false|False|FALSE|no|No|off|Off)$/.test(s)) return false;
  if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s.replace(/_/g, ''));
  if (/^0x[0-9a-fA-F]+$/.test(s)) return Number(s);
  return s;
}

/** A flow collection on one line: [a, "b", {c: 1}]. */
function flow(s, line) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const value = () => {
    ws();
    if (s[i] === '[') {
      i++; const out = [];
      ws();
      if (s[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value()); ws();
        if (s[i] === ',') { i++; ws(); if (s[i] === ']') { i++; return out; } continue; }
        if (s[i] === ']') { i++; return out; }
        throw new YamlError(`expected , or ] in ${s}`, line);
      }
    }
    if (s[i] === '{') {
      i++; const out = {};
      ws();
      if (s[i] === '}') { i++; return out; }
      for (;;) {
        ws();
        const k = atom(':');
        if (s[i] !== ':') throw new YamlError(`expected : in ${s}`, line);
        i++;
        out[String(k)] = value(); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return out; }
        throw new YamlError(`expected , or } in ${s}`, line);
      }
    }
    return atom('');
  };
  const atom = (stopExtra) => {
    ws();
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; let j = i + 1;
      while (j < s.length && !(s[j] === q && !(q === '"' && s[j - 1] === '\\'))) j++;
      if (j >= s.length) throw new YamlError(`unterminated string in ${s}`, line);
      const v = scalar(s.slice(i, j + 1), line); i = j + 1; return v;
    }
    let j = i;
    while (j < s.length && !',]}'.includes(s[j]) && !(stopExtra && s[j] === ':' )) j++;
    const v = scalar(s.slice(i, j), line); i = j; return v;
  };
  const v = value();
  ws();
  if (i < s.length) throw new YamlError(`unexpected text after a flow collection: ${s.slice(i)}`, line);
  return v;
}

/** Splits "key: value" (the key may be quoted); undefined when the line is not a mapping entry. */
function splitKey(text) {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#'"{[][^:#]*?)\s*:(?:\s+|$)(.*)$/.exec(text);
  if (!m) return undefined;
  const k = m[1].startsWith('"') || m[1].startsWith("'") ? scalar(m[1]) : m[1].trim();
  return { key: String(k), rest: m[2] };
}

export function parseYaml(text) {
  const lines = [];
  String(text).replace(/\r\n?/g, '\n').split('\n').forEach((raw, n) => {
    if (/^\s*#/.test(raw) || !raw.trim()) { lines.push({ n: n + 1, blank: true, raw }); return; }
    if (/^(---|\.\.\.)\s*$/.test(raw)) { lines.push({ n: n + 1, blank: true, raw }); return; }
    if (/^\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', n + 1);
    const indent = raw.length - raw.trimStart().length;
    lines.push({ n: n + 1, indent, text: stripComment(raw.trimStart()), raw });
  });
  let i = 0;
  const next = () => { while (i < lines.length && lines[i].blank) i++; return lines[i]; };

  /** A literal (|) or folded (>) block scalar after the current line. */
  function blockScalar(style, parentIndent) {
    const out = [];
    let indent;
    while (i < lines.length) {
      const l = lines[i];
      if (l.blank) { out.push(''); i++; continue; }
      if (l.indent <= parentIndent) break;
      indent ??= l.indent;
      out.push(l.raw.slice(indent));
      i++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    const body = style.startsWith('|') ? out.join('\n') : out.join(' ').replace(/ {2,}/g, ' ');
    return style.endsWith('-') ? body : `${body}\n`;
  }

  function parseValueAfter(rest, l, ownIndent) {
    const r = rest.trim();
    if (/^[|>][-+]?$/.test(r)) { i++; return blockScalar(r, ownIndent); }
    if (r !== '') { i++; return scalar(r, l.n); }
    i++;
    const nl = next();
    if (!nl || nl.indent < ownIndent || (nl.indent === ownIndent && !nl.text.startsWith('- '))) return null;
    if (nl.indent === ownIndent && nl.text.startsWith('-')) return parseBlock(ownIndent);
    if (nl.indent <= ownIndent) return null;
    return parseBlock(nl.indent);
  }

  function parseBlock(indent) {
    const first = next();
    if (!first) return null;
    if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(indent);
    return parseMap(indent);
  }

  function parseSeq(indent) {
    const out = [];
    for (;;) {
      const l = next();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('bad indentation in a list', l.n);
      if (!(l.text === '-' || l.text.startsWith('- '))) break;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      const itemIndent = indent + 2 + (rest.length - rest.trimStart().length);
      const body = rest.trim();
      if (!body) { out.push(parseValueAfter('', l, indent)); continue; }
      const kv = !body.startsWith('[') && !body.startsWith('{') && !body.startsWith('"') && !body.startsWith("'") ? splitKey(body) : undefined;
      if (kv) {
        // "- key: value" starts a mapping whose other keys sit at the item's indentation.
        l.indent = itemIndent; l.text = body;
        out.push(parseMap(itemIndent));
      } else {
        if (/^[|>][-+]?$/.test(body)) { i++; out.push(blockScalar(body, indent)); continue; }
        i++;
        out.push(scalar(body, l.n));
      }
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    for (;;) {
      const l = next();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(`bad indentation (expected ${indent} spaces, found ${l.indent})`, l.n);
      if (l.text.startsWith('- ') || l.text === '-') break;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError(`expected "key: value", found "${l.text.slice(0, 60)}"`, l.n);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlError(`duplicate key "${kv.key}"`, l.n);
      out[kv.key] = parseValueAfter(kv.rest, l, indent);
    }
    return out;
  }

  const first = next();
  if (!first) return null;
  if (first.indent !== 0) throw new YamlError('the document must start at column 0', first.n);
  const doc = /^[[{]/.test(first.text) ? (i++, scalar(first.text, first.n)) : (!first.text.startsWith('-') && !splitKey(first.text) ? (i++, scalar(first.text, first.n)) : parseBlock(0));
  const left = next();
  if (left) throw new YamlError(`unexpected content "${left.text.slice(0, 60)}"`, left.n);
  return doc;
}
