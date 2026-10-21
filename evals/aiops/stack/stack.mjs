// Controls the AIOps test stack (compose project hwtest-aiops).
//   node evals/aiops/stack/stack.mjs up            start it (keys made on first use) and wait until it is ready
//   node evals/aiops/stack/stack.mjs reset         clear every fault (and the cache volume's junk)
//   node evals/aiops/stack/stack.mjs break <f>     switch a fault on: slow | leak | crash | disk
//                                                  (fill-disk: the disk fault until the volume is full, then off)
//   node evals/aiops/stack/stack.mjs up-reset [f,..] up, reset, then those faults (what an eval's setup runs)
//   node evals/aiops/stack/stack.mjs status        what runs and which faults are on
//   node evals/aiops/stack/stack.mjs down          stop it and remove its volume
// The ssh key for user ops is in .state/keys; .state/secrets.json maps the vault
// names ops-db-1-key and ops-db-1-password to the key and the password, for HARNESS_OPS_SECRETS=@<that file> where a harness
// has no Key Vault. Only containers named hwtest-aiops-* are ever touched.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const state = path.join(here, '.state');
const keys = path.join(state, 'keys');
export const PORTS = { prometheus: 19090, http: 19180, https: 19443, ssh: 12222 };
export const SHOP = `http://127.0.0.1:${PORTS.http}`;
export const PROMETHEUS = `http://127.0.0.1:${PORTS.prometheus}`;
export const KEY_FILE = path.join(keys, 'id_ed25519');
export const SECRETS_FILE = path.join(state, 'secrets.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (...args) => {
  const r = spawnSync('docker', ['compose', '-p', 'hwtest-aiops', '-f', path.join(here, 'docker-compose.yml'), ...args], { encoding: 'utf8', cwd: here });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(-800)}`);
  return r.stdout;
};

function sshKeygen() {
  const win = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe');
  return win ? 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe' : 'ssh-keygen';
}

export function ensureKeys() {
  fs.mkdirSync(keys, { recursive: true });
  if (!fs.existsSync(KEY_FILE)) {
    const r = spawnSync(sshKeygen(), ['-q', '-t', 'ed25519', '-N', '', '-C', 'hwtest-aiops', '-f', KEY_FILE], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr || r.error?.message}`);
  }
  const pw = path.join(keys, 'password');
  if (!fs.existsSync(pw)) fs.writeFileSync(pw, crypto.randomBytes(18).toString('base64url'));
  const password = fs.readFileSync(pw, 'utf8').trim();
  fs.writeFileSync(SECRETS_FILE, JSON.stringify({ 'ops-db-1-key': fs.readFileSync(KEY_FILE, 'utf8'), 'ops-db-1-password': password }, null, 1));
  return { privateKey: fs.readFileSync(KEY_FILE, 'utf8'), publicKey: fs.readFileSync(`${KEY_FILE}.pub`, 'utf8'), password };
}

async function until(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

const banner = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const t = setTimeout(() => { s.destroy(); resolve(false); }, 3000);
  s.once('data', (b) => { clearTimeout(t); s.destroy(); resolve(b.toString().startsWith('SSH-')); });
  s.once('error', () => { clearTimeout(t); resolve(false); });
});

export async function waitReady() {
  await until('the shop', async () => (await fetch(`${SHOP}/health`)).ok);
  await until('Prometheus', async () => (await fetch(`${PROMETHEUS}/-/ready`)).ok);
  await until('the ssh server', () => banner(PORTS.ssh));
  await until('Prometheus to scrape the shop', async () => {
    const j = await (await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('up{job="demoapp"}')}`)).json();
    return j.data?.result?.[0]?.value?.[1] === '1';
  });
}

export async function up() {
  ensureKeys();
  compose('up', '-d', '--wait');
  await waitReady();
}

export async function reset() {
  const r = await fetch(`${SHOP}/admin/reset`, { method: 'POST' });
  if (!r.ok) throw new Error(`reset failed: HTTP ${r.status}`);
}

export async function breakIt(fault) {
  if (!['slow', 'leak', 'crash', 'disk'].includes(fault)) throw new Error(`unknown fault "${fault}" (slow, leak, crash, disk)`);
  const r = await fetch(`${SHOP}/admin/fault/${fault}?on=1`, { method: 'POST' });
  if (!r.ok) throw new Error(`break ${fault} failed: HTTP ${r.status}`);
}

/** The disk fault until the volume is full, then off again: what a runaway job leaves behind. */
export async function fillDisk() {
  await breakIt('disk');
  await until('the data volume to fill', async () => { const st = await (await fetch(`${SHOP}/admin/state`)).json(); return st.disk.size && st.disk.free / st.disk.size < 0.05; }, 60_000);
  const r = await fetch(`${SHOP}/admin/fault/disk?on=0`, { method: 'POST' });
  if (!r.ok) throw new Error(`fault disk off failed: HTTP ${r.status}`);
}

export async function status() {
  return { containers: compose('ps', '--format', '{{.Name}} {{.State}}').trim(), shop: await (await fetch(`${SHOP}/admin/state`)).json() };
}

export function down() { compose('down', '-v', '--remove-orphans'); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'up') { await up(); console.log(`ready: Prometheus ${PROMETHEUS}, shop ${SHOP}, https://127.0.0.1:${PORTS.https}, ssh ops@127.0.0.1:${PORTS.ssh}\nHARNESS_OPS_SECRETS=@${SECRETS_FILE}`); }
    else if (cmd === 'reset') { await reset(); console.log('faults cleared'); }
    else if (cmd === 'break') { await (arg === 'fill-disk' ? fillDisk() : breakIt(arg)); console.log(`fault ${arg} on`); }
    else if (cmd === 'up-reset') { await up(); await reset(); if (arg) { await sleep(3000); for (const f of arg.split(',')) await (f === 'fill-disk' ? fillDisk() : breakIt(f)); await sleep(20_000); } console.log(`ready${arg ? `, faults on: ${arg}` : ''}`); }
    else if (cmd === 'status') console.log(JSON.stringify(await status(), null, 1));
    else if (cmd === 'down') { down(); console.log('stopped and removed'); }
    else { console.error('usage: stack.mjs up | reset | break <slow|leak|crash|disk> | up-reset [faults] | status | down'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
