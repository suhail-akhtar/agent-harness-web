import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WHEN, fromTiming, toCron, toOnce, type When } from '../apps/desktop/renderer/src/components/when.ts';
import { TEMPLATES } from '../apps/desktop/renderer/src/builtins/core.scheduled/templates.ts';
import { describeCron, nextCron } from '../src/core/scheduler.ts';

// The schedule dialog's picker: what the person picks becomes a cron (or a one-time run) the server
// understands, and a schedule opened for editing shows as what was picked.

const w = (p: Partial<When>): When => ({ ...DEFAULT_WHEN, ...p });

test('each plain choice makes the cron it says, and reads back as the same choice', () => {
  const cases: Array<[Partial<When>, string, string]> = [
    [{ freq: 'minutes', every: 15 }, '*/15 * * * *', 'Every 15 minutes'],
    [{ freq: 'hourly', minute: 30 }, '30 * * * *', 'Every hour at minute 30'],
    [{ freq: 'daily', time: '07:45' }, '45 7 * * *', 'Every day at 07:45'],
    [{ freq: 'weekdays', time: '09:00' }, '0 9 * * 1-5', 'Every weekday at 09:00'],
    [{ freq: 'weekly', days: [4, 1], time: '18:30' }, '30 18 * * 1,4', 'Every Monday and Thursday at 18:30'],
    [{ freq: 'monthly', dom: 15, time: '08:00' }, '0 8 15 * *', 'On the 15th of every month at 08:00'],
    [{ freq: 'custom', cron: ' 5 4 1,15 * 0 ' }, '5 4 1,15 * 0', 'On the 1st and 15th, and every Sunday at 04:05'],
  ];
  for (const [pick, cron, words] of cases) {
    assert.equal(toCron(w(pick)), cron, JSON.stringify(pick));
    assert.equal(describeCron(cron), words, cron);
    assert.ok(nextCron(cron, Date.now()) !== undefined);
    const back = fromTiming({ cron });
    assert.equal(back.freq, pick.freq);
    assert.equal(toCron(back), cron, 'the same cron again');
  }
  assert.equal(fromTiming({ cron: '0 9 1-7 * 1' }).freq, 'custom', 'anything else is shown as its cron');
  assert.equal(fromTiming({ cron: '5 4 * * 0' }).freq, 'weekly', 'a cron with a simple shape opens as that shape (Sunday at 04:05)');
});

test('what is not complete makes no cron or time; a one-time choice is minutes from now or a moment', () => {
  assert.equal(toCron(w({ freq: 'weekly', days: [] })), undefined, 'no day picked');
  assert.equal(toCron(w({ freq: 'daily', time: '' })), undefined);
  assert.equal(toCron(w({ freq: 'daily', time: '25:00' })), undefined);
  assert.equal(toCron(w({ freq: 'custom', cron: '  ' })), undefined);
  assert.equal(toCron(w({ freq: 'once' })), undefined);
  assert.deepEqual(toOnce(w({ freq: 'once', onceMode: 'in', inAmount: 2, inUnit: 'hours' })), { inMinutes: 120 });
  assert.deepEqual(toOnce(w({ freq: 'once', onceMode: 'in', inAmount: 1, inUnit: 'days' })), { inMinutes: 1440 });
  assert.equal(toOnce(w({ freq: 'once', onceMode: 'in', inAmount: 0 })), undefined);
  const at = toOnce(w({ freq: 'once', onceMode: 'at', at: '2030-01-02T09:30' })) as { at: string };
  assert.equal(new Date(at.at).getTime(), new Date(2030, 0, 2, 9, 30).getTime(), 'the computer\'s own clock');
  assert.equal(toOnce(w({ freq: 'once', onceMode: 'at', at: 'tomorrow' })), undefined);
  assert.equal(toOnce(w({ freq: 'daily' })), undefined);
  // A one-time schedule opened for editing: its moment, on this computer's clock.
  const back = fromTiming({ at: new Date(2030, 0, 2, 9, 30).getTime() });
  assert.deepEqual([back.freq, back.onceMode, back.at], ['once', 'at', '2030-01-02T09:30']);
});

test('every template is complete and makes a valid timing', () => {
  for (const t of TEMPLATES) {
    const when = w(t.draft.when ?? {});
    const cron = toCron(when), once = toOnce(when);
    assert.ok(cron || once, `${t.id} has a timing`);
    if (cron) assert.ok(nextCron(cron, Date.now()), `${t.id}: ${cron} runs`);
    assert.ok(t.draft.prompt && t.draft.prompt.length > 20, `${t.id} has a prompt`);
    assert.ok(['dontAsk', 'auto', 'acceptEdits', 'default'].includes(t.draft.asks!), `${t.id} says how it asks`);
  }
});
