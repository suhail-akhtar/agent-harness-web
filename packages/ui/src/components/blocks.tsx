/**
 * The design system's building blocks between a control and a page: cards, stat tiles, callouts, choice
 * groups, option cards, meta lines, status dots and icon tiles. Every page draws these the same way from
 * here (docs/desktop/DESIGN-SYSTEM.md); a page never makes its own copy (test/ui-standards.test.ts).
 *
 * Tones are one map for the whole app: accent (the app's own colour, selection), success (done, healthy),
 * warning (needs the person), danger (failed, destructive), info (neutral news), neutral.
 */

import React, { useRef } from 'react';
import { Icon } from '../icons.tsx';
import { cx } from './primitives.tsx';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** Text, fill and border classes for a tone (tokens only: never an opacity a page makes up). */
export const TONE: Record<Tone, { text: string; soft: string; border: string; solid: string }> = {
  neutral: { text: 'text-hx-secondary', soft: 'bg-hx-pill', border: 'border-hx-border', solid: 'bg-hx-muted' },
  accent: { text: 'text-hx-accent-text', soft: 'bg-hx-accent-soft', border: 'border-hx-accent-border', solid: 'bg-hx-accent' },
  success: { text: 'text-hx-success', soft: 'bg-hx-success-soft', border: 'border-hx-success-border', solid: 'bg-hx-success' },
  warning: { text: 'text-hx-warning', soft: 'bg-hx-warning-soft', border: 'border-hx-warning-border', solid: 'bg-hx-warning' },
  danger: { text: 'text-hx-danger', soft: 'bg-hx-danger-soft', border: 'border-hx-danger-border', solid: 'bg-hx-danger' },
  info: { text: 'text-hx-info', soft: 'bg-hx-info-soft', border: 'border-hx-info-border', solid: 'bg-hx-info' },
};

/**
 * The tone of a status word, the same everywhere: working is accent (the app at work), waiting is warning
 * (needs the person), done is success, failed is danger, the rest neutral.
 */
export function statusTone(status: string | undefined): Tone {
  const s = (status ?? '').toLowerCase();
  if (/^(running|working|started|live|busy|active)$/.test(s)) return 'accent';
  if (/^(waiting|pending|asked|needs|paused|skipped|warn|warning|stopped|interrupted)$/.test(s)) return 'warning';
  if (/^(done|completed|ok|ready|passed|success|healthy|on)$/.test(s)) return 'success';
  if (/^(failed|error|refused|denied|down|danger|broken)$/.test(s)) return 'danger';
  return 'neutral';
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** none (the content pads itself), sm (12px, dense lists) or md (16px, the default). */
  padding?: 'none' | 'sm' | 'md';
  /** It reacts to the pointer (a card that opens something). */
  interactive?: boolean;
  /** Chosen (an option card, the current item). */
  selected?: boolean;
  /** A status card (a warning card, a failed run): its tinted border. */
  tone?: Tone;
  /** Dimmed (switched off). */
  muted?: boolean;
}

