# The harness kit

The agent harness as a local, signed package: the engine, the core plugins and the SDK, with their dependencies inside. It needs Node 22.18 or later, and nothing from the network once it is unpacked.

## Install

Keep the kit outside any `node_modules` folder: Node runs its TypeScript directly, and refuses to do that inside one.

```bash
tar -xzf harness-kit-<version>.tgz
node harness-kit-<version>/bin/harness.mjs verify --lock
```

`verify --lock` checks every file against the publisher's signature, then makes the files read-only.

## Build an agent

```bash
node harness-kit-<version>/bin/harness.mjs new my-agent
cd my-agent
npm install
npm test
```

The app's `npm install` links to the kit, so it fetches nothing. `agent.ts` is the place to start.

## What to build with

| You want | Use |
|---|---|
| An agent inside your own program | `import { createHarness, defineTool } from '@harness/core'` |
| A front end for a harness server | `@harness/client` |
| Tools, pages, workflows and skills for the server and desktop app | a plugin: `harness plugin new <name>`, guide in `docs/plugin-sdk` |
| A server with accounts, the web interface and the API | `harness start` |
| One job from a script | `harness run` |

`examples/plugins` has complete plugins, from one tool to a whole app.

## Security

Read `SECURITY.md` for what the signature does and does not prove. `sbom.cdx.json` lists every dependency and `BUILD.json` the commit the kit was built from.
