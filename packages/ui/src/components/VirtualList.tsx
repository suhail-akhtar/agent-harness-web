/**
 * A long list that only mounts what is on screen (plus some overscan): a transcript of thousands of
 * messages scrolls and streams as fast as a short one. Rows measure themselves, so they can be any
 * height; the list keeps to the bottom while the reader is there (a streaming reply grows into view)
 * and stays put when they have scrolled up to read.
 */

import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, forwardRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualListHandle { scrollToBottom(smooth?: boolean): void; scrollToKey(key: string): void; atBottom(): boolean; element(): HTMLDivElement | null }

export interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  render: (item: T, index: number) => React.ReactNode;
  estimate?: (item: T, index: number) => number;
  /** Keep the view pinned to the bottom while the reader is at the bottom. */
  stickToBottom?: boolean;
  className?: string;
  /** Content above the rows (inside the scroller): e.g. a "load earlier" button. */
  header?: React.ReactNode;
  footer?: React.ReactNode;
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Width of the column the rows sit in. */
  innerClassName?: string;
  overscan?: number;
}

function VirtualListInner<T>({ items, getKey, render, estimate, stickToBottom = true, className, header, footer, onAtBottomChange, innerClassName, overscan = 6 }: VirtualListProps<T>, ref: React.Ref<VirtualListHandle>): React.ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => estimate?.(items[i]!, i) ?? 120,
    getItemKey: (i) => getKey(items[i]!, i),
    overscan,
  });
  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    if (items.length) virt.scrollToIndex(items.length - 1, { align: 'end' });
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));
  };
  useImperativeHandle(ref, () => ({
    scrollToBottom: (smooth) => { pinned.current = true; toBottom(smooth); },
    scrollToKey: (key) => { const i = items.findIndex((it, j) => getKey(it, j) === key); if (i >= 0) virt.scrollToIndex(i, { align: 'center' }); },
    atBottom: () => pinned.current,
    element: () => scroller.current,
  }));
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const at = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      if (at !== pinned.current) { pinned.current = at; onAtBottomChange?.(at); }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onAtBottomChange]);
  const total = virt.getTotalSize();
  // New rows or a growing last row: follow them when the reader is at the bottom.
  useLayoutEffect(() => {
    if (!stickToBottom || !pinned.current) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, total, stickToBottom]);
  return (
    <div ref={scroller} className={`hx-scroll relative overflow-y-auto ${className ?? ''}`} data-virtual-list style={{ overflowAnchor: 'none' }}>
      <div className={innerClassName}>
        {header}
        <div style={{ height: total, position: 'relative', width: '100%' }}>
          {virt.getVirtualItems().map((v) => (
            <div key={v.key} data-index={v.index} data-row-key={String(v.key)} ref={virt.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}>
              {render(items[v.index]!, v.index)}
            </div>
          ))}
        </div>
        {footer}
      </div>
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(p: VirtualListProps<T> & { ref?: React.Ref<VirtualListHandle> }) => React.ReactElement;
