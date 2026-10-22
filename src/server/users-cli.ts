// npm run users -- list | add <name> [--admin] | remove <id> | rotate <id> | disable <id> | enable <id>
// Manages accounts in the data folder (HARNESS_DATA, else the harness home's data/). Tokens are printed once.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserStore } from './users.ts';
import { harnessPaths } from '../util/home.ts';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const store = await new UserStore(harnessPaths({ legacy: path.join(appRoot, '.harness-data') }).dataDir).load();
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'list' || !cmd) {
    const all = store.list();
    if (!all.length) console.log('No accounts: the server is single-user (HARNESS_TOKEN).');
    for (const u of all) console.log(`${u.id}  ${u.role.padEnd(6)}  ${u.name}${u.sso ? '  (single sign-on)' : ''}${u.disabled ? '  (disabled)' : ''}`);
  } else if (cmd === 'add' && arg) {
    const r = await store.add(arg, process.argv.includes('--admin') ? 'admin' : 'member');
    console.log(`Created ${r.user.role} ${r.user.name} (${r.user.id}).\nToken (shown once): ${r.token}`);
  } else if (cmd === 'remove' && arg) console.log((await store.remove(arg)) ? 'Removed.' : 'No such account.');
  else if (cmd === 'rotate' && arg) console.log(`New token (shown once): ${await store.rotate(arg)}`);
  else if ((cmd === 'disable' || cmd === 'enable') && arg) { await store.setDisabled(arg, cmd === 'disable'); console.log('Done.'); }
  else { console.log('usage: npm run users -- list | add <name> [--admin] | remove <id> | rotate <id> | disable <id> | enable <id>'); process.exitCode = 2; }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
