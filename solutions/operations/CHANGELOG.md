# Operations changelog

Operations's own versions, released apart from the core's (the core's are in the CHANGELOG.md at the top). Every plugin of Operations carries the same version; `harness.core` in package.json is the core versions it runs on.

## 1.2.0

- Operations is a solution of its own: `solutions/operations`, with its plugin (aiops), its tests, its eval pack (aiops) and its docs.
- For core 0.2.4 and later 0.2 versions; an older core says so instead of loading it.
- Its tests use only the plugin test kit (`@harness/plugin-sdk/testing`), never the core's files.
- Shipped as one signed file (operations-1.2.0.tgz) that installs into the harness app (Plugins > Install from a file), Official and Verified as signed by Suhail Akhtar; or as its own app on the harness desktop app (npm run desktop:build -- --solution operations).

## 1.1.0

- Shipped with the harness in plugins/aiops.
