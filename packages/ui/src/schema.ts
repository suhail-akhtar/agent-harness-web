/**
 * The JSON Schema subset settings sections and form views are written in (JsonSchema in
 * @harness/plugin-ui), turned into fields, defaults and error messages. Pure, so it is tested
 * without a DOM; SchemaForm.tsx draws what this decides.
 */

import type { JsonSchema } from '@harness/plugin-ui';

export type Widget = 'switch' | 'select' | 'radio' | 'number' | 'text' | 'secret' | 'textarea' | 'color' | 'path' | 'url' | 'email' | 'list' | 'object';

/** The control a property is drawn with. */
export function widgetFor(s: JsonSchema): Widget {
  if (s.type === 'boolean') return 'switch';
  if (s.enum) return s.enum.length <= 3 && s.type !== 'number' && s.type !== 'integer' ? 'radio' : 'select';
  if (s.type === 'number' || s.type === 'integer') return 'number';
  if (s.type === 'array') return 'list';
  if (s.type === 'object' || s.properties) return 'object';
  switch (s.format) {
    case 'secret': return 'secret';
    case 'multiline': return 'textarea';
    case 'color': return 'color';
    case 'path': return 'path';
    case 'url': return 'url';
    case 'email': return 'email';
    default: return 'text';
  }
}

/** Properties in display order: `order` first (ascending), then as written. */
export function fieldsOf(s: JsonSchema): Array<[string, JsonSchema]> {
  const entries = Object.entries(s.properties ?? {});
  return entries.map((e, i) => ({ e, i })).sort((a, b) => (a.e[1].order ?? 1e9) - (b.e[1].order ?? 1e9) || a.i - b.i).map((x) => x.e);
}

/** A value with every default filled in (deeply), keeping what is already there. */
export function withDefaults(s: JsonSchema, value: unknown): unknown {
  if (s.type === 'object' || s.properties) {
    const base = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
    for (const [k, sub] of fieldsOf(s)) {
      const v = withDefaults(sub, base[k]);
      if (v !== undefined) base[k] = v;
    }
    return base;
  }
  if (value !== undefined && value !== null) return value;
  return s.default !== undefined ? structuredClone(s.default) : undefined;
}

/** The label of a field: its title, else the key made readable. */
export function labelOf(key: string, s: JsonSchema): string {
  if (s.title) return s.title;
  const words = key.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What an option is called: `enumLabels` when given, else the value. */
export function optionLabels(s: JsonSchema): Array<{ value: string; label: string }> {
  return (s.enum ?? []).map((v, i) => ({ value: String(v), label: s.enumLabels?.[i] ?? String(v) }));
}

/** Turns what a text box holds into the schema's type ("" -> undefined for optional numbers). */
export function coerce(s: JsonSchema, raw: string): unknown {
  if (s.type === 'number' || s.type === 'integer') {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (s.enum && (typeof s.enum[0] === 'number')) { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
  return raw;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;

/** Every problem with `value`, by dotted path ("" for the root). Empty when it is valid. */
export function validate(s: JsonSchema, value: unknown, path = ''): Record<string, string> {
  const errors: Record<string, string> = {};
  const err = (msg: string) => { if (!errors[path]) errors[path] = msg; };
  const empty = value === undefined || value === null || value === '';
  if (s.type === 'object' || s.properties) {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    for (const req of s.required ?? []) {
      const v = obj[req];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) errors[path ? `${path}.${req}` : req] = `${labelOf(req, s.properties?.[req] ?? {})} is required.`;
    }
    for (const [k, sub] of fieldsOf(s)) {
      const p = path ? `${path}.${k}` : k;
      if (errors[p]) continue;
      if (obj[k] === undefined) continue;
      Object.assign(errors, validate(sub, obj[k], p));
    }
    return errors;
  }
  if (empty) return errors;
  switch (s.type) {
    case 'boolean': if (typeof value !== 'boolean') err('Must be on or off.'); break;
    case 'integer': if (typeof value !== 'number' || !Number.isInteger(value)) err('Must be a whole number.'); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) err('Must be a number.'); break;
    case 'array':
      if (!Array.isArray(value)) err('Must be a list.');
      else if (s.items) value.forEach((v, i) => Object.assign(errors, validate(s.items!, v, `${path}[${i}]`)));
      break;
    case 'string': case undefined: if (typeof value !== 'string' && !s.enum) err('Must be text.'); break;
  }
  if (errors[path]) return errors;
  if (s.enum && !s.enum.map(String).includes(String(value))) err(`Must be one of: ${optionLabels(s).map((o) => o.label).join(', ')}.`);
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) err(`Must be at least ${s.minimum}.`);
    if (s.maximum !== undefined && value > s.maximum) err(`Must be at most ${s.maximum}.`);
  }
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) err(s.minLength === 1 ? 'Must not be empty.' : `Must be at least ${s.minLength} characters.`);
    if (s.maxLength !== undefined && value.length > s.maxLength) err(`Must be at most ${s.maxLength} characters.`);
    if (s.pattern) { try { if (!new RegExp(s.pattern).test(value)) err('Is not in the expected format.'); } catch { /* the manifest validator refuses bad patterns */ } }
    if (s.format === 'url' && !/^https?:\/\/[^\s]+$/i.test(value)) err('Must be an http(s) address.');
    if (s.format === 'email' && !EMAIL.test(value)) err('Must be an e-mail address.');
    if (s.format === 'color' && !COLOR.test(value)) err('Must be a #hex colour.');
  }
  return errors;
}

/** Reads a dotted path ("a.b") out of an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.').filter(Boolean)) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return cur;
}

/** Returns a copy of `obj` with `path` set to `value` (undefined removes it). */
export function setPath<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.').filter(Boolean);
  const copy: Record<string, unknown> = { ...obj };
  let cur = copy;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) { if (value === undefined) delete cur[k]; else cur[k] = value; return; }
    const next = cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k]) ? { ...(cur[k] as Record<string, unknown>) } : {};
    cur[k] = next;
    cur = next;
  });
  return copy as T;
}

/** Text that matches a search over a schema's fields (the settings search). */
export function schemaText(s: JsonSchema, key = ''): string {
  const own = [key, s.title, s.description, ...(s.enumLabels ?? []), ...(s.enum ?? []).map(String)].filter(Boolean).join(' ');
  return [own, ...fieldsOf(s).map(([k, sub]) => schemaText(sub, k))].join(' ');
}
