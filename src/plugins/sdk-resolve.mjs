// Preloaded (node --import) where plugins' tests run: `npm run plugin -- test <dir>` and the harness's own
// suite. A plugin folder anywhere on the disk then imports '@harness/plugin-sdk' (and /runtime, /testing, /ui),
// another plugin's module by name ('@harness/plugins/<name>/...') and, in its tests, the harness's own files
// ('@harness/core/...') from this harness, with nothing installed in the folder (see resolve.ts).
import path from 'node:path';
import { registerPluginRoot } from './resolve.ts';

registerPluginRoot(path.join(import.meta.dirname, '..', '..', 'plugins'));
