#!/usr/bin/env node
// The scaffold works: a full skill is created with every part asked for, and a bad name is refused (exit 1).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const init = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'init_skill.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-creator-'));
const out = JSON.parse(execFileSync(process.execPath, [init, tmp, 'csv-tidy', 'Tidies CSV files: trims cells and drops empty rows.', '--scripts', '--references', '--tests', '--mcp'], { encoding: 'utf8' }));
const want = ['SKILL.md', 'scripts/run.py', 'tests/test_run.py', 'references/guide.md', 'mcp.json'];
const missing = want.filter((f) => !out.created.includes(f) || !fs.existsSync(path.join(tmp, 'csv-tidy', f)));
if (missing.length) { console.error('missing:', missing.join(', ')); process.exit(1); }
if (!/^---\nname: csv-tidy\n/.test(fs.readFileSync(path.join(tmp, 'csv-tidy', 'SKILL.md'), 'utf8'))) { console.error('bad frontmatter'); process.exit(1); }
if (spawnSync(process.execPath, [init, tmp, 'Bad Name', 'A description long enough to pass.'], { encoding: 'utf8' }).status !== 1) { console.error('a bad name was not refused'); process.exit(1); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok');
