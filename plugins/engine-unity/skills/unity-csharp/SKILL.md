---
name: unity-csharp
description: C# for Unity 6 (6000.x) that compiles the first time - MonoBehaviour rules, the Unity 6 renames (FindObjectsByType, Rigidbody.linearVelocity), input through HarnessInput or the Input System, publishing game state for playtests and the AI player, editor scripts the unity tool runs (scenes, assets, prefabs, Undo), and reading compile errors. Use when writing gameplay code or editor scripts for a Unity project.
---
# C# in Unity 6

## Game code (Assets/Scripts)

- One MonoBehaviour per file, **the file named exactly like the class** (`PlayerHealth.cs` holds `public class PlayerHealth : MonoBehaviour`). Otherwise Unity cannot attach it or keep it in a scene.
- Put game code in a namespace (`namespace CoinEscape { ... }`). Unity 6 compiles C# 9: no file-scoped namespaces, no `record struct`, no `init` setters.
- Lifecycle: `Awake` (own references) -> `OnEnable` -> `Start` (others' references) -> `FixedUpdate` (physics, fixed step) -> `Update` (input, per frame) -> `LateUpdate` (cameras). Multiply movement by `Time.deltaTime` (or `Time.fixedDeltaTime` in FixedUpdate).
- Serialized fields: `[SerializeField] private float speed = 5f;` (shows in the Inspector, saved in the scene). Public fields are serialized too.
- `GetComponent<T>()` in `Awake`, cached; never every frame. `[RequireComponent(typeof(Rigidbody))]` adds it for you.

### Unity 6 renames (the old names are obsolete and warn, some fail)

| Old | Unity 6 |
|---|---|
| `FindObjectOfType<T>()` / `FindObjectsOfType<T>()` | `FindFirstObjectByType<T>()` (or `FindAnyObjectByType<T>()`) / `FindObjectsByType<T>(FindObjectsSortMode.None)` |
| `rigidbody.velocity` | `rigidbody.linearVelocity` (also `Rigidbody2D.linearVelocity`) |
| `rigidbody.drag` / `angularDrag` | `linearDamping` / `angularDamping` |
| `Rigidbody2D.isKinematic = true` | `bodyType = RigidbodyType2D.Kinematic` |
| `collider2D.usedByComposite = true` | `compositeOperation = Collider2D.CompositeOperation.Merge` |

### Input

New projects use the Input System; the harness sets input handling to Both, so either works. Read input through **HarnessInput** when you can: playback timelines and the AI player drive it, and the real keyboard still works.

```csharp
using Harness.Bridge;
using UnityEngine;

public class Mover : MonoBehaviour
{
    [SerializeField] float speed = 5f;

    void Update()
    {
        Vector2 move = HarnessInput.Move();              // WASD / arrows / injected axes, clamped to 1
        transform.Translate(new Vector3(move.x, 0f, move.y) * speed * Time.deltaTime, Space.World);
        if (HarnessInput.Jump()) Debug.Log("jump");       // Space this frame
        if (HarnessInput.GetKeyDown(KeyCode.E)) Interact();
    }

    void Interact() { }
}
```

With the Input System directly (its keys are also injected, on a virtual keyboard):

```csharp
using UnityEngine.InputSystem;
var kb = Keyboard.current;
if (kb != null && kb.spaceKey.wasPressedThisFrame) Jump();
var move = InputSystem.actions.FindAction("Move").ReadValue<Vector2>();   // the project-wide actions (InputSystem_Actions)
```

### Tell the harness what is happening

Playtests and the AI player read what the game publishes. Publish the goal's state and the moments that matter:

```csharp
HarnessState.Set("score", score);
HarnessState.Set("lives", lives);
HarnessState.Set("won", true);                 // "won", "lost" or "done" ends an AI player's run
HarnessState.Emit("pickup", "coin 3/10");      // an event at the current game time
```

The level builder's `HarnessGameRules` already does this for collect-and-escape levels.

## Editor scripts (the unity tool's script action)

The body runs inside `public static object Run()` in `Harness.Scripts.<Name>` with `System`, `System.Linq`, `UnityEngine`, `UnityEditor`, `UnityEditor.SceneManagement` and `UnityEngine.SceneManagement` imported. Return something to see it.

```csharp
var scene = EditorSceneManager.OpenScene("Assets/Scenes/Level1.unity", OpenSceneMode.Single);
var torch = new GameObject("Torch");
torch.transform.position = new Vector3(2f, 1.5f, 3f);
var light = torch.AddComponent<Light>();
light.type = LightType.Point;
light.range = 6f;
light.color = new Color(1f, 0.75f, 0.4f);
EditorSceneManager.MarkSceneDirty(scene);
EditorSceneManager.SaveScene(scene);
return Object.FindObjectsByType<Light>(FindObjectsSortMode.None).Length;
```

(`Object` is `UnityEngine.Object` in the wrapper; in a file of your own with `using System;`, write `UnityEngine.Object` or add `using Object = UnityEngine.Object;`.)

The useful editor APIs:

- Scenes: `EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single)`, `OpenScene(path)`, `SaveScene(scene, path)`, `MarkSceneDirty(scene)`; the build's scenes: `EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(path, true) }`.
- Assets: `AssetDatabase.CreateAsset(obj, "Assets/...asset")`, `LoadAssetAtPath<T>(path)`, `ImportAsset(path)`, `Refresh()`, `SaveAssets()`, `AssetDatabase.CreateFolder(parent, name)`.
- Prefabs: `PrefabUtility.SaveAsPrefabAsset(go, "Assets/Prefabs/X.prefab")`, `PrefabUtility.InstantiatePrefab(asset)` (keeps the link; `Object.Instantiate` does not).
- Materials (URP): `new Material(Shader.Find("Universal Render Pipeline/Lit")) { color = c }` (`color` is `_BaseColor`); built-in: `Shader.Find("Standard")`. Save it with `AssetDatabase.CreateAsset` or the scene loses it.
- Importers: `(TextureImporter)AssetImporter.GetAtPath(path)`: `textureType = TextureImporterType.Sprite`, `spritePixelsPerUnit`, `filterMode = FilterMode.Point`, then `SaveAndReimport()`.
- In the live editor, record changes for Undo: `Undo.RegisterCreatedObjectUndo(go, "Create torch")`, `Undo.RecordObject(component, "Change")` before changing it.

A script that throws comes back with the exception and the line (`Assets/Editor/Harness/AddTorches.cs:12`).

## Compile errors

Errors look like `Assets/Scripts/Player.cs(12,5): error CS0246: The type or namespace name 'Rigidbody3D' could not be found`. The common ones:

- CS0246 / CS0103: a missing `using` (UnityEngine.InputSystem, UnityEngine.Tilemaps, UnityEngine.UI) or a wrong name. A package's types need the package in `Packages/manifest.json`, and an assembly definition (asmdef) must list the assembly in `references`.
- CS0619 / CS0618: an obsolete API (see the renames above).
- CS0101: two classes with one name (an old copy of a file).
- Editor code (`using UnityEditor;`) outside an `Editor` folder breaks the player build: keep it in `Assets/Editor/` or wrap it in `#if UNITY_EDITOR`.

After fixing, `project.open` (or `script` again) recompiles. Warnings are fine; errors are not.
