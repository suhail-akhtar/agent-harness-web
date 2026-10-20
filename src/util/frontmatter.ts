// Minimal YAML frontmatter for SKILL.md and agent files: `key: value` pairs,
// quoted strings, [a, b] lists, and `|` / `>` blocks. Enough for the formats
// Claude Code and the Agent Skills convention use; not a general YAML parser.

export interface Parsed { data: Record<string, string | string[]>; body: string }

export function parseFrontmatter(text: string): Parsed {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src };
  const lines = m[1]!.split('\n');
  const data: Record<string, string | string[]> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === '')) block.push(lines[++i]!.trim());
      data[key] = value.startsWith('|') ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      continue;
    }
    if (value === '' && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) items.push(unquote(lines[++i]!.replace(/^\s+-\s+/, '').trim()));
      data[key] = items;
      continue;
    }
    data[key] = unquote(value);
  }
  return { data, body: m[2]!.trim() };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

export function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
