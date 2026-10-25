/**
 * The page-level building blocks every view uses, so pages look and behave the same: Page (the
 * scrolling column, its width, the title row with actions), PageState (loading, failed with a retry,
 * empty), Section (a titled group on a page) and ListRow (one clickable row of a list: icon, title,
 * a line under it, what sits at its end). A page that needs something these do not cover adds it
 * here, not in its own markup (test/ui-standards.test.ts holds the app to that).
 */

import React from 'react';
import { Icon } from '../icons.tsx';
import { Button, EmptyState, Spinner, cx } from './primitives.tsx';

const WIDTH = { narrow: 'max-w-2xl', normal: 'max-w-3xl', wide: 'max-w-5xl', full: 'max-w-none' } as const;

export interface PageProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  /** A line under the title (a path, a count, what the page is for). */
  subtitle?: React.ReactNode;
  /** At the end of the title row: the page's buttons. */
  actions?: React.ReactNode;
  /** Before the title (a back button, an icon). */
  lead?: React.ReactNode;
  width?: keyof typeof WIDTH;
}

/** A page: it scrolls, its column is centred at a standard width, its title row is the same everywhere. */
export function Page({ title, subtitle, actions, lead, width = 'normal', className, children, ...rest }: PageProps): React.ReactElement {
  return (
    <div className="hx-scroll h-full overflow-y-auto" {...rest}>
      <div className={cx('mx-auto px-4 py-8 sm:px-6', WIDTH[width], className)}>
        {(title || actions) && (
          <header className="mb-5 flex items-center gap-3" data-page-header>
            {lead}
            <div className="min-w-0 flex-1">
              {title && <h1 className="truncate text-[20px] font-semibold text-hx-primary">{title}</h1>}
              {subtitle && <div className="break-words text-[12.5px] text-hx-muted" data-page-subtitle>{subtitle}</div>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2" data-page-actions>{actions}</div>}
          </header>
        )}
        {children}
      </div>
    </div>
  );
}

export type PageStateProps =
  | { kind: 'loading'; title?: string }
  | { kind: 'error'; title?: string; detail?: React.ReactNode; onRetry?: () => void; action?: React.ReactNode }
  | { kind: 'empty'; icon?: string; title: string; detail?: React.ReactNode; action?: React.ReactNode };

/** What a page or a part of one shows instead of its content: loading, failed (with what to do), or nothing yet. */
export function PageState(p: PageStateProps): React.ReactElement {
  if (p.kind === 'loading') {
    return <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-[13px] text-hx-muted" data-state="loading"><Spinner size={20} />{p.title}</div>;
  }
  if (p.kind === 'error') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-state="error" role="alert">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-hx-danger/10 text-hx-danger"><Icon name="alert" size={20} /></div>
        <div className="text-[14px] font-medium text-hx-primary">{p.title ?? 'This could not be loaded'}</div>
        {p.detail && <div className="max-w-md break-words text-[13px] text-hx-muted">{p.detail}</div>}
        {(p.onRetry || p.action) && <div className="mt-2 flex gap-2">{p.onRetry && <Button icon="refresh" onClick={p.onRetry}>Try again</Button>}{p.action}</div>}
      </div>
    );
  }
  return <div data-state="empty"><EmptyState icon={p.icon} title={p.title} action={p.action}>{p.detail}</EmptyState></div>;
}

/** A titled group on a page. */
export function Section({ title, actions, children, className, ...rest }: Omit<React.HTMLAttributes<HTMLElement>, 'title'> & { title?: React.ReactNode; actions?: React.ReactNode }): React.ReactElement {
  return (
    <section className={cx('mb-6', className)} {...rest}>
      {(title || actions) && (
        <div className="mb-2 flex items-center gap-2">
          {title && <h2 className="flex-1 text-[12px] font-medium uppercase tracking-wide text-hx-muted">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export interface ListRowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon?: string | React.ReactNode;
  title: React.ReactNode;
  /** A line under the title. */
  subtitle?: React.ReactNode;
  /** At the end: a date, a count, a badge. */
  meta?: React.ReactNode;
  active?: boolean;
  /** A bordered card row (lists of things on a page) instead of a plain one (menus, short lists). */
  card?: boolean;
}

/** One clickable row of a list. */
export function ListRow({ icon, title, subtitle, meta, active, card, className, type, ...rest }: ListRowProps): React.ReactElement {
  return (
    <button type={type ?? 'button'} aria-current={active ? 'true' : undefined}
      className={cx('flex w-full items-center gap-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hx-focus disabled:opacity-50',
        card ? 'rounded-xl border border-hx-border-subtle bg-hx-elevated px-3.5 py-3 hover:border-hx-border' : 'rounded-lg px-2 py-1.5 hover:bg-hx-hover',
        active && 'bg-hx-active', className)} {...rest}>
      {typeof icon === 'string' ? <Icon name={icon} size={15} className="shrink-0 text-hx-muted" /> : icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-hx-primary">{title}</span>
        {subtitle && <span className="block truncate text-[11.5px] text-hx-muted">{subtitle}</span>}
      </span>
      {meta !== undefined && <span className="shrink-0 text-[11.5px] text-hx-muted">{meta}</span>}
    </button>
  );
}
