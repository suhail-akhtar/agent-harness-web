# Getting started

For someone with the kit archive and no other knowledge of the project. It takes about ten minutes, and every command here is run by `scripts/check-guide.mjs` before a release.

You need:

- **Node 22.18 or later.** Node runs the framework's TypeScript directly, so there is nothing to compile.
- **A model key**, for the steps that call a real model. The steps with a scripted model need none. Anthropic is used below; [Operating](06-operating.md#keys-and-providers) lists the others.
- **On Windows, Git for Windows**, because agents run their commands in Git Bash. Without it they fall back to PowerShell and have no background commands.

Docker is optional. Without it, an agent's commands run on your computer with your account's access. [Security model](05-security-model.md#6-where-code-runs) explains what that means.

## 1. Unpack and verify the kit

Keep the kit outside any `node_modules` folder: Node refuses to run TypeScript from inside one.

```bash
tar -xzf harness-kit-<version>.tgz
node harness-kit-<version>/bin/harness.mjs verify --lock
```

`verify` checks every file against the publisher's signature. `--lock` then makes the files read-only, so nothing changes them by accident. What the signature does and does not prove is in `SECURITY.md` in the kit.

Put your kit's version in place of `<version>`. From here on, `harness` means `node <path to the kit>/bin/harness.mjs`.

## 2. Make your first agent

```bash
harness new my-agent
cd my-agent
npm install
npm test
```

`harness new` writes a small project. `npm install` fetches nothing: it links the project to the kit. `npm test` runs the agent against a scripted model, so it needs no key and costs nothing.

| File | What it is |
|---|---|
| `agent.ts` | Your agent: its model, its tools, how much it may do without asking |
| `app.ts` | Runs it once from the command line. Put your own front end here |
| `test/agent.test.ts` | A test with a scripted model |
| `.env.example` | The keys it can use. Copy to `.env`, which git ignores |

## 3. Talk to a real model

```bash
cp .env.example .env
```

Put your key in `.env`, then:

```bash
npm start -- "Look up order A1 and tell me its status in one short sentence."
```

The model calls your `lookup_order` tool and answers from its result. The last line says what it cost.

Choose another model with the `MODEL` environment variable. [The generated reference](07-generated-reference.md#models) lists the models and their prices.

## 4. Change it

Open `agent.ts`. A tool is a name, a description the model reads, its parameters, a `kind` and a function:

```ts
export const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Finds an order by its number.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  kind: 'read',
  run: async (input) => JSON.stringify({ id: input.id, status: 'shipped' }),
});
```

Replace `run` with a call to your own system. `kind` is what the permission system judges a call by:

| Kind | Meaning |
|---|---|
| `read` | Reads and changes nothing |
| `edit` | Changes files or data |
| `exec` | Runs commands |
| `network` | Reaches the web |
| `external` | Acts on another system |
| `meta` | Works on the session itself |

The session in `agent.ts` uses the mode `dontAsk`: nobody is watching, so anything that would need a person's yes is refused instead of waiting. [Security model](05-security-model.md#3-permission-modes-and-rules) describes the other modes.

## 5. Run the server and the app

For the web interface and the HTTP API:

```bash
harness start
```

It listens on `127.0.0.1:4310` and prints an access token. Set `HARNESS_TOKEN` to choose your own.

For the desktop app, run `Harness Setup <version>.exe`. Windows warns that the publisher is unknown, because the installer has no code-signing certificate yet.

## Where next

- [Build your system](04-build-your-system.md): the four ways to build, with a full worked example.
- [Overview](01-overview.md#what-you-get-out-of-the-box): everything that comes with the framework.
- [Architecture](02-architecture.md): how it works inside.
