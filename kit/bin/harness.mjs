#!/usr/bin/env node
// The kit's one command. Runs the engine from its TypeScript sources, as scripts/run.mjs does in the repository.
//   harness new <name> [--dir d]    an agent app of your own, linked to this kit
//   harness plugin <args>           new, test, check and bundle plugins (the SDK's tool)
//   harness start                   the server (http://127.0.0.1:4310; prints an access token)
//   harness run <args>              the command-line agent
//   harness users <args>            accounts on a shared server
//   harness verify [--key k.pem] [--archive f.tgz] [--lock]
//   harness version
// start and run check the kit's signature first and refuse a kit that differs from what was signed
// (HARNESS_KIT_VERIFY=off skips it). The limits of that check are in SECURITY.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);
const read = (f) => JSON.parse(fs.readFileSync(path.join(kit, f), 'utf8'));
const FLAGS = ['--disable-warning=ExperimentalWarning', '--disable-warning=UNDICI-EHPA', '--env-file-if-exists=.env'];

function node(entry, argv, opts = {}) {
  // Node's fetch uses HTTP(S)_PROXY only with this set; harmless without a proxy.
  const r = spawnSync(process.execPath, [...FLAGS, path.join(kit, entry), ...argv], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1' }, ...opts });
  return r.status ?? 1;
}
/** A long-running entry: a stop reaches it, so it can end its turns and close cleanly; then this process ends as it did. */
function forward(entry) {
  const child = spawn(process.execPath, [...FLAGS, path.join(kit, entry), ...args], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1' } });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  return new Promise(() => child.on('exit', (c, signal) => process.exit(c ?? (signal ? 1 : 0))));
}
const verified = () => process.env.HARNESS_KIT_VERIFY === 'off' || node('bin/verify.mjs', ['--quiet']) === 0;
const usage = () => { console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => /^\/\/ {3}harness /.test(l)).map((l) => l.slice(3)).join('\n')); return 2; };

function create(target) {
  if (!target) return usage();
  const dir = path.resolve(args.includes('--dir') ? args[args.indexOf('--dir') + 1] : target);
  const name = path.basename(path.resolve(target)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) { console.error(`${dir} is not empty`); return 1; }
  const from = path.join(kit, 'templates', 'app');
  const link = (p) => `file:${path.join(kit, p).split(path.sep).join('/')}`;
  fs.cpSync(from, dir, { recursive: true });
  // npm leaves dot-files of this name out of packages, so the template keeps them without the dot.
  for (const f of ['gitignore', 'env.example']) fs.renameSync(path.join(dir, f), path.join(dir, `.${f}`));
  for (const f of ['package.json', 'README.md']) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('__NAME__', name).replaceAll('__CORE__', link('.').replace(/\/\.$/, '')).replaceAll('__SDK__', link('packages/plugin-sdk')).replaceAll('__CLIENT__', link('packages/client')));
  }
  console.log(`${name}: in ${dir}\n\nNext:\n  cd ${path.relative(process.cwd(), dir) || '.'}\n  npm install\n  npm test\n  cp .env.example .env    (add a model key)\n  npm start -- "What can you do?"`);
  return 0;
}

let code;
switch (cmd) {
  case 'new': code = create(args[0]); break;
  case 'plugin': code = node('src/plugins/cli.ts', args); break;
  case 'users': code = node('src/server/users-cli.ts', args); break;
  case 'start': if (verified()) await forward('src/server/main.ts'); code = 1; break;
  case 'run': if (verified()) await forward('src/cli.ts'); code = 1; break;
  case 'verify': code = node('bin/verify.mjs', args); break;
  case 'version': case '--version': { const b = read('BUILD.json'); console.log(`harness ${b.version} (${b.commit.slice(0, 12)}${b.dirty ? ', dirty' : ''}, built ${b.builtAt}, node ${process.version})`); code = 0; break; }
  default: code = usage();
}
process.exit(code);
