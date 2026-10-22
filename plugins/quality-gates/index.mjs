// Quality gates: each one proves (or disproves) something about the work, using
// the project's own toolchain where the code runs (sandbox, server folder, or
// the companion with --allow-hooks). A gate applies only when its stack is
// present, so "run every applicable gate" is right for any repository.

const EXCLUDE = ['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv', 'venv', '__pycache__', '.harness', 'coverage', 'vendor'];
const grepExcludes = EXCLUDE.map((d) => `--exclude-dir=${d}`).join(' ');
const pruneArgs = EXCLUDE.map((d) => `-path ./${d} -prune`).join(' -o ');
const tail = (s, n = 80) => s.trim().split('\n').slice(-n).join('\n');
const sh = (host, cmd, signal, timeoutMs = 600_000) => host.exec(cmd, { timeoutMs, signal });
const has = async (host, test, signal) => (await sh(host, test, signal, 20_000)).code === 0;

/**
 * Runs grep and keeps ITS exit status (0 found, 1 none, 2 error). Piping into
 * head reported head's status, so a missing grep or a failed scan read as "nothing found".
 */
async function scan(host, args, signal, timeoutMs, limit = 20) {
  const r = await sh(host, `e=$(mktemp); out=$(grep ${args} . 2>"$e"); c=$?; printf '%s' "$out" | head -${limit}; [ $c -gt 1 ] && { printf '\n__SCAN_ERROR__ '; head -c 300 "$e"; }; rm -f "$e"; exit $c`, signal, timeoutMs);
  const [hits, err] = r.stdout.split('__SCAN_ERROR__ ');
  const error = r.timedOut ? 'the scan timed out' : r.code > 1 && !hits.trim() ? `the scan failed: ${(err ?? r.stderr).trim().slice(0, 300) || `exit ${r.code}`}` : undefined;
  return { hits: hits.trim(), error };
}
const couldNotScan = (error) => ({ pass: false, summary: `could not scan (${error})`, details: 'A check that could not run is not a pass. Make sure grep is available where the gates run.' });

async function pkg(host, signal) {
  const r = await sh(host, 'cat package.json 2>/dev/null', signal, 10_000);
  try { return JSON.parse(r.stdout); } catch { return undefined; }
}
const realScript = (p, name) => {
  const s = p?.scripts?.[name];
  return typeof s === 'string' && s.trim() && !/no test specified/.test(s);
};

/**
 * The test counts in a test runner's output (node:test, Jest, Vitest, Mocha, pytest, unittest,
 * go test -v, cargo, Maven/Gradle), or undefined. They go into the gate's summary - "(12 tests:
 * 11 passed, 1 failed)" - so a workflow's gate node, the quality_gates tool and the desktop's
 * Engineering pages show them without the whole output.
 */
