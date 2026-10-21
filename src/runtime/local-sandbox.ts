import crypto from 'node:crypto';
import path from 'node:path';
import { DockerHost, dockerAvailable, dockerDefaults, imageExists } from './docker.ts';
import { LocalHost, type ToolHost } from './host.ts';
import { chooseSandbox, detectOsSandbox, type LocalSandbox } from './os-sandbox.ts';

/**
 * A host for a folder on this machine with commands contained as asked: the OS
 * sandbox, Docker with the folder mounted, or none. Used by the companion, whose
 * folder is on someone's own computer.
 */
export async function sandboxedFolderHost(dir: string, want: LocalSandbox | 'auto', network: 'none' | 'full'): Promise<{ host: ToolHost; kind: LocalSandbox; why: string }> {
  const os = want === 'off' || want === 'docker' ? null : detectOsSandbox();
  const dockerOk = (want === 'docker' || (want === 'auto' && !os)) && await dockerAvailable() && await imageExists(dockerDefaults().image);
  const choice = chooseSandbox(want, { os, docker: dockerOk });
  if (choice.kind === 'docker') {
    // One container per folder, reused across runs of the companion.
    const id = `companion-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12)}`;
    return { host: new DockerHost(id, dir, { ...dockerDefaults(), network }), ...choice };
  }
  if (choice.kind === 'off') return { host: new LocalHost(dir), ...choice };
  return { host: new LocalHost(dir, { sandbox: choice.kind, network }), ...choice };
}
