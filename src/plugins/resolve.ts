import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// How plugin code reaches the harness and other plugins wherever it is installed (the server's shipped
// folder, <data>/plugins, a folder loaded in the desktop app, a packaged app without node_modules):
//   import { defineTool, resolveIn } from '@harness/plugin-sdk/runtime';   the harness's abilities
//   import { runJob } from '@harness/plugins/games3d/sdk/jobs.mjs';        another plugin's module, by name
// A synchronous hook in this thread (module.registerHooks): a plugin registered a moment ago resolves at once.
// In the harness checkout the same names also resolve without it (npm workspaces), so tests can import plugin
// files directly.

const SDK = pathToFileURL(path.join(import.meta.dirname, '..', '..', 'packages', 'plugin-sdk', 'src') + path.sep).href;
const SDK_FILES: Record<string, string> = { '@harness/plugin-sdk': 'index.ts', '@harness/plugin-sdk/runtime': 'runtime.ts', '@harness/plugin-sdk/testing': 'testing.ts', '@harness/plugin-sdk/ui': 'ui.ts' };
/** Plugin name -> its folder (a file URL ending in /). */
const dirs = new Map<string, string>();
/** Folders whose sub-folders are plugins by name (the checkout's plugins/: tests, scripts). */
const roots: string[] = [];
let registered = false;

function ensure(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, next) {
      const sdk = SDK_FILES[specifier];
      if (sdk) return { url: SDK + sdk, shortCircuit: true };
      const m = /^@harness\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/(.+)$/i.exec(specifier);
      if (m) {
        // Only files inside that plugin's folder.
        if (m[2]!.split(/[\\/]/).includes('..')) throw new Error(`${specifier}: a plugin's module path may not leave its folder`);
        const dir = dirs.get(m[1]!) ?? roots.map((r) => `${r}${m[1]}/`).find((u) => existsSync(fileURLToPath(u)));
        if (dir) return next(new URL(m[2]!, dir).href, context);
        try { return next(specifier, context); } catch {
          throw new Error(`The plugin "${m[1]}" is not on this server: ${specifier} cannot be imported${context.parentURL ? ` (by ${context.parentURL.replace(/^file:\/\//, '')})` : ''}. Install it, or declare it in "requires".`);
        }
      }
      return next(specifier, context);
    },
  });
}

/** Plugins found on this server (loaded or not): their modules resolve by name from now on. */
export function registerPluginDir(name: string, dir: string): void {
  ensure();
  dirs.set(name, pathToFileURL(path.resolve(dir) + path.sep).href);
}

/** A folder of plugin folders (named by folder): the fallback for names not registered. */
export function registerPluginRoot(dir: string): void {
  ensure();
  const u = pathToFileURL(path.resolve(dir) + path.sep).href;
  if (!roots.includes(u)) roots.push(u);
}

export function ensurePluginResolution(): void { ensure(); }
