# The guide

How the framework, the desktop app and the SDK work, and how to build your own systems on them.

| Read | When you want to know |
|---|---|
| [1. Overview](01-overview.md) | What it is, and what you get out of the box |
| [2. Architecture](02-architecture.md) | How it works inside, and where to change what |
| [3. Getting started](03-getting-started.md) | How to go from the kit to a running agent in ten minutes |
| [4. Build your system](04-build-your-system.md) | How to choose a way to build, with a full worked example |
| [5. Security model](05-security-model.md) | What is enforced, what is only reduced, and what is your job |
| [6. Operating](06-operating.md) | How to run, configure, watch and release it |
| [7. Generated reference](07-generated-reference.md) | Models, tools, plugins, agents, workflows, settings |

**New here?** Read 1, then 3, then 4.

## Other documents

| Document | What it covers |
|---|---|
| [README](../../README.md) | Every feature in detail: the full reference |
| [The plugin SDK](../plugin-sdk/README.md) | Plugins in depth |
| [Skills](../SKILLS.md) | Skills as packages |
| [Desktop design](../desktop/DESIGN.md) and [design system](../desktop/DESIGN-SYSTEM.md) | How the app is designed |
| [Changelog](../../CHANGELOG.md) | What changed in each version |

## Keeping this guide true

The guide is built to be updated, and the build fails when it drifts.

- **Facts that change are generated.** Models, prices, tools, plugins, agents, workflows, gates, hook events and settings live in [the generated reference](07-generated-reference.md). After changing any of them, run `npm run docs`.
- **`test/docs.test.ts`** fails when the generated reference differs from the code, when a link or anchor in any guide is broken, when a guide names a file that does not exist, or when a guide hard-codes the version.
- **The commands are run.** `scripts/check-guide.mjs` follows [Getting started](03-getting-started.md) and [Build your system](04-build-your-system.md) on a real kit with a real model, and the worked example's tests run with the plugin test tools.
- **The rule:** a change to behaviour updates its guide in the same commit.
