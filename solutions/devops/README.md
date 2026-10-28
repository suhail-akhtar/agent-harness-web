# DevOps

DevOps on the harness: Terraform/OpenTofu plan and an approved-plan apply, Kubernetes validate, diff, apply, rollout and undo, GitHub Actions and CI runs, with the change journal and its approvals. A solution of its own on the harness, built on the core through the plugin SDK only, with its own version, tests, evals and docs.

| | |
|---|---|
| Version | 1.1.0 ([CHANGELOG.md](CHANGELOG.md)) |
| Core | `>=0.2.4 <0.3.0` (the plugin's `engines.harness`) |
| Publisher | Suhail Akhtar, MIT licence |

## What is here

```
solutions/devops/
  package.json        version, the core versions it runs on, its plugins, its own app (harness.app)
  plugins/devops/      the plugin: tools, agents, skills, workflows, and its tests (test/)
  evals/devops/        its eval pack (npm run eval -- --packs devops)
  CHANGELOG.md
```

## How it ships

The harness desktop app is the base of both ways:

- **As a plugin, in the harness app you have**: one file, `devops-1.1.0.tgz`. The desktop build writes it to `release/plugins`, signed by the publisher; `npm run bundle -w @harness/devops` writes it too. In the app, open Plugins > Install from a file; it shows what is in the file and who signed it, then installs it. DevOps shows as **Official** and **Verified**.
- **As its own app, Harness DevOps**: `npm run desktop:build -- --solution devops` writes the installer to `apps/desktop/release-devops`: the harness app with every feature, DevOps inside and installed, the window focused on it, its own home folder (`~/.harness-devops`). `npm run desktop:dev -- --solution devops` runs it from the checkout.
- **On a server**: in the harness checkout its plugin is a shipped plugin (offered under Plugins, installed on demand); elsewhere, from the file or a catalogue (`HARNESS_PLUGIN_CATALOGUE`).

## Tests

```bash
npm test -- --solution=devops
```

The `*-stack`, `*-real`, `*-live` and `*e2e*` tests need Docker, real services or the desktop app, and skip themselves without them. The tests import the harness only through `@harness/plugin-sdk/testing`; a check in the core keeps it so.
