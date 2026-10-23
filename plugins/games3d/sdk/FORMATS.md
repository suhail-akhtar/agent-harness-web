# Studio file formats

Studio's parts and the engine plugins share these files. They all live in the workspace, so agents, gates and the desktop read the same thing. Paths are relative to the project folder, which is the folder holding `.studio/project.json`. A field may be added later; a field is never removed.

## `.studio/project.json`

```json
{
  "name": "Coin Escape",
  "engine": "unreal",            // "web" | "godot" | "unreal" | "unity" | "blender" (asset-only)
  "dimension": "3d",             // "2d" | "2.5d" | "3d"
  "genre": "third-person collect-and-escape",
  "created": "2026-10-23T10:00:00Z",
  "engineProject": "Game/CoinEscape.uproject",   // the engine's own project file
  "design": "design/GDD.md",
  "budgets": { "fps": 60, "frameMs": 16.7, "memoryMb": 2048, "trianglesPerAsset": 20000, "textureMax": 2048 },
  "stages": [{ "id": "prototype", "status": "done", "approvedAt": "..." }],
  "builds": [{ "id": "b1", "platform": "win64", "path": "Builds/b1/CoinEscape.exe", "status": "ok", "at": "..." }],
  "playtests": ["pt-20261023-1"]
}
```

## `.studio/assets/<id>/asset.json` (one folder per asset)

```json
{
  "id": "barrel-wood-01",
  "name": "Wooden barrel",
  "kind": "model",               // model | sprite | spritesheet | tileset | texture | material | audio | music | font | ui | level | heightmap
  "dimension": "3d",             // 2d | 3d
  "files": [{ "path": "barrel.glb", "role": "main" }, { "path": "barrel_lod1.glb", "role": "lod1" }, { "path": "preview.png", "role": "preview" }],
  "source": { "type": "procedural", "generator": "blender:barrel", "seed": 42, "params": {} },
                                 // type: procedural | import | library (provider, url, id) | generated (provider, model, prompt)
  "license": { "id": "CC0-1.0", "author": "Poly Haven", "url": "https://polyhaven.com/a/..." },
  "hashes": { "barrel.glb": "sha256:..." },
  "tags": ["prop", "wood"],
  "style": "stylized-lowpoly",
  "meta": { "triangles": 812, "sizeM": [0.6, 0.6, 0.9], "frames": 8, "frameSize": [32, 32], "tile": 16, "durationS": 0.4 },
  "checks": [{ "gate": "asset-budget", "pass": true, "summary": "812 tris <= 20000", "at": "..." }],
  "engines": { "unreal": { "path": "/Game/Assets/Barrel", "importedAt": "..." }, "godot": { "path": "res://assets/barrel.glb" } },
  "created": "...", "updated": "..."
}
```

A shared library lives in `~/.harness/assets/<id>/` with the same layout. An asset is copied into a project when it is used.

## `.studio/playtests/<id>/report.json`

```json
{
  "id": "pt-20261023-1",
  "engine": "web", "build": "b1",
  "player": "ai" ,                // ai | bot:random | bot:explore | bot:scripted | person
  "goal": "collect all coins and reach the exit",
  "result": "pass",               // pass | fail | crash | timeout
  "durationS": 94.2,
  "steps": 312,
  "events": [{ "t": 3.2, "type": "pickup", "detail": "coin 1/10" }, { "t": 40.1, "type": "stuck", "detail": "no progress for 8s" }],
  "metrics": { "fpsAvg": 59.8, "fpsMin": 41, "frameMsP95": 18.2, "memoryMb": 640, "errors": 0 },
  "frames": ["frames/0000.png"], "recording": "playthrough.gif",
  "issues": [{ "severity": "major", "title": "Player can fall through floor at x=12", "evidence": "frames/0120.png" }],
  "verdicts": [{ "by": "vision", "claim": "the exit door opens after the last coin", "pass": true, "evidence": "frames/0301.png" }]
}
```

## Jobs

`sdk/jobs.mjs` keeps them in memory: `listJobs()` returns `{ id, engine, title, status, queuedAt, startedAt?, endedAt? }`.
