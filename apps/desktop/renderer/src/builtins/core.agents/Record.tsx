/**
 * The run record of a conversation (docs/swarm/SWARM.md, phase 6), beside it: whether its hash-chained record
 * verifies, and the steps as they happened (who asked what, each call and result, the person's decisions), read from
 * the record alone; nothing runs again. Export saves the bundle, which verifies on its own anywhere.
 */
import React, { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Spinner } from '@harness/ui';
import { client } from '../../state/data';
import { useSessionLive } from '../core.chat/live';
import type { NativeProps } from '../../registry/PluginView';

type Replay = Awaited<ReturnType<typeof client.sessions.record>>;

export function RecordPanel({ params }: NativeProps): React.ReactElement {
  const id = params.id ?? '';
  const [s] = useSessionLive(id);
  const [r, setR] = useState<Replay | null | undefined>(undefined);
  const [off, setOff] = useState(false);
  // Read again as the conversation goes on (each turn adds to the record).
  const turns = s.live.items.length;
  useEffect(() => {
    let live = true;
    client.sessions.record(id).then((x) => { if (live) { setR(x); setOff(false); } }, (e: Error) => { if (live) { setR(null); setOff(/404|not recorded/i.test(e.message)); } });
    return () => { live = false; };
  }, [id, turns]);
  const exportBundle = async () => {
    const b = await client.sessions.recordBundle(id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `record-${id}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  if (r === undefined) return <div className="p-4"><Spinner /></div>;
  if (!r) return <EmptyState icon="shield" title={off ? 'Not recorded' : 'The record could not be read'}>{off ? 'Turn the run recorder on with "record": true in the settings (or HARNESS_RECORD=on): each request, call, result, answer and decision is then kept in a hash-chained record you can check and export.' : 'Try again in a moment.'}</EmptyState>;
  return (
    <div className="flex h-full flex-col gap-3 p-3" data-record-panel>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={r.verify.ok ? 'success' : 'danger'} data-record-ok={r.verify.ok ? 'yes' : 'no'}>{r.verify.ok ? 'Verifies' : 'Changed'}</Badge>
          <span className="text-xs text-muted">{r.verify.lines} step(s){r.verify.head ? ` · head ${r.verify.head.slice(0, 12)}` : ''}</span>
        </div>
        <Button size="sm" variant="ghost" icon="download" onClick={() => void exportBundle().catch(() => {})}>Export</Button>
      </div>
      {!r.verify.ok && <ul className="rounded border border-danger/40 p-2 text-xs text-danger">{r.verify.problems.slice(0, 10).map((p) => <li key={p}>{p}</li>)}</ul>}
      <ol className="flex-1 space-y-1 overflow-auto text-xs" data-record-steps>
        {r.steps.map((x) => (
          <li key={x.n} className="flex gap-2">
            <span className="w-8 shrink-0 text-right text-muted">{x.n}</span>
            <span className="w-16 shrink-0 truncate font-medium" title={x.who}>{x.who}</span>
            <span className="min-w-0 break-words">{x.what}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
