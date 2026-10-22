/**
 * Things that float: Popover (anchored, flips to stay on screen), Menu (a popover of actions with
 * keyboard navigation), Tooltip (delayed, never on touch) and Modal (focus trapped, Escape closes).
 * All render into a portal on document.body so a scrolling or clipped parent cannot cut them off.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons.tsx';
import { cx, IconButton, Kbd } from './primitives.tsx';

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start' | 'bottom' | 'top';

/** Where to put a floating box of `size` next to `anchor` inside `viewport` (pure, unit-tested). */
export function place(anchor: { left: number; top: number; right: number; bottom: number; width: number; height: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, placement: Placement, gap = 6): { left: number; top: number; placement: Placement } {
  const [side, align] = placement.split('-') as [string, string | undefined];
  let left = 0; let top = 0; let used = placement;
  const horiz = () => (align === 'end' ? anchor.right - size.width : align === 'start' ? anchor.left : anchor.left + anchor.width / 2 - size.width / 2);
  if (side === 'bottom' || side === 'top') {
    left = horiz();
    top = side === 'bottom' ? anchor.bottom + gap : anchor.top - size.height - gap;
    if (side === 'bottom' && top + size.height > viewport.height - 8 && anchor.top - size.height - gap > 8) { top = anchor.top - size.height - gap; used = (`top${align ? `-${align}` : ''}`) as Placement; }
    if (side === 'top' && top < 8 && anchor.bottom + gap + size.height < viewport.height - 8) { top = anchor.bottom + gap; used = (`bottom${align ? `-${align}` : ''}`) as Placement; }
  } else {
    top = anchor.top;
    left = side === 'right' ? anchor.right + gap : anchor.left - size.width - gap;
    if (side === 'right' && left + size.width > viewport.width - 8) { left = anchor.left - size.width - gap; used = 'left-start'; }
    if (side === 'left' && left < 8) { left = anchor.right + gap; used = 'right-start'; }
  }
  left = Math.max(8, Math.min(left, viewport.width - size.width - 8));
  top = Math.max(8, Math.min(top, viewport.height - size.height - 8));
  return { left, top, placement: used };
}

export function Portal({ children }: { children: React.ReactNode }): React.ReactElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.body), []);
  return el ? createPortal(children, el) : null;
}

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null> | { getBoundingClientRect(): DOMRect };
  placement?: Placement;
  children: React.ReactNode;
  className?: string;
  /** Match the anchor's width (selects, comboboxes). */
  matchWidth?: boolean;
  /** Keep focus where it is (the composer's @ and / menus). */
  noFocus?: boolean;
  role?: string;
  label?: string;
}

export function Popover({ open, onClose, anchor, placement = 'bottom-start', children, className, matchWidth, noFocus, role = 'dialog', label }: PopoverProps): React.ReactElement | null {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width?: number } | null>(null);
  const anchorRect = useCallback(() => {
    const a = 'current' in anchor ? anchor.current : anchor;
    return a?.getBoundingClientRect();
  }, [anchor]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const update = () => {
      const r = anchorRect();
      const el = box.current;
      if (!r || !el) return;
      const p = place(r, { width: matchWidth ? r.width : el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement);
      setPos({ left: p.left, top: p.top, ...(matchWidth ? { width: r.width } : {}) });
    };
    update();
    const ro = new ResizeObserver(update);
    if (box.current) ro.observe(box.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, anchorRect, placement, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t)) return;
      const a = 'current' in anchor ? anchor.current : null;
      if (a && a.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    if (!noFocus) setTimeout(() => (box.current?.querySelector<HTMLElement>('[data-autofocus],input,button,[tabindex="0"]') ?? box.current)?.focus(), 0);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [open, onClose, anchor, noFocus]);

  if (!open) return null;
  return (
    <Portal>
      <div
        ref={box}
        role={role}
        aria-label={label}
        tabIndex={-1}
        style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: pos?.width, zIndex: 60, visibility: pos ? 'visible' : 'hidden' }}
        className={cx('hx-pop-in max-h-[min(70vh,560px)] overflow-auto rounded-xl border border-hx-border bg-hx-elevated p-1 text-hx-primary shadow-[var(--hx-shadow)] outline-none', className)}
      >
        {children}
      </div>
    </Portal>
  );
}

