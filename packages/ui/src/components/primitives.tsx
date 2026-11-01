/**
 * The small controls everything else is built from. Styled with the `hx` Tailwind colours
 * (CSS variables from the theme builder), so they follow any theme a plugin brings.
 */

import React, { forwardRef, useId } from 'react';
import { Icon } from '../icons.tsx';

export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  iconRight?: string;
  loading?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-hx-accent text-hx-on-accent hover:bg-hx-accent-hover border border-transparent disabled:bg-hx-pill disabled:text-hx-muted disabled:opacity-100',
  secondary: 'bg-hx-elevated text-hx-primary border border-hx-border hover:bg-hx-hover',
  ghost: 'bg-transparent text-hx-secondary border border-transparent hover:bg-hx-hover hover:text-hx-primary',
  subtle: 'bg-hx-pill text-hx-primary border border-transparent hover:bg-hx-active',
  danger: 'bg-hx-danger text-white border border-transparent hover:opacity-90 disabled:bg-hx-pill disabled:text-hx-muted disabled:opacity-100',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-small gap-1.5 rounded-md',
  md: 'h-8 px-3 text-body gap-1.5 rounded-lg',
  lg: 'h-10 px-4 text-body-lg gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, iconRight, loading, className, children, disabled, type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={cx('inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hx-focus disabled:cursor-not-allowed disabled:opacity-50', VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 15} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 14 : 15} />}
    </button>
  );
});

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  /** Accessible name and tooltip. Required: an icon-only control must say what it does. */
  label: string;
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
  tone?: 'default' | 'danger' | 'accent';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, size = 'md', active, tone = 'default', className, type, ...rest }, ref) {
  const dim = size === 'xs' ? 'h-6 w-6' : size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hx-focus disabled:opacity-40',
        dim, active ? 'bg-hx-active text-hx-primary' : tone === 'danger' ? 'text-hx-muted hover:bg-hx-hover hover:text-hx-danger' : tone === 'accent' ? 'text-hx-accent-text hover:bg-hx-accent-soft' : 'text-hx-muted hover:bg-hx-hover hover:text-hx-primary', className)}
      {...rest}
    >
      <Icon name={icon} size={size === 'xs' ? 14 : 16} />
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { icon?: string; invalid?: boolean }>(function Input({ className, icon, invalid, ...rest }, ref) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx('h-8 w-full min-w-0 rounded-lg border bg-hx-bg px-2.5 text-body text-hx-primary placeholder:text-hx-muted focus:outline-none focus:ring-2 focus:ring-hx-focus disabled:opacity-60',
        invalid ? 'border-hx-danger' : 'border-hx-border', icon && 'pl-8', className)}
      {...rest}
    />
  );
  if (!icon) return input;
  return (
    <div className="relative w-full">
      <Icon name={icon} size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-hx-muted" />
      {input}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx('w-full min-w-0 rounded-lg border bg-hx-bg px-2.5 py-2 text-body leading-5 text-hx-primary placeholder:text-hx-muted focus:outline-none focus:ring-2 focus:ring-hx-focus', invalid ? 'border-hx-danger' : 'border-hx-border', className)}
      {...rest}
    />
  );
});

