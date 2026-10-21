// Inside a bubblewrap sandbox that has no network of its own (--unshare-net):
// listens on the sandbox's private loopback and passes every connection to the
// harness's egress proxy through a unix socket bound into the sandbox - the
// command's only way out. Then it runs the command and exits with its code.
//   node egress-bridge.mjs <socket> <port> <program> [args...]
// Plain JavaScript with no dependencies.

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

const [sock, port, prog, ...args] = process.argv.slice(2);
if (!sock || !port || !prog) {
  process.stderr.write('usage: node egress-bridge.mjs <socket> <port> <program> [args...]\n');
  process.exit(2);
}

const server = net.createServer((c) => {
  const u = net.connect(sock);
  c.on('error', () => u.destroy());
  u.on('error', () => c.destroy());
  c.pipe(u);
  u.pipe(c);
});
server.on('error', (e) => { process.stderr.write(`egress bridge: ${e.message}\n`); process.exit(126); });
server.listen(Number(port), '127.0.0.1', () => {
  const child = spawn(prog, args, { stdio: 'inherit' });
  child.on('error', (e) => { process.stderr.write(`egress bridge: ${e.message}\n`); process.exit(127); });
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 128 + (os.constants.signals[sig] ?? 1) : 1)));
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
});
