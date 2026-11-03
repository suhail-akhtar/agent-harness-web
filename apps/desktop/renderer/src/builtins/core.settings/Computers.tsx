/**
 * Settings > Your computers: the person's companions. Each runs work on that machine (a conversation placed there,
 * or swarm agents sent to it) under the policy its owner set on the machine itself; the server can only narrow it.
 * Add one (its token is shown once, with the command to start it), replace its token, remove it (revoked at once).
 */

import React, { useEffect, useState } from 'react';
import type { CompanionInfo } from '@harness/client';
import { isMissing } from '@harness/client';
import { Badge, Button, Callout, Card, EmptyState, Field, InfoNote, Input, Modal, Spinner, StatusDot, toast } from '@harness/ui';
import { client } from '../../state/data';

const fail = (e: Error) => toast(e.message, { kind: 'error' });
const days = (t?: number) => (t ? Math.max(0, Math.round((t - Date.now()) / 86_400_000)) : undefined);

function TokenNote({ token, onClose }: { token: { name: string; token: string }; onClose: () => void }): React.ReactElement {
  // The address that computer reaches this server at (this app's engine listens on this machine only, unless shared).
  const server = (client.base || window.location.origin).replace(/\/+$/, '');
  const command = `curl -o harness-companion.mjs ${server}/companion.mjs\nnode harness-companion.mjs --server ${server} --token ${token.token}`;
  return (
    <Modal open title={`Start ${token.name}`} onClose={onClose}>
      <p className="text-body">Run this on that computer (it needs Node.js, and to reach this server). The token is shown once; it lets that computer take work, so keep it to yourself.</p>
      <pre className="mt-3 overflow-auto rounded bg-hx-surface-2 p-3 text-small" data-companion-command>{command}</pre>
      <p className="mt-3 text-small text-hx-secondary">On that computer, <code>harness-companion policy --swarm on --kinds read,edit,exec --max-jobs 2</code> says what swarm agents may do there. Without it they may only read.</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" icon="copy" onClick={() => void navigator.clipboard.writeText(command).then(() => toast('Copied'))}>Copy</Button>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

export function Computers(): React.ReactElement {
  const [list, setList] = useState<CompanionInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  const load = () => client.companions.list().then((l) => { setList(l); setErr(''); }).catch((e: Error) => setErr(isMissing(e) ? 'This server does not take companions.' : e.message));
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, []);
  if (err) return <InfoNote>{err}</InfoNote>;
  if (!list) return <Spinner />;
  const add = () => void client.companions.create(name.trim() || 'My computer').then((r) => { setToken({ name: name.trim() || 'My computer', token: r.token }); setAdding(false); setName(''); void load(); }).catch(fail);
  const rotate = (c: CompanionInfo) => void client.companions.rotate(c.id).then((r) => { setToken({ name: c.name, token: r.token }); void load(); }).catch(fail);
  const remove = (c: CompanionInfo) => void client.companions.remove(c.id).then(() => { toast(`Removed ${c.name}: its token no longer works`); void load(); }).catch(fail);
  return (
    <div data-section="computers">
      <div className="mb-4 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-body text-hx-secondary">Your other computers, where conversations and swarm agents can work. Each machine decides what it allows (its own policy, signed with its own key); work there is checked again on this server before it is accepted at stakes.</p>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)} data-computers-add>Add a computer</Button>
      </div>
      {!list.length ? (
        <EmptyState icon="monitor" title="No computers yet" action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add one</Button>}>Add a computer, start the companion on it with the command shown, and it appears here.</EmptyState>
      ) : (
        <div className="grid gap-3" data-computers-list>
          {list.map((c) => {
            const p = c.info?.policy;
            const left = days(c.expiresAt);
            return (
              <Card key={c.id} className="flex flex-col gap-2 p-4" data-computer={c.id}>
                <div className="flex items-center gap-2">
                  <StatusDot tone={c.online ? 'success' : 'neutral'} />
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-small text-hx-muted">{c.online ? `online${c.running ? `, ${c.running} running` : ''}` : 'offline'}</span>
                  {c.keyed && <Badge tone="success">its own key</Badge>}
                  {c.info?.sandbox && c.info.sandbox !== 'off' && <Badge>sandbox: {c.info.sandbox}</Badge>}
                </div>
                {c.info && c.info.platform !== 'unknown' && <p className="text-small text-hx-secondary">{c.info.platform}{c.info.root ? ` · ${c.info.root}` : ''}{c.info.version ? ` · companion ${c.info.version}` : ''}</p>}
                <p className="text-small" data-computer-policy>
                  Swarm work: {p ? (p.swarm ? `${p.kinds.join(', ')}; up to ${p.maxJobs} at once${p.sandboxRequired ? '; beyond reading only in a sandbox' : ''}` : 'not allowed') : 'reading only (no policy set on the machine)'}
                  {p && <span className="text-hx-muted">{c.info?.policySigned ? ' (signed by the machine)' : ' (not signed)'}</span>}
                </p>
                {left !== undefined && left < 7 && !c.online && <Callout tone="warning">Its token stops working in {left} day{left === 1 ? '' : 's'}; start it to renew, or replace the token.</Callout>}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => rotate(c)}>Replace token</Button>
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => remove(c)}>Remove</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {adding && (
        <Modal open title="Add a computer" onClose={() => setAdding(false)}>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My laptop" autoFocus /></Field>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" onClick={add}>Add</Button>
          </div>
        </Modal>
      )}
      {token && <TokenNote token={token} onClose={() => setToken(null)} />}
    </div>
  );
}
