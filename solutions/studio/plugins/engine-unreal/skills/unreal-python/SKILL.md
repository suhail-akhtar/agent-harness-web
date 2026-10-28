---
name: unreal-python
description: Unreal Engine 5.8 editor Python as it really is - the subsystems to use (not the deprecated EditorLevelLibrary), the harness_ue helpers, assets, actors, materials, imports, settings, and the traps (no save_config, commas in ExecCmds, scripts that must stay alive). Use before writing any script for the unreal tool.
---
# Unreal editor Python (5.8)

Scripts run inside the editor (`unreal` tool, action `script`). `import harness_ue as h` is always available (the tool copies it into the project's `Content/Python`, which is on the editor's `sys.path`, so it also works in the person's own editor Python console). The API is the `unreal` module; the generated stub of every class is `Intermediate/PythonStub/unreal.py` when the editor runs with Python developer mode on.

## What to call

| Need | 5.8 API (verified) | harness_ue |
|---|---|---|
| Actors in the level | `unreal.get_editor_subsystem(unreal.EditorActorSubsystem)`: `spawn_actor_from_class(cls, loc, rot)`, `get_all_level_actors()`, `destroy_actor(a)` | `h.spawn("PointLight", location=..., label=..., props={...})`, `h.find_actors(label=, cls=, tag=)` |
| Levels | `unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)`: `load_level(path)`, `new_level(path)`, `save_all_dirty_levels()` | `h.open_level`, `h.new_level`, `h.save()` |
| The editor world | `unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()` | `h.world()` |
| Assets | `unreal.EditorAssetLibrary`: `does_asset_exist`, `load_asset`, `save_loaded_asset`, `delete_directory`; `unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, cls, factory)` | `h.load(path)`, `h.save_asset(a)` |
| Find assets | `unreal.AssetRegistryHelpers.get_asset_registry().get_assets_by_path("/Game", recursive=True)`; each has `package_name`, `asset_name`, `asset_class_path.asset_name` | `h.describe()` |
| Properties | `obj.get_editor_property("name")` / `set_editor_property("name", v)` (snake_case names) | `h.set_props(obj, {...})` (lists become vectors, rotators, colours) |
| Materials | `unreal.MaterialEditingLibrary`: `create_material_expression`, `connect_material_property(expr, "", unreal.MaterialProperty.MP_BASE_COLOR)`, `connect_material_expressions`, `recompile_material`, `set_material_instance_*_parameter_value`, `update_material_instance` | `h.color_material(path, rgb, emissive=, metallic=, roughness=)`, `h.texture_material(path, base_color, normal=, roughness=, tiling=)`, `h.material_instance(path, parent, vectors=, scalars=, textures=)` |
| Import | `unreal.AssetImportTask` (filename, destination_path, automated=True, replace_existing, save) and `asset_tools.import_asset_tasks([...])`; Interchange handles glTF/GLB, FBX, OBJ and textures. A Blender glb lands at the right size (100 cm cube from a 1 m cube) with its material. | `h.import_files([...], "/Game/Imported/X")` returns the asset paths; the tool's `asset.import` does it |
| Export | `unreal.AssetExportTask` + `unreal.Exporter.run_asset_export_task(task)` | `h.export_asset(asset, file)` |
| Game mode | the level's `world.get_world_settings().set_editor_property("default_game_mode", cls)` | `h.set_game_mode(path, level=True, project=False)` |
| Default maps | `unreal.GameMapsSettings` CDO: in-memory only - **Python cannot save a settings object's config** (`save_config` does not exist) | `h.set_default_maps(game_map=, editor_map=)` writes `Config/DefaultEngine.ini` |
| Classes | `unreal.load_class(None, "/Game/X/BP_Y.BP_Y_C")`; native: `unreal.StaticMeshActor.static_class()` | `h.load_class("BP path" / "StaticMeshActor")` |
| Is-a for classes | `unreal.MathLibrary.class_is_child_of(a, b)` (a UClass has no `is_child_of` in Python) | |

## Traps

- `EditorLevelLibrary` and most of `EditorScriptingUtilities` are deprecated in 5.8 (they warn); use the subsystems above.
- A script run with `-ExecutePythonScript` ends the editor when it returns. Work over several frames (captures, renders, PIE) needs `unreal.EditorPythonScripting.set_keep_python_script_alive(True)`, a `unreal.register_slate_post_tick_callback(fn)`, and `unreal.SystemLibrary.quit_editor()` when done (`h.capture_editor` and `h.render_sequence` do this). With the tool: `keepAlive: true`.
- A tick callback that raises runs again every frame: catch, report, unregister (`unreal.unregister_slate_post_tick_callback(handle)`) and quit.
- In a running game (`-game`) there is no editor: no `get_editor_subsystem`, no `EditorActorSubsystem`, and Python cannot spawn actors. Find live objects with `unreal.ObjectIterator(unreal.PlayerController)` (skip names starting `Default__`), use `unreal.GameplayStatics` with them as the world context, move existing actors. Packaged games have no Python at all.
- `-ExecCmds` splits commands at commas: do not put commas in a `py` command's arguments.
- `print()` goes to the log as `LogPython:`; `unreal.log_error()` is an error the tool reports. Prefer `h.result("tag", data)` for data and `h.problem("...")` for a problem that should fail the run.
- Text paths: `/Game/Folder/Asset` (package) and `/Game/Folder/Asset.Asset` (object); Blueprint classes add `_C`.

## A script

```python
import harness_ue as h
h.open_level("/Game/Levels/Lvl_Coins")
crate = h.import_files(["E:/work/assets/crate.glb"], "/Game/Imported/Crate")
mesh = [p for p in crate if "StaticMeshes" in p][0]
for i, at in enumerate([(-600, -500, 0), (300, 500, 0)]):
    h.spawn("StaticMeshActor", location=at, label="Crate_%d" % i, folder="Level/Props", mesh_path=mesh)
h.save()
h.result("crates", 2)
```