export interface MenuItem {
  id: string;
  label: React.ReactNode;
  icon?: string;
  hint?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
  /** A section heading instead of an item. */
  section?: boolean;
  separator?: boolean;
}

/** A list of actions, navigable with the arrow keys, Home/End and type-ahead. Used inside a Popover or inline. */
export function MenuList({ items, onDone, activeIndex, onActiveIndex, className }: { items: MenuItem[]; onDone?: () => void; activeIndex?: number; onActiveIndex?: (i: number) => void; className?: string }): React.ReactElement {
  const [own, setOwn] = useState(() => items.findIndex((i) => !i.section && !i.separator && !i.disabled));
  const active = activeIndex ?? own;
  const setActive = onActiveIndex ?? setOwn;
  const ref = useRef<HTMLDivElement>(null);
  const selectable = (i: number) => !!items[i] && !items[i]!.section && !items[i]!.separator && !items[i]!.disabled;
  const move = (dir: 1 | -1) => {
    for (let k = 1; k <= items.length; k++) { const j = (active + dir * k + items.length) % items.length; if (selectable(j)) { setActive(j); return; } }
  };
  useEffect(() => { ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={0}
      data-autofocus
      className={cx('outline-none', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Home') { e.preventDefault(); setActive(items.findIndex((_, i) => selectable(i))); }
        else if (e.key === 'End') { e.preventDefault(); for (let i = items.length - 1; i >= 0; i--) if (selectable(i)) { setActive(i); break; } }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const it = items[active]; if (it && selectable(active)) { it.onSelect?.(); onDone?.(); } }
        else if (e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase();
          const j = items.findIndex((it, i) => i > active && selectable(i) && typeof it.label === 'string' && it.label.toLowerCase().startsWith(k));
          const w = j >= 0 ? j : items.findIndex((it, i) => selectable(i) && typeof it.label === 'string' && it.label.toLowerCase().startsWith(k));
          if (w >= 0) setActive(w);
        }
      }}
    >
      {items.map((it, i) => {
        if (it.separator) return <div key={it.id} className="my-1 h-px bg-hx-border-subtle" />;
        if (it.section) return <div key={it.id} className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-hx-muted">{it.label}</div>;
        return (
          <button
            key={it.id}
            type="button"
            role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={it.checked}
            data-index={i}
            disabled={it.disabled}
            onMouseEnter={() => selectable(i) && setActive(i)}
            onClick={() => { it.onSelect?.(); onDone?.(); }}
            className={cx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] disabled:opacity-45',
              i === active && 'bg-hx-hover', it.danger ? 'text-hx-danger' : 'text-hx-primary')}
          >
            {it.icon && <Icon name={it.icon} size={15} className={it.danger ? '' : 'text-hx-secondary'} />}
            <span className="min-w-0 flex-1 truncate">{it.label}{it.hint && <span className="ml-2 text-[12px] text-hx-muted">{it.hint}</span>}</span>
            {it.checked && <Icon name="check" size={14} className="text-hx-accent-text" />}
            {it.shortcut && <Kbd keys={it.shortcut} />}
          </button>
        );
      })}
    </div>
  );
}

/** A button that opens a menu. */
export function Menu({ trigger, items, placement = 'bottom-start', className }: { trigger: (p: { ref: React.RefObject<HTMLButtonElement | null>; open: boolean; toggle: () => void }) => React.ReactElement; items: MenuItem[]; placement?: Placement; className?: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      {trigger({ ref, open, toggle: () => setOpen((o) => !o) })}
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement={placement} role="presentation" className={cx('min-w-[200px]', className)}>
        <MenuList items={items} onDone={() => { setOpen(false); ref.current?.focus(); }} />
      </Popover>
    </>
  );
}

/** A label that appears after a short hover or on keyboard focus. */
export function Tooltip({ label, children, placement = 'top', shortcut }: { label: React.ReactNode; children: React.ReactElement; placement?: Placement; shortcut?: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 450); };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span ref={ref} className="inline-flex" onPointerEnter={(e) => e.pointerType !== 'touch' && show()} onPointerLeave={hide} onFocus={show} onBlur={hide} onPointerDown={hide}>
      {children}
      {open && (
        <Portal>
          <TooltipBox anchor={ref} placement={placement}>{label}{shortcut && <Kbd keys={shortcut} className="ml-2" />}</TooltipBox>
        </Portal>
      )}
    </span>
  );
}

