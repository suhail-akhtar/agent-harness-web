/**
 * Components for plugin pages, in plain DOM (no framework, nothing to bundle): each returns an element
 * with the UI kit's classes (kit.css), so a page built from them looks like the app and follows its
 * theme. Text is always set as text, never parsed as HTML.
 *
 *   const { ui } = HarnessPluginUI;
 *   ui.mount(document.body, ui.page({ title: 'Reading list', actions: [ui.button('Add', { kind: 'primary', onClick: add })] },
 *     ui.table({ columns: [{ key: 'url', label: 'Link' }, { key: 'savedAt', label: 'Saved', render: (r) => ui.relTime(r.savedAt) }], rows })));
 *
 * docs/plugin-sdk/UI.md has every component with an example.
 */

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string; dataset?: Record<string, string> };
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral';

const doc = () => (globalThis as unknown as { document: Document }).document;

function append(el: Element, kids: Child[]): void {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(typeof k === 'string' || typeof k === 'number' ? String(k) : k);
  }
}

/** An element: h('div', { class: 'hx-row', onClick: f, title: 'x' }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = doc().createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.assign(el.style, v); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (/^on[A-Z]/.test(k) && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'value' && 'value' in el) (el as unknown as { value: string }).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as unknown as { checked: boolean }).checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

const cls = (...xs: Array<string | false | undefined>) => xs.filter(Boolean).join(' ');

/** Replaces what `root` shows. */
export function mount(root: Element, ...nodes: Child[]): void { root.replaceChildren(); append(root, nodes); }

/**
 * A part of the page that draws itself again when its state changes:
 *   const view = ui.view(root, { tab: 'all' }, (s, set) => ui.tabs(..., s.tab, (tab) => set({ tab })));
 *   view.set({ items }); view.refresh();
 */
export function view<S extends object>(root: Element, initial: S, render: (state: S, set: (patch: Partial<S>) => void) => Child): { state: S; set(patch: Partial<S>): void; refresh(): void } {
  const v = {
    state: { ...initial },
    set(patch: Partial<S>) { Object.assign(v.state, patch); v.refresh(); },
    refresh() { mount(root, render(v.state, v.set)); },
  };
  v.refresh();
  return v;
}

/** The page: a title, a line under it, actions on the right, then the content. */
export function page(o: { title: string; subtitle?: string; actions?: Child[]; wide?: boolean }, ...children: Child[]): HTMLElement {
  doc().body?.classList.add('hx');
  return h('main', { class: cls('hx-page', o.wide && 'hx-wide') },
    h('header', { class: 'hx-header' }, h('div', { class: 'hx-grow' }, h('h1', { class: 'hx-h1' }, o.title), o.subtitle ? h('div', { class: 'hx-muted' }, o.subtitle) : null), o.actions?.length ? h('div', { class: 'hx-row' }, o.actions) : null),
    children);
}

export function section(title: string | null, ...children: Child[]): HTMLElement {
  return h('section', { class: 'hx-section' }, title ? h('h2', { class: 'hx-h2' }, title) : null, children);
}

export function card(o: { title?: string; onClick?: () => void } | null, ...children: Child[]): HTMLElement {
  return h('div', { class: cls('hx-card', o?.onClick && 'hx-interactive'), onClick: o?.onClick, ...(o?.onClick ? { role: 'button', tabindex: '0' } : {}) }, o?.title ? h('div', { class: 'hx-h3' }, o.title) : null, children);
}

export function grid(o: { min?: number } | null, ...children: Child[]): HTMLElement {
  return h('div', { class: 'hx-grid', style: o?.min ? `--hx-min:${o.min}px` : undefined }, children);
}

export function row(...children: Child[]): HTMLElement { return h('div', { class: 'hx-row hx-wrap' }, children); }

