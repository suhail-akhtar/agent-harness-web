/**
 * Images (inline, opened in a lightbox with zoom), citations (numbered chips with a hover card) and
 * the model's reasoning ("Thought for 12s", folded once the answer starts).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons.tsx';
import { Portal } from '../components/overlay.tsx';
import { safeHref, safeImageSrc } from './safe.ts';

export function ImageView({ src, alt, className, thumb }: { src: string; alt?: string; className?: string; thumb?: boolean }): React.ReactElement | null {
  const safe = safeImageSrc(src);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!safe) return <span className="text-[12px] text-hx-muted">[image not shown: {alt || 'unsupported source'}]</span>;
  if (failed) return <span className="inline-flex items-center gap-1 rounded bg-hx-pill px-1.5 py-0.5 text-[12px] text-hx-muted"><Icon name="image" size={12} />{alt || 'image'} (did not load)</span>;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`group relative my-2 inline-block max-w-full overflow-hidden rounded-xl border border-hx-border-subtle align-top ${className ?? ''}`} title="Open full size" data-image>
        <img src={safe} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={thumb ? 'h-24 w-auto object-cover' : 'max-h-[28rem] max-w-full'} />
        <span className="absolute right-1.5 top-1.5 rounded-md bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"><Icon name="expand" size={13} /></span>
      </button>
      {open && <Lightbox src={safe} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Lightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }): React.ReactElement {
  const [scale, setScale] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(8, s * 1.25));
      if (e.key === '-') setScale((s) => Math.max(0.25, s / 1.25));
      if (e.key === '0') { setScale(1); setOff({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <Portal>
      <div role="dialog" aria-label={alt || 'Image'} data-lightbox className="hx-fade-in fixed inset-0 z-[70] flex flex-col bg-black/85" onWheel={(e) => setScale((s) => Math.min(8, Math.max(0.25, s * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))}>
        <div className="flex items-center gap-2 px-4 py-2 text-white/80">
          <span className="min-w-0 flex-1 truncate text-[13px]">{alt}</span>
          <span className="text-[12px] tabular-nums">{Math.round(scale * 100)}%</span>
          <button type="button" aria-label="Zoom out" className="rounded p-1.5 hover:bg-white/10" onClick={() => setScale((s) => Math.max(0.25, s / 1.25))}><Icon name="zoom-out" size={16} /></button>
          <button type="button" aria-label="Zoom in" className="rounded p-1.5 hover:bg-white/10" onClick={() => setScale((s) => Math.min(8, s * 1.25))}><Icon name="zoom-in" size={16} /></button>
          <button type="button" aria-label="Actual size" className="rounded p-1.5 hover:bg-white/10" onClick={() => { setScale(1); setOff({ x: 0, y: 0 }); }}><Icon name="fit" size={16} /></button>
          <button type="button" aria-label="Close" data-autofocus className="rounded p-1.5 hover:bg-white/10" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); else { drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }; (e.target as Element).setPointerCapture?.(e.pointerId); } }}
          onPointerMove={(e) => { const d = drag.current; if (d) setOff({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }); }} onPointerUp={() => { drag.current = null; }}>
          <img src={src} alt={alt ?? ''} draggable={false} referrerPolicy="no-referrer" style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${scale})`, transition: drag.current ? 'none' : 'transform 120ms' }} className="max-h-[90%] max-w-[92%] cursor-grab select-none object-contain" />
        </div>
      </div>
    </Portal>
  );
}

export interface Source { n: number; url: string; title?: string; snippet?: string }

/** A numbered citation; hovering shows where it points. */
export function Citation({ n, source }: { n: number | string; source?: Source }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const href = safeHref(source?.url);
  let host = '';
  try { host = href ? new URL(href).hostname.replace(/^www\./, '') : ''; } catch { /* not a URL */ }
  return (
    <span className="relative inline-block align-baseline" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      <a href={href} target="_blank" rel="noopener noreferrer" data-citation={n} className="mx-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-hx-pill px-1 text-[10.5px] font-medium text-hx-secondary no-underline hover:bg-hx-accent-soft hover:text-hx-accent-text">{n}</a>
      {open && source && (
        <span role="tooltip" className="hx-pop-in absolute bottom-full left-1/2 z-40 mb-1.5 block w-72 -translate-x-1/2 rounded-xl border border-hx-border bg-hx-elevated p-3 text-left text-[12px] leading-5 text-hx-primary shadow-[var(--hx-shadow)]">
          <span className="flex items-center gap-1.5 text-[11px] text-hx-muted"><Icon name="globe" size={12} />{host}</span>
          {source.title && <span className="mt-1 block font-medium">{source.title}</span>}
          {source.snippet && <span className="mt-1 block text-hx-secondary">{source.snippet.slice(0, 220)}</span>}
        </span>
      )}
    </span>
  );
}

/** Reasoning: live tail while streaming, then folded to "Thought for Ns". */
export function Reasoning({ text, streaming, ms }: { text: string; streaming?: boolean; ms?: number }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => { if (streaming && tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [text, streaming]);
  if (!text.trim()) return null;
  if (streaming) {
    return (
      <div className="my-2" data-reasoning="live">
        <div className="mb-1 flex items-center gap-2 text-[13px] text-hx-muted"><Icon name="brain" size={14} className="hx-thinking" /><span className="hx-thinking">Thinking…</span></div>
        <div ref={tail} className="max-h-28 overflow-y-auto border-l-2 border-hx-border-subtle pl-3 text-[12.5px] leading-5 text-hx-muted">
          <div className="whitespace-pre-wrap break-words">{text.length > 800 ? `…${text.slice(-800)}` : text}</div>
        </div>
      </div>
    );
  }
  const s = ms !== undefined ? Math.max(1, Math.round(ms / 1000)) : undefined;
  return (
    <div className="my-1.5" data-reasoning="done">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="group flex items-center gap-1.5 text-[13px] text-hx-muted hover:text-hx-secondary">
        <Icon name="brain" size={14} />
        <span>{s !== undefined ? `Thought for ${s}s` : 'Thought'}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} className="opacity-60" />
      </button>
      {open && <div className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-hx-border-subtle pl-3 text-[12.5px] leading-5 text-hx-secondary">{text}</div>}
    </div>
  );
}

export function ImageStrip({ images }: { images: Array<{ media_type: string; data: string }> }): React.ReactElement {
  return <div className="flex flex-wrap gap-2">{images.map((im, i) => <ImageView key={i} thumb src={`data:${im.media_type};base64,${im.data}`} alt={`Image ${i + 1}`} />)}</div>;
}