function TooltipBox({ anchor, placement, children }: { anchor: React.RefObject<HTMLElement | null>; placement: Placement; children: React.ReactNode }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    const el = box.current;
    if (!r || !el) return;
    setPos(place(r, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement, 6));
  }, [anchor, placement]);
  return (
    <div ref={box} role="tooltip" style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, zIndex: 80 }}
      className="hx-fade-in pointer-events-none flex max-w-xs items-center rounded-md bg-hx-primary px-2 py-1 text-[12px] text-hx-bg shadow-lg">
      {children}
    </div>
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** No header and no padding: the content draws its own (the settings modal). */
  bare?: boolean;
  label?: string;
  className?: string;
}

/** A dialog: focus is trapped inside, Escape and the backdrop close it, focus returns where it was. */
export function Modal({ open, onClose, title, children, footer, size = 'md', bare, label, className }: ModalProps): React.ReactElement | null {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!; const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => (box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('input,textarea,button') ?? box.current)?.focus(), 0);
    return () => { document.removeEventListener('keydown', onKey, true); before?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[760px]', xl: 'max-w-[980px]', full: 'max-w-[calc(100vw-48px)]' }[size];
  return (
    <Portal>
      <div className="hx-fade-in fixed inset-0 z-50 flex items-center justify-center bg-[var(--hx-scrim)] p-4 sm:p-6" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={box} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : undefined)} tabIndex={-1}
          className={cx('hx-pop-in flex max-h-[calc(100vh-48px)] w-full flex-col overflow-hidden rounded-2xl border border-hx-border bg-hx-bg text-hx-primary shadow-[var(--hx-shadow)] outline-none', width, className)}>
          {bare ? children : (
            <>
              {title !== undefined && (
                <div className="flex items-center gap-3 border-b border-hx-border-subtle px-5 py-3.5">
                  <div className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</div>
                  <IconButton icon="x" label="Close" size="sm" onClick={onClose} />
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto px-5 py-4 hx-scroll">{children}</div>
              {footer && <div className="flex items-center justify-end gap-2 border-t border-hx-border-subtle px-5 py-3">{footer}</div>}
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}

/** A yes/no question as a modal; resolves with the answer. */
export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', danger, onAnswer }: { open: boolean; title: string; body?: React.ReactNode; confirmLabel?: string; danger?: boolean; onAnswer: (yes: boolean) => void }): React.ReactElement | null {
  return (
    <Modal open={open} onClose={() => onAnswer(false)} title={title} size="sm"
      footer={<>
        <button type="button" className="h-8 rounded-lg px-3 text-[13px] text-hx-secondary hover:bg-hx-hover" onClick={() => onAnswer(false)}>Cancel</button>
        <button type="button" data-autofocus className={cx('h-8 rounded-lg px-3 text-[13px] font-medium', danger ? 'bg-hx-danger text-white' : 'bg-hx-accent text-hx-on-accent')} onClick={() => onAnswer(true)}>{confirmLabel}</button>
      </>}>
      <div className="text-[13.5px] leading-6 text-hx-secondary">{body}</div>
    </Modal>
  );
}

export function InfoNote({ tone = 'info', children, icon }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: React.ReactNode; icon?: string }): React.ReactElement {
  const t = { info: 'border-hx-info/30 bg-hx-info/8 text-hx-primary', warning: 'border-hx-warning/35 bg-hx-warning/8 text-hx-primary', danger: 'border-hx-danger/35 bg-hx-danger/8 text-hx-primary', success: 'border-hx-success/30 bg-hx-success/8 text-hx-primary' }[tone];
  const ic = icon ?? { info: 'info', warning: 'warning', danger: 'alert', success: 'check-circle' }[tone];
  const col = { info: 'text-hx-info', warning: 'text-hx-warning', danger: 'text-hx-danger', success: 'text-hx-success' }[tone];
  return (
    <div className={cx('flex gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-5', t)}>
      <Icon name={ic} size={16} className={cx('mt-0.5 shrink-0', col)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