/** The one card: a raised surface with a subtle border, 12px corners. */
export function Card({ padding = 'md', interactive, selected, tone, muted, className, children, ...rest }: CardProps): React.ReactElement {
  return (
    <div
      className={cx('rounded-xl border bg-hx-elevated transition-colors', padding === 'sm' ? 'p-3' : padding === 'md' ? 'p-4' : '',
        selected ? 'border-hx-accent-border bg-hx-accent-soft' : tone && tone !== 'neutral' ? TONE[tone].border : 'border-hx-border-subtle',
        interactive && !selected && 'cursor-pointer hover:border-hx-border', muted && 'opacity-70', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A number with what it counts (a KPI on a home page); a click goes where it leads. */
export function StatCard({ label, value, tone, hint, onClick, id }: { label: React.ReactNode; value: React.ReactNode; tone?: Tone; hint?: React.ReactNode; onClick?: () => void; id?: string }): React.ReactElement {
  const body = (
    <>
      <span className={cx('block text-display font-semibold tabular-nums', tone && tone !== 'neutral' ? TONE[tone].text : 'text-hx-primary')}>{value}</span>
      <span className="mt-0.5 block text-small text-hx-muted">{label}</span>
      {hint && <span className="mt-1 block text-caption text-hx-muted">{hint}</span>}
    </>
  );
  const cls = 'block w-full rounded-xl border border-hx-border-subtle bg-hx-elevated p-4 text-left';
  return onClick
    ? <button type="button" data-kpi={id} onClick={onClick} className={cx(cls, 'transition-colors hover:border-hx-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hx-focus')}>{body}</button>
    : <div data-kpi={id} className={cls}>{body}</div>;
}

/** Stat cards in a row (two columns on a narrow window). */
export function StatGrid({ children, cols = 4 }: { children: React.ReactNode; cols?: 3 | 4 }): React.ReactElement {
  return <div className={cx('mb-8 grid grid-cols-2 gap-3', cols === 4 ? 'md:grid-cols-4' : 'md:grid-cols-3')}>{children}</div>;
}

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: Tone;
  title?: React.ReactNode;
  icon?: string;
  /** Buttons at its end (a banner's action). */
  actions?: React.ReactNode;
  /** banner: across its container with its action at the end; inline (default): a note in a form or a list. */
  variant?: 'inline' | 'banner';
  onDismiss?: () => void;
}

const CALLOUT_ICON: Record<Tone, string> = { neutral: 'info', accent: 'sparkles', success: 'check-circle', warning: 'warning', danger: 'alert', info: 'info' };

/** A note that stands out: an error in a form, a warning on a page, a banner that offers something. */
export function Callout({ tone = 'info', title, icon, actions, variant = 'inline', onDismiss, className, children, ...rest }: CalloutProps): React.ReactElement {
  const t = TONE[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'note'} className={cx('flex gap-2.5 rounded-lg border text-body text-hx-primary', t.border, t.soft, variant === 'banner' ? 'items-center px-3.5 py-2.5' : 'items-start px-3 py-2.5', className)} {...rest}>
      <Icon name={icon ?? CALLOUT_ICON[tone]} size={16} className={cx('shrink-0', variant === 'inline' && 'mt-0.5', t.text)} />
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5 text-small text-hx-secondary' : '')}>{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      {onDismiss && <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 rounded p-0.5 text-hx-muted hover:bg-hx-hover hover:text-hx-primary"><Icon name="x" size={14} /></button>}
    </div>
  );
}

export interface ChoiceOption<T extends string> { id: T; label: React.ReactNode; icon?: string; disabled?: boolean }

/**
 * One choice of a few (role radiogroup; arrow keys move it): chips that wrap (many options, the default), or a
 * segmented track (two to four short options). `name` marks it for tests and tools (data-choice); each option
 * says its id (data-value) and whether it is chosen (aria-checked).
 */
export function ChoiceGroup<T extends string>({ name, label, value, options, onChange, variant = 'chips', size = 'md', className }: { name: string; label: string; value: T; options: Array<ChoiceOption<T>>; onChange: (v: T) => void; variant?: 'chips' | 'segmented'; size?: 'sm' | 'md'; className?: string }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const live = options.filter((o) => !o.disabled);
    const i = live.findIndex((o) => o.id === value);
    const next = live[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length];
    if (!next) return;
    onChange(next.id);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.id)}"]`)?.focus());
  };
  const seg = variant === 'segmented';
  return (
    <div ref={box} role="radiogroup" aria-label={label} onKeyDown={onKey} data-choice={name}
      className={cx(seg ? 'inline-flex items-center gap-0.5 rounded-lg bg-hx-pill p-0.5' : 'flex flex-wrap gap-1.5', className)}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={o.disabled} data-value={o.id} onClick={() => onChange(o.id)}
            className={cx('inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hx-focus disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'h-7 px-2.5 text-small' : 'h-8 px-3 text-body',
              seg ? cx('rounded-md', on ? 'bg-hx-elevated text-hx-primary shadow-sm' : 'text-hx-muted hover:text-hx-primary')
                : cx('rounded-lg border', on ? 'border-hx-accent-border bg-hx-accent-soft text-hx-accent-text' : 'border-hx-border text-hx-secondary hover:bg-hx-hover hover:text-hx-primary'))}>
            {o.icon && <Icon name={o.icon} size={14} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface OptionCard<T extends string> { id: T; title: React.ReactNode; detail?: React.ReactNode; icon?: string }

/** One choice of a few, each explained (a radio group drawn as cards): how much an agent may do, a layout. */
export function OptionCards<T extends string>({ name, label, value, options, onChange, cols = 2 }: { name: string; label: string; value: T; options: Array<OptionCard<T>>; onChange: (v: T) => void; cols?: 1 | 2 | 3 }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.id === value);
    const next = options[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]!;
    onChange(next.id);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.id)}"]`)?.focus());
  };
  return (
    <div ref={box} role="radiogroup" aria-label={label} onKeyDown={onKey} data-choice={name} className={cx('grid gap-2', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3')}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-value={o.id} onClick={() => onChange(o.id)}
            className={cx('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hx-focus',
              on ? 'border-hx-accent-border bg-hx-accent-soft' : 'border-hx-border-subtle bg-hx-elevated hover:border-hx-border')}>
            {o.icon && <Icon name={o.icon} size={16} className={cx('mt-0.5 shrink-0', on ? 'text-hx-accent-text' : 'text-hx-muted')} />}
            <span className="min-w-0">
              <span className={cx('block text-body font-medium', on ? 'text-hx-accent-text' : 'text-hx-primary')}>{o.title}</span>
              {o.detail && <span className="mt-0.5 block text-small text-hx-muted">{o.detail}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Facts in one muted line, dot-separated (a model, a count, a time). Empty items are left out. */
export function Meta({ items, className, ...rest }: React.HTMLAttributes<HTMLDivElement> & { items: React.ReactNode[] }): React.ReactElement {
  const shown = items.filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return (
    <div className={cx('flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-hx-muted', className)} {...rest}>
      {shown.map((x, i) => <React.Fragment key={i}>{i > 0 && <span aria-hidden className="text-hx-border">·</span>}<span className="min-w-0">{x}</span></React.Fragment>)}
    </div>
  );
}

/** A small round status light, with its status as its accessible name. */
export function StatusDot({ status, tone, pulse, label }: { status?: string; tone?: Tone; pulse?: boolean; label?: string }): React.ReactElement {
  const t = tone ?? statusTone(status);
  return <span role="img" aria-label={label ?? status ?? t} title={label ?? status} className={cx('inline-block h-2 w-2 shrink-0 rounded-full', TONE[t].solid, pulse && 'animate-pulse')} />;
}

/** An icon on a tinted square: what a card, a module or an item is. */
export function IconTile({ icon, size = 'md', tone = 'accent', className }: { icon: string; size?: 'sm' | 'md' | 'lg'; tone?: Tone; className?: string }): React.ReactElement {
  const dim = { sm: 'h-7 w-7 rounded-md', md: 'h-8 w-8 rounded-lg', lg: 'h-10 w-10 rounded-xl' }[size];
  return <span className={cx('flex shrink-0 items-center justify-center', dim, TONE[tone].soft, TONE[tone].text, className)}><Icon name={icon} size={size === 'lg' ? 20 : size === 'md' ? 16 : 14} /></span>;
}
