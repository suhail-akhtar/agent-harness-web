/**
 * Toasts: short notes that something happened. One store, callable from anywhere (`toast(...)`),
 * drawn by one <Toaster/>. Errors stay until dismissed; everything else leaves on its own.
 */

import React, { useSyncExternalStore } from 'react';
import { Icon } from '../icons.tsx';
import { cx } from './primitives.tsx';
import { Portal } from './overlay.tsx';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface Toast { id: number; text: string; kind: ToastKind; detail?: string; action?: { label: string; run: () => void }; source?: string }

let toasts: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

export function toast(text: string, opts: { kind?: ToastKind; detail?: string; action?: Toast['action']; source?: string; ms?: number } = {}): number {
  const t: Toast = { id: nextId++, text: String(text).slice(0, 300), kind: opts.kind ?? 'info', ...(opts.detail ? { detail: opts.detail.slice(0, 600) } : {}), ...(opts.action ? { action: opts.action } : {}), ...(opts.source ? { source: opts.source } : {}) };
  toasts = [...toasts.slice(-4), t];
  emit();
  const ms = opts.ms ?? (t.kind === 'error' ? 0 : 4500);
  if (ms > 0) setTimeout(() => dismiss(t.id), ms);
  return t.id;
}
export function dismiss(id: number): void { toasts = toasts.filter((t) => t.id !== id); emit(); }
export function useToasts(): Toast[] { return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => toasts, () => toasts); }

const ICON: Record<ToastKind, string> = { info: 'info', success: 'check-circle', warning: 'warning', error: 'x-circle' };
const TONE: Record<ToastKind, string> = { info: 'text-hx-info', success: 'text-hx-success', warning: 'text-hx-warning', error: 'text-hx-danger' };

export function Toaster(): React.ReactElement {
  const list = useToasts();
  return (
    <Portal>
      <div aria-live="polite" className="pointer-events-none fixed bottom-10 right-4 z-[90] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
        {list.map((t) => (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} data-toast={t.kind}
            className="hx-slide-up pointer-events-auto flex items-start gap-2.5 rounded-xl border border-hx-border bg-hx-elevated px-3.5 py-2.5 text-[13px] text-hx-primary shadow-[var(--hx-shadow)]">
            <Icon name={ICON[t.kind]} size={16} className={cx('mt-0.5 shrink-0', TONE[t.kind])} />
            <div className="min-w-0 flex-1">
              <div className="break-words">{t.text}</div>
              {t.detail && <div className="mt-0.5 break-words text-[12px] text-hx-muted">{t.detail}</div>}
              {t.source && <div className="mt-0.5 text-[11px] text-hx-muted">from {t.source}</div>}
            </div>
            {t.action && <button type="button" className="shrink-0 text-[12.5px] font-medium text-hx-accent-text hover:underline" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
            <button type="button" aria-label="Dismiss" className="shrink-0 text-hx-muted hover:text-hx-primary" onClick={() => dismiss(t.id)}><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    </Portal>
  );
}
