/**
 * A form drawn from a JSON Schema: plugin settings sections and `form` views. No plugin code runs;
 * the schema says what fields exist and the shell draws them with its own controls.
 */

import React, { useMemo, useState } from 'react';
import type { JsonSchema } from '@harness/plugin-ui';
import { fieldsOf, getPath, labelOf, optionLabels, setPath, validate, widgetFor, coerce } from '../schema.ts';
import { Button, cx, Field, IconButton, Input, Select, Switch, Textarea } from './primitives.tsx';

export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  /** Read-only (operator scope for members): shown, locked. */
  disabled?: boolean;
  lockedReason?: string;
  /** Show errors before anything was touched (after a submit). */
  showAllErrors?: boolean;
  /** Pick a folder (path fields); the desktop opens the native dialog. */
  pickPath?: () => Promise<string | null>;
  idPrefix?: string;
}

export function SchemaForm({ schema, value, onChange, disabled, lockedReason, showAllErrors, pickPath, idPrefix = 'sf' }: SchemaFormProps): React.ReactElement {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const errors = useMemo(() => validate(schema, value), [schema, value]);
  const set = (path: string, v: unknown) => { onChange(setPath(value, path, v)); setTouched((t) => new Set(t).add(path)); };
  return (
    <div className="divide-y divide-hx-border-subtle" data-schema-form>
      {fieldsOf(schema).map(([key, sub]) => (
        <SchemaField key={key} path={key} name={key} schema={sub} root={value} set={set} errors={errors} show={(p) => showAllErrors || touched.has(p)} disabled={disabled} lockedReason={lockedReason} pickPath={pickPath} required={schema.required?.includes(key)} idPrefix={idPrefix} />
      ))}
    </div>
  );
}

