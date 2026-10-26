/**
 * A plugin's deep review (POST /api/plugins/review): before a folder is loaded, and on demand for any
 * plugin. The verdict and score, what it adds, each finding with what to do, its tests; for a folder
 * not loaded yet, Load it (or Load anyway, past errors) and Cancel.
 */

import React, { useEffect, useState } from 'react';
import type { PluginReview } from '@harness/client';
import { Badge, Button, Icon, Modal, Spinner, toast } from '@harness/ui';
import { client } from '../../state/data';

const TONE = { error: 'danger', warning: 'warning', info: 'info' } as const;

export function ReviewReport({ review }: { review: PluginReview }): React.ReactElement {
  const [showTests, setShowTests] = useState(false);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of review.findings) counts[f.level]++;
  const adds = Object.entries(review.adds).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => `${Array.isArray(v) ? v.length : v} ${k}`);
  return (
    <div data-plugin-review={review.plugin} data-review-ok={review.ok ? '1' : '0'} className="space-y-3 text-[13px]">
      <div className="flex items-center gap-3 rounded-lg border border-hx-border-subtle p-3">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold ${review.ok ? 'bg-hx-success/12 text-hx-success' : 'bg-hx-danger/12 text-hx-danger'}`} data-review-score>{review.score}</div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{review.plugin} {review.version} · {review.ok ? 'Ready to use' : 'Not ready'}</div>
          <div className="text-hx-muted">{adds.length ? `Adds ${adds.join(', ')}` : 'Adds nothing'}{review.tests ? ` · tests ${review.tests.passed ? 'pass' : 'fail'} (${review.tests.files} file${review.tests.files === 1 ? '' : 's'})` : ''}</div>
        </div>
        <div className="flex gap-1">{(['error', 'warning', 'info'] as const).map((l) => counts[l] ? <Badge key={l} tone={TONE[l]}>{counts[l]} {l === 'info' ? 'note' : l}{counts[l] > 1 ? 's' : ''}</Badge> : null)}</div>
      </div>
      {review.findings.length === 0 ? <div className="flex items-center gap-2 text-hx-success"><Icon name="check" size={15} />No findings: manifest, tools, routes, pages, permissions, code and tests all check out.</div> : (
        <ul className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1" data-review-findings>
          {review.findings.map((f, i) => (
            <li key={i} className="rounded-lg border border-hx-border-subtle px-3 py-2" data-finding-level={f.level}>
              <div className="flex items-start gap-2">
                <Badge tone={TONE[f.level]}>{f.level}</Badge>
                <span className="shrink-0 text-[12px] text-hx-muted">{f.area}</span>
                <span className="min-w-0 flex-1">{f.message}</span>
              </div>
              {f.fix && <div className="mt-1 pl-1 text-[12.5px] text-hx-secondary">→ {f.fix}</div>}
            </li>
          ))}
        </ul>
      )}
      {review.tests && !review.tests.passed && (
        <div>
          <button type="button" className="text-[12.5px] text-hx-accent-text" onClick={() => setShowTests((v) => !v)}>{showTests ? 'Hide' : 'Show'} the test output</button>
          {showTests && <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-hx-code-bg p-2 font-mono text-[11.5px]">{review.tests.output}</pre>}
        </div>
      )}
    </div>
  );
}

/** Reviews (a folder or a plugin by name) in a modal; `onLoad` makes it the step before loading a folder. */
export function ReviewModal({ target, onClose, onLoad }: { target: { dir?: string; name?: string; title: string }; onClose: () => void; onLoad?: () => Promise<void> }): React.ReactElement {
  const [review, setReview] = useState<PluginReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    void client.plugins.review({ ...(target.dir ? { dir: target.dir } : {}), ...(target.name ? { name: target.name } : {}) })
      .then((r) => { if (live) setReview(r); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [target.dir, target.name]);
  const load = async () => { setLoading(true); try { await onLoad!(); onClose(); } catch (e) { toast((e as Error).message, { kind: 'error' }); } finally { setLoading(false); } };
  return (
    <Modal open onClose={onClose} size="lg" title={`Review: ${target.title}`} label="Plugin review"
      footer={<div className="flex w-full items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{onLoad ? 'Cancel' : 'Close'}</Button>
        {onLoad && <Button data-review-load variant={review?.ok ? 'primary' : 'danger'} disabled={!review && !error} loading={loading} onClick={() => void load()}>{review && !review.ok ? 'Load anyway' : 'Load it'}</Button>}
      </div>}>
      {error ? <div className="text-hx-danger">The review could not run: {error}</div>
        : !review ? <div className="flex items-center gap-2 py-6 text-hx-muted"><Spinner />Reviewing: loading it in a throwaway engine, calling its tools and routes, reading its pages and code, running its tests…</div>
        : <ReviewReport review={review} />}
    </Modal>
  );
}
