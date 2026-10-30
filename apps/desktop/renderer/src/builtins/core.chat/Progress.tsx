/**
 * What a running turn shows under the transcript: the agent's task list (todo_write) as a card in the
 * conversation, and one line saying what it is doing right now and for how long - so a long wait (a
 * training run, a background agent) reads as work in progress, not as a stall.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Item, Todo } from '@harness/client';
import { activityLine, duration } from '@harness/client';
import { Icon, Spinner, Working, cx } from '@harness/ui';

/** The task list, while the turn runs or while some of it is still open. */
export function TaskCard({ todos }: { todos: Todo[] }): React.ReactElement {
  return (
    <div className="mx-auto w-full max-w-column shrink-0 px-4 pb-2 sm:px-6">
      <ol data-task-card aria-label="Tasks" className="hx-scroll max-h-[40vh] space-y-1.5 overflow-y-auto rounded-xl border border-hx-border-subtle bg-hx-surface px-4 py-3">
        {todos.map((t, i) => (
          <li key={i} data-todo-status={t.status} className="flex items-start gap-2.5 text-[13px] leading-5">
            <span className="mt-[3px] flex h-[14px] w-[14px] shrink-0 items-center justify-center">
              {t.status === 'completed' ? <Icon name="check-circle" size={14} className="text-hx-muted" />
                : t.status === 'in_progress' ? <Spinner size={13} className="text-hx-accent-text" />
                : <span className="h-[12px] w-[12px] rounded-full border border-dashed border-hx-muted" />}
            </span>
            <span className={cx(t.status === 'completed' && 'text-hx-muted', t.status === 'in_progress' && 'font-medium text-hx-primary', t.status === 'pending' && 'text-hx-secondary')}>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** "Showing the result files · 1m 59s": what is happening now, and how long the turn has run. */
export function ActivityLine({ items, todos, style }: { items: Item[]; todos: Todo[]; style?: string }): React.ReactElement {
  const started = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const what = activityLine(items, todos);
  return (
    <div className="mx-auto flex w-full max-w-column items-center gap-2 px-6 pb-1 text-[12.5px] text-hx-muted" data-working>
      <Working style={style} className="shrink-0 text-hx-accent-text" />
      <span className="min-w-0 truncate text-hx-secondary" data-activity>{what}</span>
      <span className="shrink-0 tabular-nums" data-elapsed>{duration(now - started.current)}</span>
      <span className="ml-auto hidden shrink-0 text-hx-muted/70 sm:inline">Enter steers, Queue waits for the end</span>
    </div>
  );
}