export interface SelectOption { value: string; label: string; disabled?: boolean }
export function Select({ value, onChange, options, className, ...rest }: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & { value: string; onChange: (v: string) => void; options: SelectOption[] }): React.ReactElement {
  return (
    <div className={cx('relative', className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full appearance-none rounded-lg border border-hx-border bg-hx-bg pl-2.5 pr-7 text-body text-hx-primary focus:outline-none focus:ring-2 focus:ring-hx-focus"
        {...rest}
      >
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
      <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-hx-muted" />
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; id?: string }): React.ReactElement {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hx-focus disabled:opacity-50', checked ? 'bg-hx-accent' : 'bg-hx-active')}
    >
      <span className={cx('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

export function Checkbox({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; disabled?: boolean; className?: string }): React.ReactElement {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-body text-hx-primary', disabled && 'cursor-not-allowed opacity-60', className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--hx-accent)]" />
      {label}
    </label>
  );
}

/**
 * Several checkboxes for picking some of a list (tools, servers, skills): a label each, an optional hint under
 * it, in one or two columns. `name` marks the group (data-checks) and each box its id (data-check).
 */
export function CheckboxGroup({ items, value, onChange, name, cols = 2, mono }: { items: Array<{ id: string; label: React.ReactNode; hint?: string }>; value: string[]; onChange: (v: string[]) => void; name?: string; cols?: 1 | 2; mono?: boolean }): React.ReactElement {
  return (
    <div role="group" aria-label={name} className={cx('grid gap-x-4 gap-y-1.5', cols === 2 && 'sm:grid-cols-2')} data-checks={name}>
      {items.map((i) => (
        <label key={i.id} className="flex cursor-pointer items-start gap-2 rounded-md py-0.5 text-small text-hx-primary" title={i.hint}>
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--hx-accent)]" checked={value.includes(i.id)} onChange={(e) => onChange(e.target.checked ? [...value, i.id] : value.filter((x) => x !== i.id))} data-check={i.id} />
          <span className="min-w-0"><span className={cx(mono && 'font-mono text-small')}>{i.label}</span>{i.hint && <span className="block truncate text-caption text-hx-muted">{i.hint}</span>}</span>
        </label>
      ))}
    </div>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cx('hx-spin shrink-0', className)} aria-label="Loading" role="status">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A key or a key chord, e.g. <Kbd keys="Ctrl+K" />. */
export function Kbd({ keys, className }: { keys: string; className?: string }): React.ReactElement {
  const parts = keys.split('+').filter(Boolean);
  return (
    <span className={cx('inline-flex items-center gap-0.5', className)}>
      {parts.map((p, i) => (
        <kbd key={i} className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-hx-border bg-hx-surface px-1 font-sans text-micro font-medium text-hx-secondary">{p}</kbd>
      ))}
    </span>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; className?: string }): React.ReactElement {
  const t = { neutral: 'bg-hx-pill text-hx-secondary', accent: 'bg-hx-accent-soft text-hx-accent-text', success: 'bg-hx-success-soft text-hx-success', warning: 'bg-hx-warning-soft text-hx-warning', danger: 'bg-hx-danger-soft text-hx-danger', info: 'bg-hx-info-soft text-hx-info' }[tone];
  return <span className={cx('inline-flex h-5 items-center rounded-full px-2 text-tiny font-medium', t, className)}>{children}</span>;
}

/**
 * Nothing here yet, and what to do about it. page: a whole page or panel (centred, large); section: inside a
 * section (a dashed box); inline: one muted line.
 */
export function EmptyState({ icon = 'sparkles', title, children, action, variant = 'page' }: { icon?: string; title: string; children?: React.ReactNode; action?: React.ReactNode; variant?: 'page' | 'section' | 'inline' }): React.ReactElement {
  if (variant === 'inline') return <p className="text-body text-hx-muted" data-empty>{title}{children ? <> {children}</> : null}</p>;
  if (variant === 'section') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-dashed border-hx-border p-4" data-empty>
        <Icon name={icon} size={16} className="mt-0.5 shrink-0 text-hx-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-hx-primary">{title}</div>
          {children && <div className="mt-0.5 text-small text-hx-muted">{children}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-empty>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-hx-pill text-hx-muted"><Icon name={icon} size={20} /></div>
      <div className="text-body-lg font-medium text-hx-primary">{title}</div>
      {children && <div className="max-w-md text-body text-hx-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A labelled form row: label, the control, help text and an error. */
export function Field({ label, help, error, children, htmlFor, inline, required, locked }: { label: React.ReactNode; help?: React.ReactNode; error?: string; children: React.ReactNode; htmlFor?: string; inline?: boolean; required?: boolean; locked?: string }): React.ReactElement {
  const auto = useId();
  const id = htmlFor ?? auto;
  return (
    <div className={cx('py-2.5', inline ? 'flex items-center justify-between gap-6' : 'flex flex-col gap-1.5')}>
      <div className="min-w-0">
        <label htmlFor={id} className="block text-body font-medium text-hx-primary">
          {label}{required && <span className="ml-0.5 text-hx-danger">*</span>}
          {locked && <span className="ml-2 inline-flex items-center gap-1 text-tiny font-normal text-hx-muted" title={locked}><Icon name="lock" size={11} />{locked}</span>}
        </label>
        {help && <div className="mt-0.5 text-small leading-[18px] text-hx-muted">{help}</div>}
      </div>
      <div className={cx(inline ? 'shrink-0' : 'w-full')}>{children}</div>
      {error && <div role="alert" className="text-small text-hx-danger">{error}</div>}
    </div>
  );
}

export interface TabItem { id: string; label: React.ReactNode; icon?: string; count?: number }
export function Tabs({ tabs, value, onChange, className, size = 'md' }: { tabs: TabItem[]; value: string; onChange: (id: string) => void; className?: string; size?: 'sm' | 'md' }): React.ReactElement {
  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    if (e.key === 'ArrowRight') { e.preventDefault(); onChange(tabs[(i + 1) % tabs.length]!.id); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(tabs[(i - 1 + tabs.length) % tabs.length]!.id); }
  };
  return (
    <div role="tablist" onKeyDown={onKey} className={cx('inline-flex items-center gap-0.5 rounded-lg bg-hx-pill p-0.5', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={cx('inline-flex items-center gap-1.5 rounded-md font-medium transition-colors', size === 'sm' ? 'h-6 px-2 text-small' : 'h-7 px-2.5 text-small',
            t.id === value ? 'bg-hx-elevated text-hx-primary shadow-sm' : 'text-hx-muted hover:text-hx-primary')}
        >
          {t.icon && <Icon name={t.icon} size={13} />}
          {t.label}
          {t.count !== undefined && <span className="text-tiny text-hx-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export interface ActionPanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The small uppercase label (Approval, Question, Permission). */
  label?: React.ReactNode;
  icon?: string;
  title?: React.ReactNode;
  /** The decision: always in view, under the details. */
  footer?: React.ReactNode;
  tone?: 'warning' | 'accent' | 'neutral' | 'danger';
  /** The tallest it gets before the details scroll (CSS length). */
  maxHeight?: string;
}

/**
 * Something inline that waits for a decision (an approval, a question, a permission): the inline
 * counterpart of Modal. Label and title stay at the top and the footer at the bottom; only the
 * details scroll, so the person always sees what they are deciding and how to decide it.
 */
export function ActionPanel({ label, icon, title, footer, tone = 'warning', maxHeight = 'min(60vh, 560px)', className, style, children, ...rest }: ActionPanelProps): React.ReactElement {
  const border = { warning: 'border-hx-warning-border', accent: 'border-hx-accent-border', neutral: 'border-hx-border-subtle', danger: 'border-hx-danger-border' }[tone];
  const text = { warning: 'text-hx-warning', accent: 'text-hx-accent-text', neutral: 'text-hx-muted', danger: 'text-hx-danger' }[tone];
  return (
    <div className={cx('flex flex-col overflow-hidden rounded-xl border bg-hx-elevated shadow-sm', border, className)} style={{ maxHeight, ...style }} {...rest}>
      {(label || title) && (
        <div className="shrink-0 px-3 pt-3" data-panel-head>
          {label && <div className={cx('flex items-center gap-1.5 text-tiny font-semibold uppercase tracking-wide', text)}>{icon && <Icon name={icon} size={13} />}{label}</div>}
          {title && <div className="mt-1 text-body-lg font-semibold text-hx-primary">{title}</div>}
        </div>
      )}
      <div className={cx('hx-scroll min-h-0 flex-1 overflow-y-auto px-3 pt-1', footer ? 'pb-2' : 'pb-3')} data-panel-body>{children}</div>
      {footer && <div className="shrink-0 border-t border-hx-border-subtle px-3 py-2" data-panel-footer>{footer}</div>}
    </div>
  );
}

export function Divider({ className }: { className?: string }): React.ReactElement {
  return <div role="separator" className={cx('h-px w-full bg-hx-border-subtle', className)} />;
}
