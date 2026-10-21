import { spawn } from 'node:child_process';
import net from 'node:net';

// Helpers for tests that run a real service in Docker (Ollama, Keycloak, a
// desktop). Every container and volume they make is named hwtest-..., so it is
// plain whose it is, and removed by the test that made it.

export function docker(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => p.kill(), opts.timeoutMs ?? 120_000);
    p.on('error', (err) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: String(err) }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
    p.stdin.end(opts.input ?? '');
  });
}

/** A free TCP port on the loopback interface (the OS picks one). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Polls until fetch(url) answers with a status check() accepts, or throws after timeoutMs. */
export async function waitForHttp(url: string, timeoutMs: number, check: (status: number) => boolean = (s) => s < 500): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer().catch(() => {});
      if (check(r.status)) return;
      last = `HTTP ${r.status}`;
    } catch (err) { last = (err as Error).message; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not come up in ${timeoutMs / 1000}s (${last})`);
}

/** Removes containers and volumes this test made; never touches anything else. */
export async function removeContainer(name: string, volumes: string[] = []): Promise<void> {
  if (!name.startsWith('hwtest-')) throw new Error(`refusing to remove ${name}: not a test container`);
  await docker(['rm', '-f', '-v', name], { timeoutMs: 60_000 });
  for (const v of volumes) {
    if (!v.startsWith('hwtest-')) throw new Error(`refusing to remove volume ${v}: not a test volume`);
    await docker(['volume', 'rm', '-f', v], { timeoutMs: 60_000 });
  }
}
