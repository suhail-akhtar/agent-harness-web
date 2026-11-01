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

/**
 * One column width for every page of lists, cards and settings (moving between pages never moves the content's
 * edge), a narrow one for a single form or an about page, a wide one for dashboards and galleries.
 */
const WIDTH = { narrow: 'max-w-2xl', normal: 'max-w-5xl', wide: 'max-w-6xl', full: 'max-w-none' } as const;

export interface PageProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  /** A line under the title (a path, a count, what the page is for). */
  subtitle?: React.ReactNode;
  /** At the end of the title row: the page's buttons. */
  actions?: React.ReactNode;
  /** Before the title (a back button). */
  lead?: React.ReactNode;
  /** The page's icon, on a tile before the title (a module's home). */
  icon?: string;
  width?: keyof typeof WIDTH;
}

/** A page: it scrolls, its column is centred at a standard width, its title row is the same everywhere. */
export function Page({ title, subtitle, actions, lead, icon, width = 'normal', className, children, ...rest }: PageProps): React.ReactElement {
  return (
    <div className="hx-scroll h-full overflow-y-auto" {...rest}>
      <div className={cx('mx-auto px-6 pb-12 pt-8 sm:px-8', WIDTH[width], className)}>
        {(title || actions) && <PageHeader title={title} subtitle={subtitle} actions={actions} lead={lead} icon={icon} />}
        {children}
      </div>
    </div>
  );
}

/** A page's title row: an optional icon tile, the title, a line under it, and the page's buttons at its end. */
export function PageHeader({ title, subtitle, actions, lead, icon }: Pick<PageProps, 'title' | 'subtitle' | 'actions' | 'lead' | 'icon'>): React.ReactElement {
  return (
    <header className="mb-7 flex items-center gap-3" data-page-header>
      {lead}
      {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-hx-accent-soft text-hx-accent-text"><Icon name={icon} size={20} /></span>}
      <div className="min-w-0 flex-1">
        {title && <h1 className="truncate text-heading font-semibold text-hx-primary">{title}</h1>}
        {subtitle && <div className="mt-0.5 break-words text-body text-hx-muted" data-page-subtitle>{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2" data-page-actions>{actions}</div>}
    </header>
  );
}

export type PageStateProps =
  | { kind: 'loading'; title?: string }
  | { kind: 'error'; title?: string; detail?: React.ReactNode; onRetry?: () => void; action?: React.ReactNode }
  | { kind: 'empty'; icon?: string; title: string; detail?: React.ReactNode; action?: React.ReactNode };

/** What a page or a part of one shows instead of its content: loading, failed (with what to do), or nothing yet. */
export function PageState(p: PageStateProps): React.ReactElement {
  if (p.kind === 'loading') {
    return <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-body text-hx-muted" data-state="loading"><Spinner size={20} />{p.title}</div>;
  }
  if (p.kind === 'error') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-state="error" role="alert">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-hx-danger-soft text-hx-danger"><Icon name="alert" size={20} /></div>
        <div className="text-body-lg font-medium text-hx-primary">{p.title ?? 'This could not be loaded'}</div>
        {p.detail && <div className="max-w-md break-words text-body text-hx-muted">{p.detail}</div>}
        {(p.onRetry || p.action) && <div className="mt-2 flex gap-2">{p.onRetry && <Button icon="refresh" onClick={p.onRetry}>Try again</Button>}{p.action}</div>}
      </div>
    );
  }
  return <div data-state="empty"><EmptyState icon={p.icon} title={p.title} action={p.action}>{p.detail}</EmptyState></div>;
}

/**
 * A titled group on a page or in a dialog: the one section heading (a small uppercase label), an optional line
 * under it, a count, and its buttons at the end. Sections stand 32px apart on a page (`dense`: 20px, in dialogs).
 */
export function Section({ title, description, count, actions, dense, children, className, ...rest }: Omit<React.HTMLAttributes<HTMLElement>, 'title'> & { title?: React.ReactNode; description?: React.ReactNode; count?: number; actions?: React.ReactNode; dense?: boolean }): React.ReactElement {
  return (
    <section className={cx(dense ? 'mb-5' : 'mb-8', className)} {...rest}>
      {(title || actions) && (
        <div className={cx('flex min-h-7 items-center gap-2', description ? 'mb-1' : 'mb-2.5')}>
          {title && <h2 className="flex-1 text-tiny font-semibold uppercase tracking-wide text-hx-muted">{title}{count !== undefined && <span className="ml-1.5 font-medium normal-case tracking-normal text-hx-muted">{count}</span>}</h2>}
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {description && <p className="mb-2.5 text-small text-hx-muted">{description}</p>}
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
        <span className="block truncate text-body text-hx-primary">{title}</span>
        {subtitle && <span className="block truncate text-caption text-hx-muted">{subtitle}</span>}
      </span>
      {meta !== undefined && <span className="shrink-0 text-caption text-hx-muted">{meta}</span>}
    </button>
  );
}
