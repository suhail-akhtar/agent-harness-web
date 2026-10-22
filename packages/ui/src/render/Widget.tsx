/**
 * The frame every drawn block sits in (charts, figures, diagrams, maths, tables, data): copy the
 * source, download it, fill the window, hide it. An error boundary inside it means one malformed
 * spec shows its error and its source here instead of taking the transcript down.
 * (Adapted from AICO's shared/ui/Widget.)
 */

import React, { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { IconButton } from '../components/primitives.tsx';
import { downloadText } from './download.ts';

const ExpandedContext = React.createContext(false);
export function useWidgetExpanded(): boolean { return React.useContext(ExpandedContext); }

class Boundary extends Component<{ children: ReactNode; onError: (m: string) => void }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.warn('[render] block failed', error.message, info.componentStack?.slice(0, 300)); this.props.onError(error.message); }
  override render() { return this.state.error ? null : this.props.children; }
}

/** An error boundary for any rendered block (used around plugin renderers too). */
export function RenderBoundary({ children, fallback }: { children: ReactNode; fallback: (error: string, retry: () => void) => ReactNode }): React.ReactElement {
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  if (error) return <>{fallback(error, () => { setError(undefined); setAttempt((n) => n + 1); })}</>;
  return <Boundary key={attempt} onError={setError}>{children}</Boundary>;
}

export interface WidgetProps { title?: string; kind: string; source: string; extension?: string; children: ReactNode; actions?: ReactNode; onFix?: (r: { kind: string; source: string; error: string }) => void }

export function Widget({ title, kind, source, extension = 'txt', children, actions, onFix }: WidgetProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setExpanded(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);
  const last = useRef(source);
  useEffect(() => { if (last.current === source) return; last.current = source; setFailure(undefined); setAttempt((n) => n + 1); }, [source]);
  const copy = () => { void navigator.clipboard?.writeText(source).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  return (
    <div data-widget={kind} data-state={failure ? 'error' : 'ok'} className={`my-3 overflow-hidden rounded-xl border border-hx-border bg-hx-bg ${expanded ? 'fixed inset-4 z-50 my-0 shadow-2xl' : ''}`}>
      <div className="flex items-center gap-0.5 border-b border-hx-border-subtle px-2 py-1">
        <span className="mr-auto truncate text-[11.5px] font-medium text-hx-secondary">
          {title ?? kind}
          {failure && <span className="ml-1.5 text-hx-danger">· did not render</span>}
        </span>
        {actions}
        <IconButton size="xs" icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy the source'} onClick={copy} />
        <IconButton size="xs" icon="download" label="Download the source" onClick={() => downloadText(`${kind}-${Date.now()}.${extension}`, source)} />
        <IconButton size="xs" icon={expanded ? 'collapse' : 'expand'} label={expanded ? 'Back into the transcript' : 'Fill the window'} onClick={() => setExpanded((v) => !v)} active={expanded} />
        <IconButton size="xs" icon={collapsed ? 'eye' : 'eye-off'} label={collapsed ? 'Show it' : 'Hide it'} onClick={() => setCollapsed((v) => !v)} />
      </div>
      {!collapsed && (
        <div className={expanded ? 'flex h-[calc(100%-2.25rem)] min-h-0 flex-col overflow-auto p-2' : 'p-2'}>
          {failure ? (
            <div className="space-y-2" data-render-error>
              <p className="text-[12.5px] text-hx-danger">This {kind} did not render: {failure}</p>
              <div className="flex items-center gap-1.5">
                {onFix && <button type="button" onClick={() => onFix({ kind, source, error: failure })} className="rounded-md bg-hx-accent px-2 py-1 text-[11.5px] font-medium text-hx-on-accent">Ask to fix</button>}
                <button type="button" onClick={() => { setFailure(undefined); setAttempt((n) => n + 1); }} className="rounded-md px-1.5 py-0.5 text-[11.5px] text-hx-muted hover:bg-hx-hover hover:text-hx-primary">Try again</button>
              </div>
              <pre className="max-h-48 overflow-auto rounded-md bg-hx-code p-2 font-mono text-[11.5px] leading-4 text-hx-muted">{source}</pre>
            </div>
          ) : (
            <ExpandedContext.Provider value={expanded}>
              <Boundary key={attempt} onError={setFailure}>{children}</Boundary>
            </ExpandedContext.Provider>
          )}
        </div>
      )}
    </div>
  );
}
