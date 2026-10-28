---
name: unreal-levels
description: Building Unreal Engine 5.8 levels from a layout with harness_ue.build_level - floor, walls, platforms, pickups, lights, player start, an exit trigger, a game mode and a shot camera - plus props from imported models, 2D and 2.5D setups, and checking the result with captures. Use when making or changing a level.
---
# Levels from a layout

`h.build_level(layout)` makes (or opens) a map and puts in what the layout lists, in the outliner folder `Level/Generated` (a second call clears that folder first, so it can be re-run). Everything is optional; centimetres, Z up, rotations `[pitch, yaw, roll]`.

```python
import harness_ue as h
kit = h.coin_game_kit()                                   # see unreal-blueprints
floor = h.color_material("/Game/CoinKit/M_Floor", (0.18, 0.2, 0.24), roughness=0.8)
made = h.build_level({
    "map": "/Game/Levels/Lvl_Coins",
    "floor": {"size": [4400, 2400], "material": floor.get_path_name()},     # top at z=0
    "walls": {"height": 300},                                               # around the floor
    "platforms": [{"at": [-200, 700, 100], "size": [400, 400, 200]}],       # centre and size
    "pickups": {"class": kit["BP_Coin"], "label": "Coin", "at": [[300 * i - 1200, 0, 100] for i in range(10)]},
    "lights": {"sun": True, "sky": True, "fog": True, "points": [{"at": [0, 0, 400], "intensity": 5000}]},
    "player_start": {"at": [-1800, 0, 120], "yaw": 0},
    "exit": {"class": kit["BP_Exit"], "at": [1900, 0, 150]},               # or {"at": ..., "size": ...}: a TriggerBox tagged Exit
    "camera": {"at": [-2600, -1700, 1300], "rotation": [-32, 32, 0], "label": "ShotCam"},
    "game_mode": kit["BP_CoinGameMode"],                                    # the level's World Settings override
})
h.set_default_maps(game_map="/Game/Levels/Lvl_Coins", editor_map="/Game/Levels/Lvl_Coins")
h.save()
```

- A new level starts empty (no light, no sky): keep `lights` on. `"sun"` adds a DirectionalLight that drives the SkyAtmosphere, `"sky"` a SkyAtmosphere and a real-time SkyLight.
- Pickups sit on the floor at about z=100 so the character's capsule (half height 96) touches them.
- The player walks forward along +X from a player start with yaw 0; place a first route along X to script a play (`play` with `{"key": "W"}`).
- Props: `h.import_files(["assets/crate.glb"], "/Game/Imported/Crate")` then `h.spawn("StaticMeshActor", location=..., mesh_path=<the StaticMesh path>)`. A Blender glTF in metres arrives in centimetres, Z up, with its material.
- Boxes from the engine cube: `h.box("Ramp", center, size, material)`; meshes by name: `cube`, `sphere`, `cylinder`, `cone`, `plane`.
- Look at it: `unreal capture` with `view: "editor"` and `camera: "ShotCam"` (a scene capture, no play) or `view: "game"` with `at`/`target` (as played, with the HUD).

## 2D and 2.5D

- `project.create` with `setup: "sidescroller"`: the third-person character is constrained to the X-Z plane and seen from the side by an orthographic camera (`h.side_scroller_setup(ortho_width=1800)`). Lay levels out along X with Z for height; keep Y at 0.
- `setup: "topdown-2d"`: the top-down template with an orthographic camera looking straight down (`h.top_down_2d_setup()`).
- The template variants (`variant: "SideScroller"`, `"Platforming"`, `"Strategy"`...) bring Epic's own levels; the ones with AI enemies use StateTree at runtime and need a C++ toolchain to package (detect says whether one is there).

## Check it

- `unreal test` with `checks: "h.open_level('/Game/Levels/Lvl_Coins')\nh.check('ten coins', len(h.find_actors(cls='/Game/CoinKit/BP_Coin')) == 10)"`.
- The `unreal-project` gate loads every level and compiles every Blueprint.