/** A number with its label: stat({ label: 'Open', value: 12, delta: '+3 today', tone: 'success' }). */
export function stat(o: { label: string; value: string | number; delta?: string; tone?: Tone }): HTMLElement {
  return h('div', { class: 'hx-card hx-stat' }, h('span', { class: 'hx-stat-label' }, o.label), h('span', { class: 'hx-stat-value' }, typeof o.value === 'number' ? fmtNumber(o.value) : o.value), o.delta ? h('span', { class: 'hx-stat-delta', style: o.tone ? `color: var(--hx-${o.tone === 'accent' ? 'accent-text' : o.tone})` : undefined }, o.delta) : null);
}

export function button(label: string, o: { kind?: 'primary' | 'ghost' | 'danger' | 'default'; size?: 'sm'; onClick?: (e: Event) => void; disabled?: boolean; title?: string; type?: 'button' | 'submit' } = {}): HTMLButtonElement {
  return h('button', { type: o.type ?? 'button', class: cls('hx-btn', o.kind && o.kind !== 'default' && `hx-${o.kind}`, o.size && `hx-${o.size}`), onClick: o.onClick, disabled: o.disabled, title: o.title }, label);
}

export function badge(text: string, tone: Tone = 'neutral'): HTMLElement { return h('span', { class: cls('hx-badge', tone !== 'neutral' && `hx-${tone}`) }, text); }

export function callout(text: Child, tone?: Exclude<Tone, 'accent' | 'neutral'>): HTMLElement { return h('div', { class: cls('hx-callout', tone && `hx-${tone}`), role: tone === 'danger' ? 'alert' : undefined }, text); }

/** What a page shows with nothing in it: what it is, and what to do. */
export function empty(o: { title: string; detail?: string; action?: HTMLElement }): HTMLElement {
  return h('div', { class: 'hx-empty' }, h('div', { class: 'hx-empty-title' }, o.title), o.detail ? h('div', null, o.detail) : null, o.action ? h('div', { style: 'margin-top:8px' }, o.action) : null);
}

export function loading(text = 'Loading…'): HTMLElement { return h('div', { class: 'hx-loading', role: 'status' }, h('span', { class: 'hx-spinner' }), text); }

/** An error the person can act on, with a retry when given. */
export function error(e: unknown, retry?: () => void): HTMLElement {
  const msg = e instanceof Error ? e.message : String(e);
  return h('div', { class: 'hx-callout hx-danger', role: 'alert' }, h('div', { class: 'hx-grow' }, msg), retry ? button('Try again', { size: 'sm', onClick: retry }) : null);
}

