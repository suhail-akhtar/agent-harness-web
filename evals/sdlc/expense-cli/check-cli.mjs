// Hidden check: drives the finished CLI as another program would.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ws = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
const data = path.join(dir, 'data.json');
const run = (...args) => {
  const r = spawnSync(process.execPath, [path.join(ws, 'expenses.js'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, EXPENSES_FILE: data } });
  // Node's own warnings (an experimental proxy agent on some hosts) are not the program's output.
  const err = r.stderr.split('\n').filter((l) => !/^\(node:\d+\) |^\(Use `node --trace-warnings/.test(l)).join('\n');
  return { out: r.stdout.trim(), err: err.trim(), code: r.status };
};
const fails = [];
const expect = (what, cond, got) => { if (!cond) fails.push(`${what}: got ${JSON.stringify(got)}`); };

let r = run('--help');
expect('help exits 0 and names every command', r.code === 0 && ['add', 'list', 'delete', 'summary', 'export'].every((c) => r.out.includes(c)), r);
r = run('list');
expect('empty list', r.out === 'No expenses.' && r.code === 0, r);
expect('add 1', run('add', '12.5', 'Food', '--date', '2026-03-02', '--note', 'lunch "big"').out === 'Added #1', 'add1');
expect('add 2', run('add', '40', 'travel', '--date', '2026-03-01').out === 'Added #2', 'add2');
expect('add 3', run('add', '7.25', 'food', '--date', '2026-04-10').out === 'Added #3', 'add3');
r = run('list');
expect('list order and format', r.out === '#2 2026-03-01 travel 40.00\n#1 2026-03-02 food 12.50 - lunch "big"\n#3 2026-04-10 food 7.25', r.out);
r = run('list', '--month', '2026-03', '--category', 'food');
expect('list filters', r.out === '#1 2026-03-02 food 12.50 - lunch "big"', r.out);
r = run('summary');
expect('summary', r.out === 'food: 19.75\ntravel: 40.00\ntotal: 59.75', r.out);
r = run('summary', '--month', '2026-04');
expect('summary by month', r.out === 'food: 7.25\ntotal: 7.25', r.out);
const before = fs.readFileSync(data, 'utf8');
for (const bad of [['add', '-5', 'food'], ['add', '1.234', 'food'], ['add', '10', 'food', '--date', '2026-13-40'], ['add', '10'], ['frobnicate'], ['delete', 'abc']]) {
  r = run(...bad);
  expect(`rejects ${bad.join(' ')}`, r.code === 1 && /^Error:/.test(r.err), r);
}
expect('invalid input leaves the data alone', fs.readFileSync(data, 'utf8') === before, 'data changed');
r = run('delete', '9');
expect('unknown id', r.code === 1 && r.err === 'No expense #9', r);
expect('delete', run('delete', '2').out === 'Deleted #2', 'delete');
expect('ids never repeat', run('add', '1', 'misc', '--date', '2026-05-01').out === 'Added #4', 'id reuse');
const csv = path.join(dir, 'out.csv');
r = run('export', csv);
expect('export message', r.out === `Exported 3 expenses to ${csv}`, r.out);
const rows = fs.existsSync(csv) ? fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/) : [];
expect('csv', rows[0] === 'id,date,category,amount,note' && /^1,2026-03-02,food,12\.50?,"lunch ""big"""$/.test(rows[1] ?? '') && rows.length === 4, rows);
r = run('list');
expect('persistence across runs', r.out.split('\n').length === 3, r.out);

if (fails.length) { console.log(`${fails.length} failure(s):\n${fails.join('\n')}`); process.exit(1); }
console.log('all end-to-end checks passed');
