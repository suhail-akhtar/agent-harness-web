/**
 * The layout worker: ELK's own worker build (elkjs, pinned in packages/ui/package.json). Loaded in a
 * worker (no document), it answers elk-api's messages itself; elk.ts talks to it through elk-api.
 */

import 'elkjs/lib/elk-worker.min.js';
