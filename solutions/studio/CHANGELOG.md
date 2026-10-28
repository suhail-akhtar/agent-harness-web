# Studio changelog

Studio's own versions, released apart from the core's (the core's are in the CHANGELOG.md at the top). Every
plugin of Studio carries the same version; `harness.core` in package.json is the core versions it runs on.

## 1.1.0

- Studio is a solution of its own: `solutions/studio`, with its plugins (games3d, engine-blender, engine-godot,
  engine-unity, engine-unreal), its tests, its eval packs (3d, games, games3d) and its docs.
- For core 0.2.3 and later 0.2 versions (`engines.harness` in each plugin); an older core says so instead of
  loading it.
- Its tests use only the plugin test kit (`@harness/plugin-sdk/testing`, `/testing/desktop`), never the core's
  files, so they run unchanged wherever Studio is developed.
- Shipped two ways, the harness desktop app the base of both: one signed file (studio-1.1.0.tgz) that
  installs into the app as it was (Plugins > Install from a file), Verified as signed by Suhail Akhtar; or
  Harness Studio, the app with Studio inside, focused on it (npm run desktop:build -- --solution studio).

## 1.0.0

- Shipped with the harness in plugins/.
