# Operations

AI operations on the harness: an ops inventory (hosts, services, SLOs, alert rules, maintenance windows), monitoring and alerts, incidents with an investigation by agents, runbooks, Kubernetes, and the Operations console. A solution of its own on the harness, built on the core through the plugin SDK only, with its own version, tests, evals and docs.

| | |
|---|---|
| Version | 1.2.0 ([CHANGELOG.md](CHANGELOG.md)) |
| Core | `>=0.2.4 <0.3.0` (the plugin's `engines.harness`) |
| Publisher | Suhail Akhtar, MIT licence |

## What is here

```
solutions/operations/
  package.json        version, the core versions it runs on, its plugins, its own app (harness.app)
  plugins/aiops/      the plugin: tools, agents, skills, workflows, its pages, and its tests (test/)
  evals/aiops/        its eval pack (npm run eval -- --packs aiops)
  docs/               `docs/OPERATIONS.md` (the plan; on hold) and `docs/AIOps market research.md`
  CHANGELOG.md
```

## How it ships

The harness desktop app is the base of both ways:

- **As a plugin, in the harness app you have**: one file, `operations-1.2.0.tgz`. The desktop build writes it to `release/plugins`, signed by the publisher; `npm run bundle -w @harness/operations` writes it too. In the app, open Plugins > Install from a file; it shows what is in the file and who signed it, then installs it. Operations shows as **Official** and **Verified**.
- **As its own app, Harness Operations**: `npm run desktop:build -- --solution operations` writes the installer to `apps/desktop/release-operations`: the harness app with every feature, Operations inside and installed, the window focused on it, its own home folder (`~/.harness-operations`). `npm run desktop:dev -- --solution operations` runs it from the checkout.
- **On a server**: in the harness checkout its plugin is a shipped plugin (offered under Plugins, installed on demand); elsewhere, from the file or a catalogue (`HARNESS_PLUGIN_CATALOGUE`).

## Tests

```bash
npm test -- --solution=operations
```

The `*-stack`, `*-real`, `*-live` and `*e2e*` tests need Docker, real services or the desktop app, and skip themselves without them. The tests import the harness only through `@harness/plugin-sdk/testing`; a check in the core keeps it so.
