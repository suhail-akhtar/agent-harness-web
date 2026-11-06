import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The guide (docs/guide) stays true: what can be generated is, and every link and file it names exists.

const root = path.resolve('.');
const guide = path.join(root, 'docs', 'guide');
const pages = fs.readdirSync(guide).filter((f) => f.endsWith('.md'));
const read = (f: string) => fs.readFileSync(path.join(guide, f), 'utf8');
/** Text without code blocks and inline code: what is prose. */
const prose = (s: string) => s.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
/** GitHub's anchor for a heading. */
const slug = (h: string) => h.trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
function anchors(file: string): Set<string> {
  const out = new Set<string>();
  let fenced = false;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*```/.test(l)) fenced = !fenced;
    const m = !fenced && /^#{1,6}\s+(.*)$/.exec(l);
    if (m) out.add(slug(m[1]!));
  }
  return out;
}

test('the generated reference is current', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/docs-facts.mjs', '--check'], { encoding: 'utf8', cwd: root, timeout: 120_000 });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
});

test('every guide is in the index', () => {
  const index = read('README.md');
  for (const p of pages) if (p !== 'README.md') assert.ok(index.includes(`(${p})`), `${p} is not linked from docs/guide/README.md`);
});

test('every relative link in the guide resolves, anchors included', () => {
  const broken: string[] = [];
  for (const p of pages) {
    for (const m of prose(read(p)).matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]!;
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [file, anchor] = href.split('#');
      const target = file ? path.resolve(guide, file) : path.join(guide, p);
      if (!fs.existsSync(target)) { broken.push(`${p}: ${href}`); continue; }
      if (anchor && target.endsWith('.md') && !anchors(target).has(anchor)) broken.push(`${p}: ${href} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every repository file a guide names exists', () => {
  const missing: string[] = [];
  const named = /`((?:src|apps|packages|plugins|solutions|scripts|test|examples|kit|docs)\/[\w./-]+\.[a-z]{1,5})`/g;
  for (const p of pages) for (const m of read(p).matchAll(named)) if (!fs.existsSync(path.join(root, m[1]!))) missing.push(`${p}: ${m[1]}`);
  assert.deepEqual(missing, []);
});

test('the handwritten guides leave version numbers to the generated reference', () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  for (const p of pages) {
    if (p.startsWith('07-')) continue;
    // The kit's file name in a shell example is the one place a version is needed, and that page says so.
    assert.ok(!prose(read(p)).includes(version), `${p} states the version ${version}: link to 07-generated-reference.md`);
  }
});

test('the worked example stays in the kit', () => {
  const pack = fs.readFileSync(path.join(root, 'scripts', 'pack-kit.mjs'), 'utf8');
  assert.match(pack, /copy\('docs\/guide'\)/);
  assert.match(pack, /copy\('examples\/guide'/);
  assert.ok(execFileSync('git', ['ls-files', 'examples/guide/expense-review/harness-plugin.json'], { encoding: 'utf8', cwd: root }).trim() || fs.existsSync(path.join(root, 'examples/guide/expense-review/harness-plugin.json')));
});