function SchemaField({ path, name, schema: s, root, set, errors, show, disabled, lockedReason, pickPath, required, idPrefix }: { path: string; name: string; schema: JsonSchema; root: Record<string, unknown>; set: (p: string, v: unknown) => void; errors: Record<string, string>; show: (p: string) => boolean; disabled?: boolean; lockedReason?: string; pickPath?: () => Promise<string | null>; required?: boolean; idPrefix: string }): React.ReactElement {
  const w = widgetFor(s);
  const v = getPath(root, path);
  const id = `${idPrefix}-${path.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const error = show(path) ? errors[path] : undefined;
  const label = labelOf(name, s);
  if (w === 'object') {
    return (
      <fieldset className="py-2.5">
        <legend className="text-[13px] font-semibold text-hx-primary">{label}</legend>
        {s.description && <div className="mt-0.5 text-[12px] text-hx-muted">{s.description}</div>}
        <div className="mt-1 border-l border-hx-border-subtle pl-3">
          {fieldsOf(s).map(([k, sub]) => <SchemaField key={k} path={`${path}.${k}`} name={k} schema={sub} root={root} set={set} errors={errors} show={show} disabled={disabled} lockedReason={lockedReason} pickPath={pickPath} required={s.required?.includes(k)} idPrefix={idPrefix} />)}
        </div>
      </fieldset>
    );
  }
  const common = { id, disabled, 'aria-describedby': error ? `${id}-err` : undefined } as const;
  let control: React.ReactNode;
  switch (w) {
    case 'switch': control = <Switch id={id} checked={v === true || (v === undefined && s.default === true)} onChange={(x) => set(path, x)} disabled={disabled} label={label} />; break;
    case 'select': control = <Select {...common} value={v === undefined ? '' : String(v)} onChange={(x) => set(path, x === '' ? undefined : coerce(s, x))} options={[...(required || s.default !== undefined ? [] : [{ value: '', label: '—' }]), ...optionLabels(s)]} className="w-56" />; break;
    case 'radio':
      control = (
        <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-hx-pill p-0.5">
          {optionLabels(s).map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={String(v ?? s.default) === o.value} disabled={disabled} onClick={() => set(path, coerce(s, o.value))}
              className={cx('h-7 rounded-md px-2.5 text-[12.5px]', String(v ?? s.default) === o.value ? 'bg-hx-elevated font-medium text-hx-primary shadow-sm' : 'text-hx-muted hover:text-hx-primary')}>{o.label}</button>
          ))}
        </div>
      );
      break;
    case 'number': control = <Input {...common} type="number" className="w-40" value={v === undefined ? '' : String(v)} min={s.minimum} max={s.maximum} step={s.type === 'integer' ? 1 : 'any'} onChange={(e) => set(path, coerce(s, e.target.value))} invalid={!!error} />; break;
    case 'textarea': control = <Textarea {...common} rows={5} value={typeof v === 'string' ? v : ''} onChange={(e) => set(path, e.target.value)} invalid={!!error} />; break;
    case 'secret': control = <SecretInput {...common} value={typeof v === 'string' ? v : ''} onChange={(x) => set(path, x)} invalid={!!error} />; break;
    case 'color': control = (
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} colour`} disabled={disabled} value={typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888'} onChange={(e) => set(path, e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-hx-border bg-transparent" />
        <Input {...common} className="w-28 font-mono" value={typeof v === 'string' ? v : ''} onChange={(e) => set(path, e.target.value)} invalid={!!error} />
      </div>
    ); break;
    case 'path': control = (
      <div className="flex gap-2">
        <Input {...common} className="font-mono" value={typeof v === 'string' ? v : ''} onChange={(e) => set(path, e.target.value)} invalid={!!error} />
        {pickPath && <Button disabled={disabled} onClick={async () => { const p = await pickPath(); if (p) set(path, p); }}>Choose…</Button>}
      </div>
    ); break;
    case 'list': control = <ListInput id={id} schema={s} value={Array.isArray(v) ? v : []} onChange={(x) => set(path, x)} disabled={disabled} />; break;
    default: control = <Input {...common} type={w === 'email' ? 'email' : w === 'url' ? 'url' : 'text'} value={typeof v === 'string' ? v : v === undefined ? '' : String(v)} placeholder={s.default !== undefined ? String(s.default) : undefined} onChange={(e) => set(path, e.target.value)} invalid={!!error} />;
  }
  return (
    <div data-field={path}>
      <Field label={label} help={s.description} error={error} htmlFor={id} inline={w === 'switch' || w === 'select' || w === 'radio' || w === 'number'} required={required} locked={disabled ? lockedReason : undefined}>
        {control}
      </Field>
      {error && <span id={`${id}-err`} className="sr-only">{error}</span>}
    </div>
  );
}

export function SecretInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void; id?: string; disabled?: boolean; invalid?: boolean; placeholder?: string }): React.ReactElement {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input {...rest} type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} className="font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
      <IconButton icon={shown ? 'eye-off' : 'eye'} label={shown ? 'Hide' : 'Show'} size="sm" onClick={() => setShown((s) => !s)} />
    </div>
  );
}

function ListInput({ id, schema, value, onChange, disabled }: { id: string; schema: JsonSchema; value: unknown[]; onChange: (v: unknown[]) => void; disabled?: boolean }): React.ReactElement {
  const [draft, setDraft] = useState('');
  const item = schema.items ?? { type: 'string' };
  const add = () => { const t = draft.trim(); if (!t) return; onChange([...value, coerce(item, t)]); setDraft(''); };
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((x, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md bg-hx-pill py-0.5 pl-2 pr-1 text-[12px]">
              {String(x)}
              <button type="button" disabled={disabled} aria-label={`Remove ${String(x)}`} className="text-hx-muted hover:text-hx-danger" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input id={id} disabled={disabled} value={draft} placeholder="Add an item" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button disabled={disabled || !draft.trim()} onClick={add}>Add</Button>
      </div>
    </div>
  );
}
