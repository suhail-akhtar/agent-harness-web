---
name: unity-2d
description: 2D and 2.5D games in Unity 6 - the Universal 2D template, sprites and sprite sheets (import settings, slicing), Tilemaps with colliders, Rigidbody2D platformer and top-down movement, sorting, 2D lights, pixel art settings, and 2.5D with an isometric orthographic camera over 3D geometry. Use for a 2D or 2.5D Unity game.
---
# 2D and 2.5D in Unity 6

## Start

- 2D: `{"action": "project.create", "template": "2d-urp", "dimension": "2d"}` - the Universal 2D template: URP with the 2D renderer, the 2D packages (Sprite, Tilemap, Tilemap Extras, Animation, PSD/Aseprite importers, Pixel Perfect), the editor in 2D mode.
- 2.5D: `{"action": "project.create", "template": "2.5d-urp", "dimension": "2.5d"}` - 3D URP with an orthographic camera at an isometric angle; levels are 3D geometry seen from above at 30/45 degrees.

`level.build` with `"dimension": "2d"` makes a Grid with two Tilemaps (Ground behind, Walls with a `TilemapCollider2D`), sprites for the player, coins, the exit and hazards, a Rigidbody2D platformer player and an orthographic camera. Rows are top first; cell (x, row) is at world ((x + 0.5) * cell, (rows - 1 - row + 0.5) * cell).

## Sprites

Import art with the right settings (the tool does it):

```json
{"action": "asset.import", "files": [
  {"path": "art/hero.png", "kind": "sprite", "ppu": 16, "filter": "point"},
  {"path": "art/hero_run.png", "kind": "sprite", "ppu": 16, "slice": [16, 16]},
  {"path": "art/tiles.png", "kind": "sprite", "ppu": 16, "slice": [16, 16], "to": "Assets/Art/Tiles/tiles.png"}
]}
```

- `ppu` (pixels per unit): one world unit is that many pixels. Keep one value for the whole game (16 or 32 for pixel art, 100 for painted art).
- Pixel art: `filter: "point"` and no compression (the default with point), mipmaps off.
- `slice: [w, h]` cuts a sheet into w x h cells named `<file>_0`, `<file>_1`, ... left to right, top to bottom (needs the 2D Sprite package, in the 2D template).

In code: `spriteRenderer.sprite = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().First(s => s.name == "hero_run_3");` (editor), or reference sprites from a serialized field at runtime. Order with `spriteRenderer.sortingLayerName` / `sortingOrder` (higher draws in front); the level builder uses Ground -10, Walls 0, characters 10.

## Tilemaps

```csharp
using UnityEngine.Tilemaps;
var tile = ScriptableObject.CreateInstance<Tile>();
tile.sprite = wallSprite;
tile.colliderType = Tile.ColliderType.Grid;
AssetDatabase.CreateAsset(tile, "Assets/Art/Tiles/Wall.asset");
tilemap.SetTile(new Vector3Int(x, y, 0), tile);
tilemap.GetTile(cell); tilemap.HasTile(cell); tilemap.CompressBounds();
```

Colliders: a `TilemapCollider2D` on the walls' Tilemap. For smooth floors, add a `CompositeCollider2D` (it adds a static `Rigidbody2D`; set its `bodyType` to Static) and set `tilemapCollider.compositeOperation = Collider2D.CompositeOperation.Merge` (Unity 6; `usedByComposite` is the old name).

## Movement

Platformer (gravity on, jump only when grounded) in `FixedUpdate`, input read in `Update`:

```csharp
[RequireComponent(typeof(Rigidbody2D))]
public class Runner : MonoBehaviour
{
    [SerializeField] float speed = 6f, jump = 11f;
    Rigidbody2D body;
    bool jumpQueued;
    readonly ContactPoint2D[] contacts = new ContactPoint2D[8];

    void Awake() { body = GetComponent<Rigidbody2D>(); body.freezeRotation = true; }
    void Update() { if (Harness.Bridge.HarnessInput.Jump()) jumpQueued = true; }

    void FixedUpdate()
    {
        var v = body.linearVelocity;
        v.x = Harness.Bridge.HarnessInput.GetAxis("Horizontal") * speed;
        if (jumpQueued && Grounded()) v.y = jump;
        jumpQueued = false;
        body.linearVelocity = v;
    }

    bool Grounded()
    {
        int n = body.GetContacts(contacts);
        for (int i = 0; i < n; i++) if (contacts[i].normal.y > 0.5f) return true;
        return false;
    }
}
```

Top-down: `body.gravityScale = 0` and `body.linearVelocity = HarnessInput.Move() * speed`. Set `interpolation = RigidbodyInterpolation2D.Interpolate` for smooth cameras, and `collisionDetectionMode = CollisionDetectionMode2D.Continuous` for fast bodies. Triggers: a collider with `isTrigger = true` and `OnTriggerEnter2D(Collider2D other)` (one of the two needs a Rigidbody2D). Queries: `Physics2D.OverlapCircle(pos, r, layerMask)`, `Physics2D.Raycast(origin, Vector2.down, distance, layerMask)`.

## Cameras

- 2D: `camera.orthographic = true`, `orthographicSize` = half the visible height in units (5 shows 10 units high), z = -10. Pixel-perfect: add the URP `PixelPerfectCamera` (reference resolution, the same ppu).
- 2.5D isometric: orthographic, rotation (30, 45, 0) (true isometric is 35.264), placed back along its forward: `cam.transform.position = target - cam.transform.forward * 30f`. Move the player relative to the camera's flattened forward so "up" goes up the screen (`HarnessPlayerController` does, with `cameraRelative`).
- Follow with `HarnessFollowCamera` (an offset; `lookAtTarget` off for orthographic views).

## 2D lights (URP 2D renderer)

Sprites with the default Sprite-Lit material are dark without a light: the template's scene has a `Light2D` set to Global; the level builder adds one. Point lights: `Light2D` with Light Type Point (`UnityEngine.Rendering.Universal`).

## Check it

`capture` the level and look (sprites the right size? tiles aligned? the player on the floor?), `play` with inputs (`{"t": 0, "key": "D", "press": 1.5}`, `{"t": 0.8, "key": "Space", "press": 0.1}`) and read `collected`, `won` and the events, then `test` and `build`.
