# Studio

Games and 3D on the harness: browser games (2D canvas, Three.js) and 3D models, Blender, Godot, Unity and
Unreal Engine. An AI player play-tests what is built. Studio is a solution of its own, built on the core
through the plugin SDK only. It has its own version, tests, evals and docs, and it ships apart from the core.

| | |
|---|---|
| Version | 1.1.0 ([CHANGELOG.md](CHANGELOG.md)) |
| Core | `>=0.2.3 <0.3.0` (each plugin's `engines.harness`) |
| Publisher | Suhail Akhtar, MIT licence |

## What is here

```
solutions/studio/
  package.json            version, the core versions it runs on, its plugins
  plugins/
    games3d/              Studio's core: tools, gates, workflows, agents, skills, the AI player, the desktop module
    engine-blender/       Blender (requires games3d)
    engine-godot/         Godot 4
    engine-unity/         Unity
    engine-unreal/        Unreal Engine 5
  evals/                  eval packs: 3d, games, games3d (npm run eval -- --packs games3d)
  docs/STUDIO.md          the design and the plan
  CHANGELOG.md
```

## How it ships

- **Into the core app**, as bundles: the desktop build writes each plugin as `release/plugins/<name>-<version>.tgz`,
  signed with the publisher's key. In the app, Plugins > Install from a file. Studio then shows as **Official**
  and **Verified**: every file is as the publisher signed it.
- **As Harness Studio**, the core with Studio inside:
  `HARNESS_PRODUCT=products/studio.json npm run desktop:build` (products/studio.json: `"solutions": ["studio"]`).
- **On a server**: in the harness checkout every solution's plugins are shipped plugins (offered under
  Plugins, installed on demand); elsewhere, from the bundles or a catalogue (`HARNESS_PLUGIN_CATALOGUE`).

## Tests

```bash
npm test -- --solution=studio
```

The tests run without Blender, Godot, Unity or Unreal (stand-ins), and without a browser. The `*-real`,
`*-live` and `*e2e*` tests need the real program, a browser or the desktop app, and skip themselves when
those are missing.

They import the harness only through the plugin test kit:

- `@harness/plugin-sdk/testing`: `loadPlugin`, `createHarness`, `pluginDir`, `shippedPlugins`, gates,
  skills, workflows, evals, fixtures.
- `@harness/plugin-sdk/testing/desktop`: how the desktop app shows a plugin.

Studio's own fixtures (a fake Godot, a seeded Studio project, sample games) are in
`plugins/games3d/test/fixtures` and are imported by name (`@harness/plugins/games3d/test/fixtures/...`).
A check in the core (`test/portable-plugins.test.ts`) keeps it so: no file of a solution imports
`@harness/core/...`.

## Releasing

1. Change the version in `package.json`, in every plugin's `harness-plugin.json`, and in the CHANGELOGs.
   `test/solution.test.ts` checks that they agree.
2. Run `npm test -- --solution=studio`.
3. Build the bundles (`npm run desktop:build`, or `npm run bundles -w @harness/studio`), then tag `studio-v<version>`.