export function testCounts(out) {
  const t = String(out ?? '');
  const last = (re) => { let v; for (const m of t.matchAll(re)) v = Number(m[1]); return v; };
  const word = (text, w) => Number(new RegExp(`(\\d+) ${w}`).exec(text)?.[1] ?? 0);
  // node:test (TAP): "# tests 12", "# pass 11", "# fail 1", "# skipped 0", "# todo 0"
  if (/^# tests \d+/m.test(t)) {
    return { total: last(/^# tests (\d+)/gm), passed: last(/^# pass (\d+)/gm) ?? 0, failed: last(/^# fail (\d+)/gm) ?? 0, skipped: (last(/^# skipped (\d+)/gm) ?? 0) + (last(/^# todo (\d+)/gm) ?? 0) };
  }
  // Jest: "Tests:       1 failed, 11 passed, 12 total"
  const jest = /^\s*Tests:\s+(.*\d+ total)/m.exec(t);
  if (jest) return { total: word(jest[1], 'total'), passed: word(jest[1], 'passed'), failed: word(jest[1], 'failed'), skipped: word(jest[1], 'skipped') + word(jest[1], 'todo') };
  // Vitest: "Tests  11 passed | 1 failed (12)"
  const vitest = /^\s*Tests\s+(.*)\((\d+)\)\s*$/m.exec(t);
  if (vitest) return { total: Number(vitest[2]), passed: word(vitest[1], 'passed'), failed: word(vitest[1], 'failed'), skipped: word(vitest[1], 'skipped') + word(vitest[1], 'todo') };
  // pytest: "11 passed, 1 failed, 2 skipped in 0.12s"
  const py = /(\d+ (?:passed|failed)[^\n]*?) in [\d.]+s/m.exec(t);
  if (py) {
    const passed = word(py[1], 'passed'); const failed = word(py[1], 'failed') + word(py[1], 'errors?'); const skipped = word(py[1], 'skipped');
    return { total: passed + failed + skipped, passed, failed, skipped };
  }
  // unittest: "Ran 12 tests in 0.01s", then "OK" or "FAILED (failures=1, errors=0)"
  const ran = /^Ran (\d+) tests? in/m.exec(t);
  if (ran) {
    const total = Number(ran[1]); const failed = Number(/failures=(\d+)/.exec(t)?.[1] ?? 0) + Number(/errors=(\d+)/.exec(t)?.[1] ?? 0); const skipped = Number(/skipped=(\d+)/.exec(t)?.[1] ?? 0);
    return { total, passed: total - failed - skipped, failed, skipped };
  }
  // Mocha: "11 passing", "1 failing", "2 pending"
  if (/^\s*\d+ passing/m.test(t)) {
    const passed = last(/^\s*(\d+) passing/gm) ?? 0; const failed = last(/^\s*(\d+) failing/gm) ?? 0; const skipped = last(/^\s*(\d+) pending/gm) ?? 0;
    return { total: passed + failed + skipped, passed, failed, skipped };
  }
  // cargo: "test result: ok. 11 passed; 1 failed; 0 ignored", summed over the test binaries
  const cargo = [...t.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) {
    const sum = (i) => cargo.reduce((a, m) => a + Number(m[i]), 0);
    return { total: sum(1) + sum(2) + sum(3), passed: sum(1), failed: sum(2), skipped: sum(3) };
  }
  // Maven / Gradle (surefire): the last "Tests run: 12, Failures: 1, Errors: 0, Skipped: 0" is the total
  const mvn = [...t.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g)].at(-1);
  if (mvn) { const failed = Number(mvn[2]) + Number(mvn[3]); return { total: Number(mvn[1]), passed: Number(mvn[1]) - failed - Number(mvn[4]), failed, skipped: Number(mvn[4]) }; }
  // go test -v: one "--- PASS:", "--- FAIL:" or "--- SKIP:" line per test
  const count = (re) => (t.match(re) ?? []).length;
  const go = { passed: count(/^\s*--- PASS: /gm), failed: count(/^\s*--- FAIL: /gm), skipped: count(/^\s*--- SKIP: /gm) };
  if (go.passed + go.failed + go.skipped) return { total: go.passed + go.failed + go.skipped, ...go };
  return undefined;
}

/** " (12 tests: 11 passed, 1 failed)" for a gate's summary, or "". */
export function countsText(c) {
  if (!c || !Number.isFinite(c.total)) return '';
  const parts = [`${c.passed} passed`, ...(c.failed ? [`${c.failed} failed`] : []), ...(c.skipped ? [`${c.skipped} skipped`] : [])];
  return ` (${c.total} test${c.total === 1 ? '' : 's'}: ${parts.join(', ')})`;
}

function commandGate({ name, description, applies, command, severity, counts = false }) {
  return {
    name, description,
    applies: (host, signal) => applies(host, signal),
    async run({ host, signal }) {
      const cmd = typeof command === 'function' ? await command(host, signal) : command;
      const r = await sh(host, cmd, signal);
      const out = tail(`${r.stdout}\n${r.stderr}`);
      if (r.timedOut) return { pass: false, summary: `timed out: ${cmd}`, details: out, severity };
      const c = counts ? countsText(testCounts(`${r.stdout}\n${r.stderr}`)) : '';
      return r.code === 0
        ? { pass: true, summary: `\`${cmd}\` passed${c}`, severity }
        : { pass: false, summary: `\`${cmd}\` exited ${r.code}${c}`, details: out, severity };
    },
  };
}

const gates = [
  // ---- Node / TypeScript ----
  commandGate({
    name: 'node-test', description: 'npm test',
    applies: async (h, s) => realScript(await pkg(h, s), 'test'),
    command: 'npm test --silent 2>&1', counts: true,
  }),
  commandGate({
    name: 'node-typecheck', description: 'TypeScript type check',
    applies: async (h, s) => { const p = await pkg(h, s); return realScript(p, 'typecheck') || (await has(h, 'test -f tsconfig.json', s) && !!(p?.devDependencies?.typescript || p?.dependencies?.typescript)); },
    command: async (h, s) => (realScript(await pkg(h, s), 'typecheck') ? 'npm run --silent typecheck 2>&1' : 'npx --no-install tsc --noEmit -p . 2>&1'),
  }),
  commandGate({
    name: 'node-lint', description: 'npm run lint',
    applies: async (h, s) => realScript(await pkg(h, s), 'lint'),
    command: 'npm run --silent lint 2>&1',
  }),
  commandGate({
    name: 'node-build', description: 'npm run build',
    applies: async (h, s) => realScript(await pkg(h, s), 'build'),
    command: 'npm run --silent build 2>&1',
  }),
  // ---- Python ----
  commandGate({
    name: 'python-test', description: 'pytest (or unittest)',
    applies: (h, s) => has(h, `command -v python3 >/dev/null && find . \\( ${pruneArgs} \\) -o \\( -name 'test_*.py' -o -name '*_test.py' -o -name conftest.py \\) -print -quit | grep -q .`, s),
    command: 'if python3 -c "import pytest" 2>/dev/null; then python3 -m pytest -q 2>&1; else python3 -m unittest discover -q 2>&1; fi', counts: true,
  }),
  // Blocking only when the project configures ruff; otherwise its defaults are advice.
  {
    name: 'python-lint', description: 'ruff check',
    applies: (h, s) => has(h, `command -v ruff >/dev/null && find . \\( ${pruneArgs} \\) -o -name '*.py' -print -quit | grep -q .`, s),
    async run({ host, signal }) {
      const configured = await has(host, "test -f ruff.toml || test -f .ruff.toml || grep -qs '\\[tool.ruff' pyproject.toml", signal);
      const r = await sh(host, 'ruff check . 2>&1', signal);
      const severity = configured ? 'blocking' : 'advisory';
      return r.code === 0 ? { pass: true, summary: 'ruff passed', severity } : { pass: false, summary: `ruff found problems${configured ? '' : ' (project has no ruff config: advisory)'}`, details: tail(r.stdout), severity };
    },
  },
  // ---- Go / Rust / Java ----
  commandGate({ name: 'go-test', description: 'go vet + go test', applies: (h, s) => has(h, 'test -f go.mod && command -v go >/dev/null', s), command: 'go vet ./... 2>&1 && go test -v ./... 2>&1', counts: true }),
  commandGate({ name: 'rust-test', description: 'cargo test', applies: (h, s) => has(h, 'test -f Cargo.toml && command -v cargo >/dev/null', s), command: 'cargo test --quiet 2>&1', counts: true }),
  commandGate({
    name: 'java-test', description: 'Maven or Gradle tests',
    applies: (h, s) => has(h, '{ test -f pom.xml && command -v mvn >/dev/null; } || test -f gradlew || { test -f build.gradle && command -v gradle >/dev/null; } || { test -f build.gradle.kts && command -v gradle >/dev/null; }', s),
    command: 'if [ -f pom.xml ]; then mvn -q test 2>&1; elif [ -f gradlew ]; then ./gradlew test -q 2>&1; else gradle test -q 2>&1; fi', counts: true,
  }),
  // ---- Any repository ----
  {
    name: 'secrets', description: 'No private keys or credentials in source files',
    async run({ host, signal }) {
      const pattern = [
        '-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----',
        'AKIA[0-9A-Z]{16}',
        'gh[pousr]_[A-Za-z0-9]{36}',
        'sk-ant-[A-Za-z0-9_-]{20,}',
        'sk-(proj-)?[A-Za-z0-9]{32,}',
        'xox[baprs]-[A-Za-z0-9-]{10,}',
        '(api[_-]?key|secret|token|passw(or)?d)["\']?[[:space:]]*[:=][[:space:]]*["\'][A-Za-z0-9_/+=-]{20,}["\']',
      ].join('|');
      const { hits, error } = await scan(host, `-rIEin ${grepExcludes} --exclude='*.lock' --exclude='package-lock.json' -e '${pattern.replace(/'/g, "'\\''")}'`, signal, 120_000);
      if (error && !hits) return couldNotScan(error);
      if (!hits) return { pass: true, summary: 'no credentials found' };
      // Never echo the secret itself.
      const redacted = hits.split('\n').map((l) => l.replace(/^([^:]+:\d+):.*$/, '$1: possible credential')).join('\n');
      return { pass: false, summary: `${hits.split('\n').length} possible credential(s) in source`, details: `${redacted}\nMove them to environment variables or a secret store, and rotate any that were real.` };
    },
  },
  {
    name: 'conflict-markers', description: 'No unresolved merge-conflict markers',
    async run({ host, signal }) {
      const { hits, error } = await scan(host, `-rIEn ${grepExcludes} '^(<<<<<<< |>>>>>>> |=======$)'`, signal, 60_000);
      if (error && !hits) return couldNotScan(error);
      return hits ? { pass: false, summary: 'merge-conflict markers found', details: hits } : { pass: true, summary: 'no conflict markers' };
    },
  },
  {
    name: 'todo-markers', description: 'TODO/FIXME left in source (advisory)',
    async run({ host, signal }) {
      const { hits, error } = await scan(host, `-rIEn ${grepExcludes} --exclude='*.md' '\\b(TODO|FIXME|XXX|HACK)\\b'`, signal, 60_000, 30);
      if (error && !hits) return { ...couldNotScan(error), severity: 'advisory' };
      const n = hits ? hits.split('\n').length : 0;
      return n ? { pass: false, severity: 'advisory', summary: `${n}${n === 30 ? '+' : ''} TODO/FIXME marker(s)`, details: hits } : { pass: true, severity: 'advisory', summary: 'none' };
    },
  },
  {
    name: 'large-files', description: 'No files over 5 MB outside build output (advisory)',
    async run({ host, signal }) {
      const r = await sh(host, `find . \\( ${pruneArgs} \\) -o -type f -size +5M -print 2>/dev/null | head -20`, signal, 60_000);
      return r.stdout.trim() ? { pass: false, severity: 'advisory', summary: 'large files present', details: r.stdout.trim() } : { pass: true, severity: 'advisory', summary: 'none' };
    },
  },
];

/** The gates themselves, for plugins that build on one (devops' secrets-in-repo runs the secrets scan). */
export { gates };

export default {
  name: 'quality-gates',
  setup(api) {
    for (const g of gates) api.registerGate(g);
    api.log(`${gates.length} gates`);
  },
};
