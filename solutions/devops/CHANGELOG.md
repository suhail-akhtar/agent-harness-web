# DevOps changelog

DevOps's own versions, released apart from the core's (the core's are in the CHANGELOG.md at the top). Every plugin of DevOps carries the same version; `harness.core` in package.json is the core versions it runs on.

## Unreleased

- Its eval test reads the eval pack from `solutions/devops/evals` (it still looked in the core's old `evals/`).

## 1.1.0

- DevOps is a solution of its own: `solutions/devops`, with its plugin (devops), its tests, its eval pack (devops).
- For core 0.2.4 and later 0.2 versions; an older core says so instead of loading it.
- Its tests use only the plugin test kit (`@harness/plugin-sdk/testing`), never the core's files.
- Shipped as one signed file (devops-1.1.0.tgz) that installs into the harness app (Plugins > Install from a file), Official and Verified as signed by Suhail Akhtar; or as its own app on the harness desktop app (npm run desktop:build -- --solution devops).

## 1.0.0

- Shipped with the harness in plugins/devops.
