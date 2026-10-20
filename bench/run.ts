import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/kernel/harness.ts';
import { run } from '../src/runtime/host.ts';

// A small, honest benchmark: each task starts from fixed files, the agent gets
// a plain-language request, and a HIDDEN check (never shown to the agent) runs
// afterwards. Reports pass/fail, cost, cache hit rate, tool calls and time.
//   npm run bench -- [--models deepseek-flash,gpt-6-luna] [--tasks fix-stats,slugify]

interface Task { id: string; prompt: string; files: Record<string, string>; check: string }

const TASKS: Task[] = [
  {
    id: 'fix-stats',
    prompt: 'The tests in test.js fail. Find and fix the bugs in stats.js until they pass. Keep the change minimal.',
    files: {
      'stats.js': 'function mean(xs) {\n  let s = 0;\n  for (let i = 0; i <= xs.length; i++) s += xs[i];\n  return s / xs.length;\n}\nfunction median(xs) {\n  const a = xs.sort();\n  const m = Math.floor(a.length / 2);\n  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;\n}\nmodule.exports = { mean, median };\n',
      'test.js': "const assert = require('assert');\nconst { mean, median } = require('./stats');\nassert.strictEqual(mean([1, 2, 3, 4]), 2.5);\nassert.strictEqual(median([10, 2, 33]), 10);\nassert.strictEqual(median([4, 1, 3, 2]), 2.5);\nconsole.log('ok');\n",
    },
    // Hidden cases of the same kind as the visible tests (nothing the prompt did not ask for).
    check: "node test.js && node -e \"const {mean,median}=require('./stats');if(median([100,9,20,3])!==14.5||mean([10,20])!==15||median([7])!==7)process.exit(1)\"",
  },
  {
    id: 'slugify',
    prompt: 'Implement slugify(text, options) in slug.js (CommonJS export). Lowercase; transliterate accented Latin letters to ASCII (é→e, ß→ss, ø→o); replace any run of non-alphanumeric characters with a single separator (options.separator, default "-"); trim separators from both ends; if options.maxLength is set, cut to at most that length without leaving a trailing separator. Add your own tests and make sure they pass.',
    files: { 'package.json': '{ "name": "slug", "version": "1.0.0" }\n' },
    check: "node -e \"const s=require('./slug.js');const slugify=s.slugify||s;const eq=(a,b)=>{if(a!==b){console.error(JSON.stringify(a),'!==',JSON.stringify(b));process.exit(1)}};eq(slugify('Hello, World!'),'hello-world');eq(slugify('  Crème Brûlée  '),'creme-brulee');eq(slugify('Straße & Søren',{separator:'_'}),'strasse_soren');eq(slugify('a---b___c'),'a-b-c');eq(slugify('***'),'');const t=slugify('The quick brown fox',{maxLength:12});if(t.length>12||t.endsWith('-')||!'the-quick-brown-fox'.startsWith(t)||t.length<9){console.error('maxLength gave',JSON.stringify(t));process.exit(1)}\"",
  },
  {
    id: 'rest-api',
    prompt: 'Create server.js: a dependency-free Node.js HTTP JSON API for notes, stored in memory. GET /notes lists notes; POST /notes with {"text"} creates one (400 with {"error"} if text is missing or empty), returning 201 and the note {id, text, createdAt}; GET /notes/:id returns one or 404; DELETE /notes/:id returns 204 or 404. Export a function createServer() that returns an http.Server without listening; when run directly, listen on PORT or 3000. Write tests with node:test and make sure they pass.',
    files: {},
    check: `node -e "
const {createServer}=require('./server.js');const srv=createServer();
srv.listen(0,async()=>{const b='http://127.0.0.1:'+srv.address().port;const f=(p,o)=>fetch(b+p,o);
const fail=(m)=>{console.error(m);process.exit(1)};
let r=await f('/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:''})});if(r.status!==400)fail('empty text '+r.status);
r=await f('/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'hi'})});if(r.status!==201)fail('create '+r.status);const n=await r.json();
if(!n.id||n.text!=='hi'||!n.createdAt)fail('shape');
r=await f('/notes/'+n.id);if(r.status!==200)fail('get');
r=await f('/notes');const all=await r.json();if(!Array.isArray(all)||all.length!==1)fail('list');
r=await f('/notes/'+n.id,{method:'DELETE'});if(r.status!==204)fail('delete');
r=await f('/notes/'+n.id);if(r.status!==404)fail('404');srv.close();})"`,
  },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const models = (arg('models') ?? 'deepseek-flash,gpt-6-luna').split(',');
  const only = arg('tasks')?.split(',');
  const tasks = TASKS.filter((t) => !only || only.includes(t.id));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-bench-'));
  const h = await createHarness({ dataDir });
  const rows: string[][] = [['model', 'task', 'result', 'cost $', 'cache hit', 'tool calls', 'seconds']];
  for (const model of models) {
    for (const task of tasks) {
      const dir = path.join(dataDir, `${model}-${task.id}`);
      await fs.mkdir(dir, { recursive: true });
      for (const [f, c] of Object.entries(task.files)) await fs.writeFile(path.join(dir, f), c);
      const s = await h.sessions.create({ model, mode: 'bypass', runtime: { kind: 'local', network: 'none', path: dir } });
      const t0 = Date.now();
      let calls = 0;
      const done = new Promise<void>((resolve) => s.subscribe(0, ({ event }) => {
        if (event.kind === 'tool_call') calls++;
        if (event.kind === 'notice' && event.level === 'error') console.error(`  [${model}/${task.id}] ${event.text}`);
        if (event.kind === 'turn_end' && !event.agent) resolve();
      }));
      await s.send(task.prompt);
      await done;
      const secs = Math.round((Date.now() - t0) / 1000);
      const verdict = await run('bash', ['-c', task.check], { cwd: dir, timeoutMs: 60_000 });
      const u = s.meta.usage;
      const prompt = u.input + u.cacheRead + u.cacheWrite;
      rows.push([model, task.id, verdict.code === 0 ? 'PASS' : `FAIL ${(verdict.stderr || verdict.stdout).trim().split('\n').pop()?.slice(0, 60) ?? ''}`, s.meta.cost.toFixed(5), `${prompt ? Math.round((u.cacheRead / prompt) * 100) : 0}%`, String(calls), String(secs)]);
      console.log(rows[rows.length - 1]!.join(' | '));
    }
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  console.log('\n' + rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
