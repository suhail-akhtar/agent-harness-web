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
- Shipped two ways: as signed bundles (release/plugins) that install into the core app, Verified as signed by
  Suhail Akhtar; or inside Harness Studio, the core with Studio (products/studio.json).

## 1.0.0

- Shipped with the harness in plugins/.
