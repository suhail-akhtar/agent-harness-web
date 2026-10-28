# Engineering

Software delivery on the harness: role agents (analyst, architect, planner, engineer, reviewers, tech writer), engineering skills, and the build-a-feature workflows with their quality gates and the Deliveries board. A solution of its own on the harness, built on the core through the plugin SDK only, with its own version, tests, evals and docs.

| | |
|---|---|
| Version | 1.2.0 ([CHANGELOG.md](CHANGELOG.md)) |
| Core | `>=0.2.4 <0.3.0` (the plugin's `engines.harness`) |
| Publisher | Suhail Akhtar, MIT licence |

## What is here

```
solutions/engineering/
  package.json        version, the core versions it runs on, its plugins, its own app (harness.app)
  plugins/sdlc/      the plugin: tools, agents, skills, workflows, its pages, and its tests (test/)
  evals/sdlc/        its eval pack (npm run eval -- --packs sdlc)
  CHANGELOG.md
```

## How it ships

The harness desktop app is the base of both ways:

- **As a plugin, in the harness app you have**: one file, `engineering-1.2.0.tgz`. The desktop build writes it to `release/plugins`, signed by the publisher; `npm run bundle -w @harness/engineering` writes it too. In the app, open Plugins > Install from a file; it shows what is in the file and who signed it, then installs it. Engineering shows as **Official** and **Verified**.
- **As its own app, Harness Engineering**: `npm run desktop:build -- --solution engineering` writes the installer to `apps/desktop/release-engineering`: the harness app with every feature, Engineering inside and installed, the window focused on it, its own home folder (`~/.harness-engineering`). `npm run desktop:dev -- --solution engineering` runs it from the checkout.
- **On a server**: in the harness checkout its plugin is a shipped plugin (offered under Plugins, installed on demand); elsewhere, from the file or a catalogue (`HARNESS_PLUGIN_CATALOGUE`).

## Tests

```bash
npm test -- --solution=engineering
```

The `*-stack`, `*-real`, `*-live` and `*e2e*` tests need Docker, real services or the desktop app, and skip themselves without them. The tests import the harness only through `@harness/plugin-sdk/testing`; a check in the core keeps it so.
