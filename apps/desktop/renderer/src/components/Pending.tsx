/**
 * A request waiting for the person: a tool permission, a question, a plan, a workflow approval.
 * Drawn in the chat's attention bar and in the inbox; answering posts to the session.
 */

import React, { useState } from 'react';
import { isMissing, type PendingRequest } from '@harness/client';
import { ActionPanel, Button, CodeBlock, DiffView, Input, Markdown, Textarea, cx, toast } from '@harness/ui';
import { client, useData } from '../state/data';
import { QuestionCard } from './Question';
import { updateSession } from '../builtins/core.chat/live';

export type Respond = (b: { requestId: string; decision: string; feedback?: string; answer?: string | Record<string, unknown> }) => Promise<void>;

export function respondFor(sessionId: string): Respond {
  return async (b) => {
    // Drop it from the inbox at once; the server's resolved event confirms.
    useData.setState({ approvals: useData.getState().approvals.filter((a) => a.requestId !== b.requestId) });
    const drop = () => updateSession(sessionId, (s) => ({ ...s, pending: s.pending.filter((p) => p.requestId !== b.requestId) }));
    try {
      const r = await client.sessions.respond(sessionId, b);
      // Answered: off the conversation at once (as in the inbox), not only when the stream says so.
      drop();
      if (!r.ok) toast('That request was already answered or closed.', { kind: 'warning' });
    } catch (e) {
      // 404: the request is gone (answered elsewhere, or its turn was stopped): close the card rather than show the status.
      if (isMissing(e)) { drop(); toast('That request was already answered or closed.', { kind: 'warning' }); return; }
      toast((e as Error).message, { kind: 'error' }); void useData.getState().refreshApprovals();
    }
  };
}

const KIND_LABEL: Record<PendingRequest['kind'], { icon: string; label: string }> = {
  permission_request: { icon: 'shield', label: 'Permission' },
  question: { icon: 'help', label: 'Question' },
  plan_proposed: { icon: 'list', label: 'Plan' },
  approval_request: { icon: 'check-circle', label: 'Approval' },
};

export function PendingCard({ p, respond, compact }: { p: PendingRequest; respond: Respond; compact?: boolean }): React.ReactElement {
  const [feedback, setFeedback] = useState('');
  const [file, setFile] = useState(0);
  const [busy, setBusy] = useState(false);
  const go = (b: Parameters<Respond>[0]) => { setBusy(true); void respond(b).finally(() => setBusy(false)); };
  const k = KIND_LABEL[p.kind];
  let body: React.ReactNode;
  let title: string | undefined;
  let actions: React.ReactNode = null;
  if (p.kind === 'permission_request') {
    const cmd = typeof p.input.command === 'string' ? p.input.command : null;
    body = (
      <>
        <div className="text-[13.5px] text-hx-primary">{p.agent ? <><b>{p.agent}</b> wants to use </> : 'Allow '}<b className="font-mono">{p.tool}</b>?</div>
        {cmd ? <CodeBlock code={cmd} language="bash" collapseAt={12} /> : <div className="mt-1 text-[13px] text-hx-secondary">{p.summary}</div>}
        {!compact && p.tool === 'edit' && typeof p.input.path === 'string' && <DiffView path={p.input.path} before={String(p.input.old_string ?? '')} after={String(p.input.new_string ?? '')} />}
        {!compact && p.tool === 'write' && typeof p.input.path === 'string' && <CodeBlock code={String(p.input.content ?? '').slice(0, 6000)} filename={p.input.path} language={String(p.input.path).split('.').pop() ?? ''} collapseAt={16} />}
      </>
    );
    actions = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy} data-decision="allow" onClick={() => go({ requestId: p.requestId, decision: 'allow' })}>Allow once</Button>
          {p.suggestion && <Button size="sm" disabled={busy} data-decision="allow_always" onClick={() => go({ requestId: p.requestId, decision: 'allow_always' })}>{p.suggestion === 'edit_all' ? 'Allow all edits this session' : `Always allow ${p.suggestion}`}</Button>}
          <Button size="sm" variant="ghost" disabled={busy} data-decision="deny" onClick={() => go({ requestId: p.requestId, decision: 'deny', ...(feedback ? { feedback } : {}) })}>Deny</Button>
          <Input className="h-7 min-w-[160px] flex-1 text-[12.5px]" placeholder="Note for the agent if you deny" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </div>
      </>
    );
  } else if (p.kind === 'question') {
    return <QuestionCard p={p} respond={respond} />;
  } else if (p.kind === 'plan_proposed') {
    title = 'The agent proposes this plan';
    body = <Markdown text={p.plan} />;
    actions = (
      <>
        <Textarea rows={1} placeholder="Feedback if you want changes" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => go({ requestId: p.requestId, decision: 'approve_accept_edits' })}>Approve, auto-accept edits</Button>
          <Button size="sm" disabled={busy} onClick={() => go({ requestId: p.requestId, decision: 'approve' })}>Approve, review edits</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => go({ requestId: p.requestId, decision: 'revise', feedback: feedback || 'Please revise the plan.' })}>Keep planning</Button>
        </div>
      </>
    );
  } else {
    const f = p.files[file];
    title = p.title;
    body = (
      <>
        <Markdown text={p.message} />
        {p.files.length > 0 && (
          <div className="mt-2">
            <div className="flex flex-wrap gap-1">{p.files.map((x, i) => <button key={x.path} type="button" onClick={() => setFile(i)} className={cx('rounded-md px-2 py-0.5 text-[12px]', i === file ? 'bg-hx-accent-soft text-hx-accent-text' : 'bg-hx-pill text-hx-secondary')}>{x.path}</button>)}</div>
            {f && <div className="mt-1 rounded-lg border border-hx-border-subtle bg-hx-bg px-3 py-2"><Markdown text={f.path.endsWith('.md') ? f.content : `\`\`\`${f.path.split('.').pop() ?? ''}\n${f.content}\n\`\`\``} /></div>}
          </div>
        )}
      </>
    );
    actions = (
      <div className="flex items-center gap-2">
        <Input className="h-8 min-w-0 flex-1 text-[12.5px]" placeholder="What to change, if you send it back" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <Button size="sm" variant="ghost" disabled={busy || !feedback.trim()} title={feedback.trim() ? '' : 'Say what to change'} onClick={() => go({ requestId: p.requestId, decision: 'reject', feedback })}>Send back</Button>
        <Button size="sm" variant="primary" disabled={busy} data-decision="approve" onClick={() => go({ requestId: p.requestId, decision: 'approve', ...(feedback ? { feedback } : {}) })}>Approve</Button>
      </div>
    );
  }
  return (
    <ActionPanel data-pending={p.kind} data-request={p.requestId} label={k.label} icon={k.icon} title={title} footer={actions}>
      {body}
    </ActionPanel>
  );
}
