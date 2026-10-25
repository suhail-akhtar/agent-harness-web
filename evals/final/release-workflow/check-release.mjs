// Hidden checks for the release workflow case, one part per mode:
//   workflow  .harness/workflows/release.json is a graph the harness accepts, with a test step, an approval and a failed end
//   release   v1.3.0 (a feat and a fix since v1.2.0): package.json, the changelog section, the release commit, the annotated tag, tests pass
//   ran       the session's run record of that workflow: succeeded, through an approval that was approved
//   node check-release.mjs <workspace> <mode>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ws = path.resolve(process.argv[2] ?? '.');
const mode = process.argv[3];
const fails = [];
const check = (name, cond, got) => { if (!cond) fails.push(`${name}${got === undefined ? '' : `: got ${JSON.stringify(got).slice(0, 300)}`}`); };
const git = (...a) => { try { return execFileSync('git', a, { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `ERROR ${e.stderr ?? e.message}`; } };

if (mode === 'workflow') {
  const file = path.join(ws, '.harness', 'workflows', 'release.json');
  let w;
  try { w = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`FAIL no readable ${file}: ${e.message}`); process.exit(1); }
  const { validateWorkflow } = await import(pathToFileURL(path.join(repo, 'src', 'graph', 'validate.ts')).href);
  const problems = validateWorkflow(w);
  check('the harness accepts the graph', problems.length === 0, problems);
  const nodes = Object.values(w.nodes ?? {});
  const text = (n) => JSON.stringify(n).toLowerCase();
  check('an approval step', nodes.some((n) => n.type === 'approval'));
  check('a step that runs the tests', nodes.some((n) => (n.type === 'shell' && /test/.test(String(n.command ?? n.run ?? ''))) || (n.type === 'gate') || (n.type === 'agent' && /\btests?\b/.test(text(n)))));
  check('an end that fails', nodes.some((n) => n.type === 'end' && n.status === 'failed'));
  check('a tag step', nodes.some((n) => /git\s+tag|annotated tag|\btag\b/.test(text(n))));
} else if (mode === 'release') {
  const pkg = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));
  check('package.json is 1.3.0', pkg.version === '1.3.0', pkg.version);
  const log = fs.readFileSync(path.join(ws, 'CHANGELOG.md'), 'utf8');
  const i13 = log.search(/^##\s*\[?v?1\.3\.0/m);
  const i12 = log.search(/^##\s*\[?v?1\.2\.0/m);
  check('a 1.3.0 section above 1.2.0', i13 >= 0 && i12 > i13, { i13, i12 });
  const section = i13 >= 0 ? log.slice(i13, i12 > i13 ? i12 : undefined) : '';
  check('Features and Fixes', /features/i.test(section) && /fix(es)?/i.test(section), section);
  check('the feature is listed', /maxlength/i.test(section), section);
  check('the fix is listed', /dash/i.test(section), section);
  check('the docs commit is not a feature or fix line', !/document maxlength/i.test(section), section);
  check('v1.3.0 is an annotated tag', git('cat-file', '-t', 'v1.3.0') === 'tag', git('cat-file', '-t', 'v1.3.0'));
  check('the tag is on the release commit', git('log', '-1', '--format=%s', 'v1.3.0') === 'chore(release): v1.3.0', git('log', '-1', '--format=%s', 'v1.3.0'));
  check('the release commit has the version', /"version":\s*"1\.3\.0"/.test(git('show', 'v1.3.0:package.json')));
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean).filter((l) => !/\s\.harness\//.test(l));
  check('nothing left uncommitted', dirty.length === 0, dirty);
  const t = spawnSync('npm', ['test'], { cwd: ws, shell: true, encoding: 'utf8', timeout: 90_000 });
  check('tests pass', t.status === 0, (t.stdout + t.stderr).slice(-400));
} else if (mode === 'ran') {
  const sessions = path.join(ws, '..', 'data', 'sessions');
  const runs = [];
  for (const s of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
    const d = path.join(sessions, s, 'runs');
    for (const f of fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('.json')) : []) {
      try { runs.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch { /* partial */ }
    }
  }
  const mine = runs.filter((r) => r.workflow === 'release');
  check('a run of the release workflow', mine.length > 0, runs.map((r) => r.workflow));
  // The release run: one that succeeded through an approved approval (a later run may rightly find nothing to release).
  const approved = (r) => r.history?.some((h) => h.type === 'approval' && /approve/i.test(String(h.outcome)));
  check('a run succeeded', mine.some((r) => r.status === 'succeeded'), mine.map((r) => `${r.status}${r.error ? `: ${r.error}` : ''}`));
  check('it went through an approval, approved', mine.some((r) => r.status === 'succeeded' && approved(r)), mine.map((r) => r.history?.map((h) => `${h.node}:${h.type}:${h.outcome}`).join(' > ')));
} else {
  console.log('usage: node check-release.mjs <workspace> workflow|release|ran');
  process.exit(2);
}
for (const f of fails) console.log(`FAIL ${f}`);
console.log(fails.length ? `${fails.length} failed` : `ok (${mode})`);
process.exit(fails.length ? 1 : 0);