export function progress(value: number): HTMLElement {
  const v = Math.max(0, Math.min(1, value));
  return h('div', { class: 'hx-progress', role: 'progressbar', 'aria-valuenow': String(Math.round(v * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { style: `width:${v * 100}%` }));
}

export interface Column<R> { key: string; label: string; num?: boolean; render?: (row: R) => Child; sort?: boolean | ((a: R, b: R) => number); width?: string }

/** A table, sortable by the columns that say so; rows clickable with onRowClick. */
export function table<R extends Record<string, unknown>>(o: { columns: Column<R>[]; rows: R[]; onRowClick?: (row: R) => void; empty?: string; sortBy?: { key: string; dir: 'asc' | 'desc' } }): HTMLElement {
  const wrap = h('div', { class: 'hx-table-wrap' });
  let sort = o.sortBy;
  const draw = () => {
    let rows = [...o.rows];
    const col = sort && o.columns.find((c) => c.key === sort!.key);
    if (sort && col) {
      const f = typeof col.sort === 'function' ? col.sort : (a: R, b: R) => compare(a[col.key], b[col.key]);
      rows.sort((a, b) => (sort!.dir === 'asc' ? f(a, b) : f(b, a)));
    }
    const head = h('tr', null, o.columns.map((c) => h('th', {
      class: c.num ? 'hx-num' : undefined, style: c.width ? `width:${c.width}` : undefined,
      ...(c.sort ? { 'data-sort': c.key, 'aria-sort': sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none', onClick: () => { sort = { key: c.key, dir: sort?.key === c.key && sort.dir === 'asc' ? 'desc' : 'asc' }; draw(); } } : {}),
    }, c.label)));
    const body = rows.length
      ? rows.map((r) => h('tr', { class: o.onRowClick ? 'hx-interactive' : undefined, onClick: o.onRowClick ? () => o.onRowClick!(r) : undefined }, o.columns.map((c) => h('td', { class: c.num ? 'hx-num' : undefined }, c.render ? c.render(r) : fmtCell(r[c.key])))))
      : [h('tr', null, h('td', { colspan: String(o.columns.length), class: 'hx-muted', style: 'text-align:center;padding:24px' }, o.empty ?? 'Nothing here yet.'))];
    mount(wrap, h('table', { class: 'hx-table' }, h('thead', null, head), h('tbody', null, body)));
  };
  draw();
  return wrap;
}

/** A list of rows: a title, a detail line, something on the right. */
export function list<T>(items: T[], o: { title: (x: T) => Child; detail?: (x: T) => Child; right?: (x: T) => Child; onClick?: (x: T) => void; empty?: string }): HTMLElement {
  if (!items.length) return empty({ title: o.empty ?? 'Nothing here yet.' });
  return h('ul', { class: 'hx-list' }, items.map((x) => h('li', { class: o.onClick ? 'hx-interactive' : undefined, onClick: o.onClick ? () => o.onClick!(x) : undefined },
    h('div', { class: 'hx-grow', style: 'min-width:0' }, h('div', { class: 'hx-list-title' }, o.title(x)), o.detail ? h('div', { class: 'hx-list-detail' }, o.detail(x)) : null),
    o.right ? h('div', null, o.right(x)) : null)));
}

export function tabs(items: Array<{ id: string; label: string; count?: number }>, active: string, onChange: (id: string) => void): HTMLElement {
  return h('div', { class: 'hx-tabs', role: 'tablist' }, items.map((t) => h('button', { type: 'button', role: 'tab', class: 'hx-tab', 'aria-selected': String(t.id === active), onClick: () => onChange(t.id) }, t.label, t.count !== undefined ? h('span', { class: 'hx-muted', style: 'margin-left:6px' }, String(t.count)) : null)));
}

export interface Field {
  name: string; label: string;
  type?: 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date' | 'email' | 'url' | 'password';
  options?: Array<string | { value: string; label: string }>;
  required?: boolean; help?: string; placeholder?: string; value?: unknown;
  /** A message when the value is not right, or nothing. */
  validate?: (value: unknown, all: Record<string, unknown>) => string | undefined;
}

/** A form: values come back typed (numbers as numbers, checkboxes as booleans); required fields are checked first. */
export function form(o: { fields: Field[]; submitLabel?: string; onSubmit: (values: Record<string, unknown>) => void | Promise<void>; onCancel?: () => void }): HTMLFormElement {
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  const errors = new Map<string, HTMLElement>();
  const fields = o.fields.map((f) => {
    const id = `hx-f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (f.type === 'textarea') input = h('textarea', { id, class: 'hx-textarea', name: f.name, placeholder: f.placeholder, value: f.value === undefined ? undefined : String(f.value) });
    else if (f.type === 'select') input = h('select', { id, class: 'hx-select', name: f.name }, (f.options ?? []).map((x) => { const v = typeof x === 'string' ? { value: x, label: x } : x; return h('option', { value: v.value, selected: String(f.value ?? '') === v.value }, v.label); }));
    else if (f.type === 'checkbox') input = h('input', { id, type: 'checkbox', name: f.name, checked: !!f.value });
    else input = h('input', { id, class: 'hx-input', type: f.type ?? 'text', name: f.name, placeholder: f.placeholder, value: f.value === undefined ? undefined : String(f.value), required: f.required });
    inputs.set(f.name, input);
    const err = h('div', { class: 'hx-error', hidden: true });
    errors.set(f.name, err);
    if (f.type === 'checkbox') return h('div', { class: 'hx-field' }, h('label', { class: 'hx-check', for: id }, input, f.label), f.help ? h('div', { class: 'hx-help' }, f.help) : null, err);
    return h('div', { class: 'hx-field' }, h('label', { for: id }, f.label, f.required ? ' *' : ''), input, f.help ? h('div', { class: 'hx-help' }, f.help) : null, err);
  });
  const read = () => Object.fromEntries(o.fields.map((f) => {
    const i = inputs.get(f.name)!;
    if (f.type === 'checkbox') return [f.name, (i as HTMLInputElement).checked];
    if (f.type === 'number') return [f.name, i.value === '' ? undefined : Number(i.value)];
    return [f.name, i.value];
  }));
  const submit = button(o.submitLabel ?? 'Save', { kind: 'primary', type: 'submit' });
  const el = h('form', {
    onSubmit: async (e: Event) => {
      e.preventDefault();
      const values = read();
      let bad = false;
      for (const f of o.fields) {
        const v = values[f.name];
        const msg = f.required && (v === '' || v === undefined) ? `${f.label} is required.` : f.type === 'number' && typeof v === 'number' && Number.isNaN(v) ? `${f.label} must be a number.` : f.validate?.(v, values);
        const err = errors.get(f.name)!;
        err.hidden = !msg; err.textContent = msg ?? '';
        if (msg) bad = true;
      }
      if (bad) return;
      submit.disabled = true;
      try { await o.onSubmit(values); } finally { submit.disabled = false; }
    },
  }, fields, h('div', { class: 'hx-row', style: 'justify-content:flex-end;margin-top:4px' }, o.onCancel ? button('Cancel', { kind: 'ghost', onClick: o.onCancel }) : null, submit));
  return el;
}

/** A dialog over the page; close() removes it (Escape and a click outside close it too). */
export function dialog(o: { title: string; body: Child; actions?: HTMLElement[]; onClose?: () => void }): { close(): void } {
  const close = () => { scrim.remove(); doc().removeEventListener('keydown', key); o.onClose?.(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'hx-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title }, h('h2', { class: 'hx-h2' }, o.title), o.body, o.actions?.length ? h('div', { class: 'hx-actions' }, o.actions) : null);
  const scrim = h('div', { class: 'hx-dialog-scrim', onClick: (e: Event) => { if (e.target === scrim) close(); } }, box);
  doc().addEventListener('keydown', key);
  doc().body.append(scrim);
  (box.querySelector('input,select,textarea,button') as HTMLElement | null)?.focus();
  return { close };
}

/** Asks yes or no: resolves true for the confirming button. */
export function confirm(o: { title: string; text?: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v: boolean) => { if (answered) return; answered = true; d.close(); resolve(v); };
    const d = dialog({ title: o.title, body: o.text ? h('p', { class: 'hx-muted', style: 'margin:0' }, o.text) : null, onClose: () => done(false), actions: [button('Cancel', { kind: 'ghost', onClick: () => done(false) }), button(o.confirm ?? 'OK', { kind: o.danger ? 'danger' : 'primary', onClick: () => done(true) })] });
  });
}

export function fmtNumber(n: number, o: Intl.NumberFormatOptions = {}): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, ...o }).format(n); }

/** "3 min ago", "in 2 days": a date, a timestamp or an ISO string. */
export function relTime(when: string | number | Date, now = Date.now()): string {
  const t = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((t - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const [unit, size] = units.find(([, n]) => Math.abs(s) >= n) ?? ['second', 1];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(s / size), unit);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const ui = { h, mount, view, page, section, card, grid, row, stat, button, badge, callout, empty, loading, error, progress, table, list, tabs, form, dialog, confirm, fmtNumber, relTime };
