// Hidden checks for fix-ci, in the ops image:
//   node check-ci.mjs <workspace> lint    actionlint passes on every workflow
//   node check-ci.mjs <workspace> steps   the test job's run: steps all pass (the devops plugin's run-local),
//                                         and it still runs the tests and the lint
//   node check-ci.mjs <workspace> tests   the test file is the one the task started with
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, inOps } from '../lib/ops.mjs';
import { formatRunLocal, runLocalCommand } from '../../../plugins/devops/lib/ci.mjs';

const [ws, what] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));

if (what === 'lint') {
  const r = inOps(ws, 'actionlint .github/workflows/*.yml');
  finish(r.code === 0 ? [] : [`actionlint:\n${r.out.slice(-1500)}`], 'actionlint passes');
}
if (what === 'tests') {
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const ok = fs.existsSync(path.join(ws, 'test/calc.test.mjs')) && hash(path.join(ws, 'test/calc.test.mjs')) === hash(path.join(here, 'fixtures/test/calc.test.mjs'));
  finish(ok ? [] : ['test/calc.test.mjs was changed or removed: the tests were right, the code was wrong'], 'tests unchanged');
}
const wf = fs.readFileSync(path.join(ws, '.github/workflows/ci.yml'), 'utf8');
const problems = [];
if (!/npm test/.test(wf)) problems.push('the workflow no longer runs npm test');
if (!/npm run lint/.test(wf)) problems.push('the workflow no longer runs npm run lint');
const r = inOps(ws, runLocalCommand('.github/workflows/ci.yml', 'test', 300));
let res;
try { res = JSON.parse(r.out.split('__HW_RESULT__')[1]); } catch { problems.push(`run-local did not run: ${r.out.slice(-800)}`); }
if (res) {
  const f = formatRunLocal(res, 'ci.yml');
  if (!f.ok) problems.push(f.text);
  if ((res.steps ?? []).filter((s) => s.status === 'ok').length < 2) problems.push(`fewer than two run steps passed:\n${f.text}`);
}
finish(problems, 'the job\'s steps pass');
