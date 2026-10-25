// Before the agent starts: a small library with a released v1.2.0 and three commits since (a feature, a fix, docs).
//   node setup.mjs <workspace>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ws = path.resolve(process.argv[2] ?? '.');
const env = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (...a) => execFileSync('git', a, { cwd: ws, env, stdio: 'pipe' });
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true }); fs.writeFileSync(path.join(ws, f), s); };
write('package.json', JSON.stringify({ name: 'slugify-lite', version: '1.2.0', type: 'module', main: 'index.js', scripts: { test: 'node --test' } }, null, 2) + '\n');
write('index.js', "export function slugify(s) {\n  return String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');\n}\n");
write('index.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from './index.js';\ntest('slugify', () => { assert.equal(slugify('Héllo World'), 'hello-world'); });\n");
write('CHANGELOG.md', '# Changelog\n\n## 1.2.0 - 2026-09-14\n\n### Features\n\n- Accents are removed (é becomes e).\n');
write('README.md', '# slugify-lite\n\n`slugify(text)` makes a URL slug.\n');
write('.gitignore', 'node_modules\n');
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
git('add', '-A'); git('commit', '-q', '-m', 'feat: remove accents');
git('tag', '-a', 'v1.2.0', '-m', 'v1.2.0');
write('index.js', "export function slugify(s, { maxLength } = {}) {\n  let out = String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');\n  if (maxLength) out = out.slice(0, maxLength);\n  return out;\n}\n");
git('commit', '-q', '-am', 'feat: add a maxLength option');
write('index.js', "export function slugify(s, { maxLength } = {}) {\n  let out = String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n  if (maxLength) out = out.slice(0, maxLength).replace(/-+$/, '');\n  return out;\n}\n");
write('index.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from './index.js';\ntest('slugify', () => { assert.equal(slugify('Héllo World'), 'hello-world'); });\ntest('trims dashes', () => { assert.equal(slugify('  -Hi there!- '), 'hi-there'); });\ntest('maxLength', () => { assert.equal(slugify('one two three', { maxLength: 7 }), 'one-two'); });\n");
git('commit', '-q', '-am', 'fix: trim leading and trailing dashes');
write('README.md', '# slugify-lite\n\n`slugify(text, { maxLength })` makes a URL slug.\n');
git('commit', '-q', '-am', 'docs: document maxLength');
console.log('repository ready: v1.2.0 and 3 commits since');
