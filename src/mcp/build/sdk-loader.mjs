// Lets a server the harness built run from its own folder without `npm install`: its imports of the MCP SDK
// (and zod, DuckDB) resolve from the harness's own installation. The harness starts it with
//   node --import <this file's URL> server.ts
// The server's code is unchanged: elsewhere, `npm install` in its folder gives it the same packages.
import { register } from 'node:module';

register(new URL('./sdk-hooks.mjs', import.meta.url), import.meta.url);
