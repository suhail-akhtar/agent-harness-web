// A level from a layout: a character grid ("#" wall, "." floor, P player, C collectible,
// E exit, H hazard, "=" platform, S spawn) plus listed objects, built as a scene for 3D
// (URP or built-in materials, a CharacterController player, a follow camera), 2.5D (the
// same on an orthographic isometric camera) or 2D (a Tilemap with colliders, sprites, a
// Rigidbody2D player, an orthographic camera). The collect-and-escape rules come along
// (HarnessGameRules), so the level plays and reports its state at once.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
using UnityEngine.Tilemaps;
using Object = UnityEngine.Object;

namespace Harness.Bridge.Editor
{
    public static class LevelBuilder
    {
        public const string Generated = "Assets/Harness/Generated";

        static readonly Dictionary<string, string> DefaultLegend = new Dictionary<string, string>
        {
            { "#", "wall" }, { ".", "floor" }, { " ", "empty" }, { "P", "player" }, { "C", "collectible" }, { "E", "exit" }, { "H", "hazard" }, { "=", "platform" }, { "S", "spawn" },
        };

        static readonly Dictionary<string, Color> Colors = new Dictionary<string, Color>
        {
            { "wall", new Color(0.45f, 0.48f, 0.55f) }, { "floor", new Color(0.32f, 0.36f, 0.30f) }, { "player", new Color(0.25f, 0.55f, 0.95f) },
            { "collectible", new Color(1f, 0.82f, 0.2f) }, { "exit", new Color(0.8f, 0.2f, 0.2f) }, { "hazard", new Color(0.9f, 0.3f, 0.1f) },
            { "platform", new Color(0.55f, 0.42f, 0.3f) }, { "spawn", new Color(0.6f, 0.3f, 0.7f) },
        };

        sealed class Ctx
        {
            public string Dim;
            public float Cell;
            public int Rows;
            public int Cols;
            public Transform Root;
            public Transform Player;
            public Vector3 PlayerSpawn;
            public Tilemap Walls;
            public Tilemap Ground;
            public readonly Dictionary<string, int> Counts = new Dictionary<string, int>();
            public bool Is2D { get { return Dim == "2d"; } }
            public void Count(string k) { int n; Counts.TryGetValue(k, out n); Counts[k] = n + 1; }
        }

        public static Dictionary<string, object> Build(Args a, bool live)
        {
            var ctx = new Ctx { Dim = a.Str("dimension", "3d").ToLowerInvariant(), Cell = Mathf.Max(0.1f, a.Float("cell", 1f)) };
            if (ctx.Dim != "2d" && ctx.Dim != "2.5d" && ctx.Dim != "3d") throw new ArgumentException("dimension is 2d, 2.5d or 3d");
            var scenePath = a.Str("scene", "Assets/Scenes/" + a.Str("name", "Level1").Replace(" ", "") + ".unity");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            ctx.Root = new GameObject(a.Str("name", "Level")).transform;

            var legend = new Dictionary<string, string>(DefaultLegend);
            var custom = a.Raw("legend") as Dictionary<string, object>;
            if (custom != null) foreach (var kv in custom) legend[kv.Key] = Convert.ToString(kv.Value);
            var grid = a.Strings("grid");
            ctx.Rows = grid.Count;
            foreach (var r in grid) ctx.Cols = Mathf.Max(ctx.Cols, r.Length);

            if (ctx.Is2D) Setup2D(ctx);
            else if (grid.Count > 0) Floor3D(ctx);

            for (int row = 0; row < grid.Count; row++)
            {
                var line = grid[row];
                for (int x = 0; x < line.Length; x++)
                {
                    string kind;
                    if (!legend.TryGetValue(line[x].ToString(), out kind) || kind == "empty") continue;
                    int y = ctx.Rows - 1 - row;
                    if (kind == "wall" && !ctx.Is2D)
                    {
                        // One stretched cube per horizontal run of walls.
                        int end = x;
                        while (end + 1 < line.Length && legend.ContainsKey(line[end + 1].ToString()) && legend[line[end + 1].ToString()] == "wall") end++;
                        Wall3D(ctx, x, end, y);
                        x = end;
                        continue;
                    }
                    Place(ctx, kind, CellCenter(ctx, x, y), null);
                }
            }

            foreach (var o in a.List("objects")) ListedObject(ctx, new Args(o as Dictionary<string, object>));
            if (ctx.Player == null) throw new ArgumentException("the layout has no player (P in the grid, or an object of type player)");

            MakeLight(ctx);
            var cam = MakeCamera(ctx, a.Obj("camera"));
            var rules = new GameObject("Game").AddComponent<HarnessGameRules>();
            rules.transform.SetParent(ctx.Root, false);
            rules.player = ctx.Player;
            var ra = a.Obj("rules");
            rules.exitNeedsAll = ra.Bool("exitNeedsAll", true);
            rules.timeLimit = ra.Float("timeLimitS", 0f);
            rules.fallY = ctx.Is2D ? -ctx.Cell * 10f : -20f;

            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(EditorBridge.ProjectRoot, scenePath)));
            if (!EditorSceneManager.SaveScene(scene, scenePath)) throw new InvalidOperationException("Unity did not save " + scenePath);
            ProjectSetup.AddToBuild(scenePath, a.Bool("main", true));
            AssetDatabase.SaveAssets();

            var result = new Dictionary<string, object>
            {
                { "scene", scenePath }, { "dimension", ctx.Dim }, { "rows", ctx.Rows }, { "cols", ctx.Cols }, { "cell", ctx.Cell },
                { "counts", ctx.Counts }, { "camera", cam.orthographic ? "orthographic" : "perspective" }, { "live", live },
            };
            var cap = a.Raw("capture") as Dictionary<string, object>;
            if (cap != null)
            {
                var c = new Args(cap);
                if (!c.Has("view")) c.Values["view"] = "game";
                c.Values["inline"] = false;
                result["capture"] = CaptureOps.Capture(c);
            }
            return result;
        }

        static Vector3 CellCenter(Ctx ctx, int x, int y)
        {
            return ctx.Is2D ? new Vector3((x + 0.5f) * ctx.Cell, (y + 0.5f) * ctx.Cell, 0f) : new Vector3(x * ctx.Cell, 0f, y * ctx.Cell);
        }

        // ---------- 3D and 2.5D ----------

        static void Floor3D(Ctx ctx)
        {
            var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
            floor.name = "Floor";
            floor.transform.SetParent(ctx.Root, false);
            floor.transform.localScale = new Vector3(ctx.Cols * ctx.Cell, 0.2f, ctx.Rows * ctx.Cell);
            floor.transform.localPosition = new Vector3((ctx.Cols - 1) * ctx.Cell * 0.5f, -0.1f, (ctx.Rows - 1) * ctx.Cell * 0.5f);
            floor.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Floor", Colors["floor"]);
            floor.isStatic = true;
        }

        static void Wall3D(Ctx ctx, int x0, int x1, int y)
        {
            var wall = GameObject.CreatePrimitive(PrimitiveType.Cube);
            wall.name = "Wall";
            wall.transform.SetParent(ctx.Root, false);
            float len = (x1 - x0 + 1) * ctx.Cell;
            wall.transform.localScale = new Vector3(len, 2f, ctx.Cell);
            wall.transform.localPosition = new Vector3((x0 + x1) * 0.5f * ctx.Cell, 1f, y * ctx.Cell);
            wall.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Wall", Colors["wall"]);
            wall.isStatic = true;
            ctx.Count("wall");
        }

        static GameObject Place(Ctx ctx, string kind, Vector3 at, Args o)
        {
            var go = ctx.Is2D ? Place2D(ctx, kind, at) : Place3D(ctx, kind, at);
            if (go == null) return null;
            if (o != null)
            {
                if (o.Has("name")) go.name = o.Str("name");
                if (o.Has("rotation")) go.transform.localEulerAngles = o.Vec3("rotation", go.transform.localEulerAngles);
                if (o.Has("scale")) go.transform.localScale = o.Vec3("scale", go.transform.localScale);
                if (o.Has("color")) BridgeOps.Tint(go, Args.ToColor(o.Raw("color"), Color.white));
                foreach (var c in o.Strings("components")) go.AddComponent(SceneTools.ComponentType(c));
            }
            ctx.Count(kind);
            return go;
        }

        static GameObject Place3D(Ctx ctx, string kind, Vector3 at)
        {
            GameObject go;
            switch (kind)
            {
                case "floor": case "spawn-floor": return null;
                case "player":
                    go = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                    go.name = "Player";
                    Object.DestroyImmediate(go.GetComponent<CapsuleCollider>());
                    go.transform.position = at + Vector3.up * 1.05f;
                    var cc = go.AddComponent<CharacterController>();
                    cc.height = 2f; cc.radius = 0.4f; cc.center = Vector3.zero;
                    go.AddComponent<HarnessPlayerController>().cameraRelative = true;
                    go.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Player", Colors["player"]);
                    go.tag = "Player";
                    ctx.Player = go.transform;
                    ctx.PlayerSpawn = go.transform.position;
                    break;
                case "collectible":
                    go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                    go.name = "Coin";
                    go.GetComponent<Collider>().isTrigger = true;
                    go.transform.position = at + Vector3.up * 0.8f;
                    go.transform.localScale = Vector3.one * 0.5f;
                    go.AddComponent<HarnessCollectible>();
                    go.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Collectible", Colors["collectible"]);
                    break;
                case "exit":
                    go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    go.name = "Exit";
                    go.GetComponent<Collider>().isTrigger = true;
                    go.transform.position = at + Vector3.up * 0.05f;
                    go.transform.localScale = new Vector3(ctx.Cell * 0.9f, 0.1f, ctx.Cell * 0.9f);
                    go.AddComponent<HarnessExit>();
                    go.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Exit", Colors["exit"]);
                    break;
                case "hazard":
                    go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    go.name = "Hazard";
                    go.GetComponent<Collider>().isTrigger = true;
                    go.transform.position = at + Vector3.up * 0.15f;
                    go.transform.localScale = new Vector3(ctx.Cell * 0.8f, 0.3f, ctx.Cell * 0.8f);
                    go.AddComponent<HarnessHazard>();
                    go.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Hazard", Colors["hazard"]);
                    break;
                case "platform":
                    go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    go.name = "Platform";
                    go.transform.position = at + Vector3.up * 0.25f;
                    go.transform.localScale = new Vector3(ctx.Cell, 0.5f, ctx.Cell);
                    go.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Platform", Colors["platform"]);
                    go.isStatic = true;
                    break;
                case "wall":
                    go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    go.name = "Wall";
                    go.transform.position = at + Vector3.up;
                    go.transform.localScale = new Vector3(ctx.Cell, 2f, ctx.Cell);
                    go.GetComponent<Renderer>().sharedMaterial = MakeMaterial("Wall", Colors["wall"]);
                    go.isStatic = true;
                    break;
                case "spawn":
                    go = new GameObject("Spawn");
                    go.transform.position = at;
                    break;
                default:
                    throw new ArgumentException("unknown cell kind \"" + kind + "\"");
            }
            go.transform.SetParent(ctx.Root, true);
            return go;
        }

        // ---------- 2D ----------

        static void Setup2D(Ctx ctx)
        {
            var grid = new GameObject("Grid", typeof(Grid));
            grid.transform.SetParent(ctx.Root, false);
            grid.GetComponent<Grid>().cellSize = new Vector3(ctx.Cell, ctx.Cell, 0f);
            ctx.Ground = Layer(grid.transform, "Ground", -10, false);
            ctx.Walls = Layer(grid.transform, "Walls", 0, true);
        }

        static Tilemap Layer(Transform grid, string name, int order, bool collide)
        {
            var go = new GameObject(name, typeof(Tilemap), typeof(TilemapRenderer));
            go.transform.SetParent(grid, false);
            go.GetComponent<TilemapRenderer>().sortingOrder = order;
            if (collide)
            {
                go.AddComponent<TilemapCollider2D>();
                go.isStatic = true;
            }
            return go.GetComponent<Tilemap>();
        }

        static GameObject Place2D(Ctx ctx, string kind, Vector3 at)
        {
            var cell = new Vector3Int(Mathf.FloorToInt(at.x / ctx.Cell), Mathf.FloorToInt(at.y / ctx.Cell), 0);
            switch (kind)
            {
                case "wall":
                case "platform":
                    ctx.Walls.SetTile(cell, MakeTile(kind, Colors[kind]));
                    return null;
                case "floor":
                    ctx.Ground.SetTile(cell, MakeTile("floor", Colors["floor"]));
                    return null;
            }
            ctx.Ground.SetTile(cell, MakeTile("floor", Colors["floor"]));
            var go = new GameObject(kind == "collectible" ? "Coin" : char.ToUpperInvariant(kind[0]) + kind.Substring(1));
            go.transform.SetParent(ctx.Root, false);
            go.transform.position = at;
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sortingOrder = 10;
            switch (kind)
            {
                case "player":
                    sr.sprite = MakeSprite("player", Colors["player"], false);
                    go.transform.localScale = Vector3.one * 0.9f;
                    var body = go.AddComponent<Rigidbody2D>();
                    body.gravityScale = 3f;
                    body.interpolation = RigidbodyInterpolation2D.Interpolate;
                    body.collisionDetectionMode = CollisionDetectionMode2D.Continuous;
                    go.AddComponent<BoxCollider2D>();
                    go.AddComponent<HarnessPlayerController2D>();
                    go.tag = "Player";
                    ctx.Player = go.transform;
                    ctx.PlayerSpawn = at;
                    break;
                case "collectible":
                    sr.sprite = MakeSprite("collectible", Colors["collectible"], true);
                    go.transform.localScale = Vector3.one * 0.6f;
                    var c = go.AddComponent<HarnessCollectible>();
                    c.spin = 0f;
                    c.radius = 0.6f * ctx.Cell;
                    break;
                case "exit":
                    sr.sprite = MakeSprite("exit", Colors["exit"], false);
                    go.AddComponent<HarnessExit>().radius = 0.6f * ctx.Cell;
                    break;
                case "hazard":
                    sr.sprite = MakeSprite("hazard", Colors["hazard"], false);
                    go.transform.localScale = new Vector3(0.9f, 0.5f, 1f);
                    go.AddComponent<HarnessHazard>().radius = 0.5f * ctx.Cell;
                    break;
                case "spawn":
                    sr.sprite = MakeSprite("spawn", Colors["spawn"], true);
                    sr.enabled = false;
                    break;
                default:
                    throw new ArgumentException("unknown cell kind \"" + kind + "\"");
            }
            return go;
        }

        static TileBase MakeTile(string name, Color c)
        {
            var path = Generated + "/Tiles/" + name + ".asset";
            var tile = AssetDatabase.LoadAssetAtPath<Tile>(path);
            if (tile != null) return tile;
            Folder(Generated + "/Tiles");
            tile = ScriptableObject.CreateInstance<Tile>();
            tile.sprite = MakeSprite(name, c, false);
            tile.colliderType = UnityEngine.Tilemaps.Tile.ColliderType.Grid;
            AssetDatabase.CreateAsset(tile, path);
            return tile;
        }

        /// <summary>A 32 px sprite (a bordered square, or a disc) saved under Assets/Harness/Generated/Sprites.</summary>
        public static Sprite MakeSprite(string name, Color c, bool round)
        {
            var path = Generated + "/Sprites/" + name + ".png";
            var existing = AssetDatabase.LoadAssetAtPath<Sprite>(path);
            if (existing != null) return existing;
            Folder(Generated + "/Sprites");
            const int n = 32;
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, false);
            var edge = Color.Lerp(c, Color.black, 0.35f);
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    Color px;
                    if (round)
                    {
                        float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(n / 2f, n / 2f));
                        px = d > n / 2f - 0.5f ? new Color(0, 0, 0, 0) : d > n / 2f - 3f ? edge : c;
                    }
                    else px = x < 2 || y < 2 || x >= n - 2 || y >= n - 2 ? edge : c;
                    tex.SetPixel(x, y, px);
                }
            File.WriteAllBytes(Path.Combine(EditorBridge.ProjectRoot, path), tex.EncodeToPNG());
            Object.DestroyImmediate(tex);
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            var imp = (TextureImporter)AssetImporter.GetAtPath(path);
            imp.textureType = TextureImporterType.Sprite;
            imp.spriteImportMode = SpriteImportMode.Single;
            imp.spritePixelsPerUnit = n;
            imp.filterMode = FilterMode.Point;
            imp.textureCompression = TextureImporterCompression.Uncompressed;
            imp.alphaIsTransparency = true;
            imp.SaveAndReimport();
            return AssetDatabase.LoadAssetAtPath<Sprite>(path);
        }

        /// <summary>A lit material of one colour (URP Lit or Standard) saved under Assets/Harness/Generated/Materials.</summary>
        public static Material MakeMaterial(string name, Color c)
        {
            var path = Generated + "/Materials/" + name + ".mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m != null) { m.color = c; EditorUtility.SetDirty(m); return m; }
            Folder(Generated + "/Materials");
            Shader shader = GraphicsSettings.currentRenderPipeline != null ? Shader.Find("Universal Render Pipeline/Lit") : null;
            if (shader == null) shader = Shader.Find("Standard");
            if (shader == null) shader = Shader.Find("Universal Render Pipeline/Lit");
            m = new Material(shader) { name = name, color = c };
            AssetDatabase.CreateAsset(m, path);
            return m;
        }

        public static void Folder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            var parent = Path.GetDirectoryName(path).Replace('\\', '/');
            Folder(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }

        // ---------- listed objects, light and camera ----------

        static void ListedObject(Ctx ctx, Args o)
        {
            var type = o.Str("type");
            var at = o.Vec3("position", Vector3.zero);
            GameObject go;
            switch (type)
            {
                case "prefab":
                    var asset = AssetDatabase.LoadAssetAtPath<GameObject>(o.Str("prefab"));
                    if (asset == null) throw new ArgumentException("no prefab at " + o.Str("prefab"));
                    go = (GameObject)PrefabUtility.InstantiatePrefab(asset);
                    go.transform.SetParent(ctx.Root, false);
                    go.transform.position = at;
                    break;
                case "sprite":
                    go = new GameObject(o.Str("name", "Sprite"));
                    go.transform.SetParent(ctx.Root, false);
                    go.transform.position = at;
                    var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(o.Str("sprite"));
                    if (sprite == null) throw new ArgumentException("no sprite at " + o.Str("sprite") + " (import it as a sprite first: asset.import with kind sprite)");
                    go.AddComponent<SpriteRenderer>().sprite = sprite;
                    break;
                case "primitive":
                    PrimitiveType p;
                    if (!Enum.TryParse(o.Str("primitive", "Cube"), true, out p)) throw new ArgumentException("primitive is one of " + string.Join(", ", Enum.GetNames(typeof(PrimitiveType))));
                    go = GameObject.CreatePrimitive(p);
                    go.transform.SetParent(ctx.Root, false);
                    go.transform.position = at;
                    break;
                case "light":
                    go = new GameObject(o.Str("name", "Light"));
                    go.transform.SetParent(ctx.Root, false);
                    go.transform.position = at;
                    var l = go.AddComponent<Light>();
                    l.type = o.Str("light", "point") == "spot" ? LightType.Spot : LightType.Point;
                    l.range = o.Float("range", 10f);
                    l.intensity = o.Float("intensity", 1.5f);
                    l.color = Args.ToColor(o.Raw("color"), Color.white);
                    ctx.Count("light");
                    return;
                case "camera":
                    return;
                default:
                    go = Place(ctx, type, at, null);
                    if (go == null) return;
                    if (type == "player") ctx.PlayerSpawn = go.transform.position;
                    break;
            }
            if (o.Has("name")) go.name = o.Str("name");
            if (o.Has("rotation")) go.transform.localEulerAngles = o.Vec3("rotation", go.transform.localEulerAngles);
            if (o.Has("scale")) go.transform.localScale = o.Vec3("scale", go.transform.localScale);
            if (o.Has("color")) BridgeOps.Tint(go, Args.ToColor(o.Raw("color"), Color.white));
            foreach (var c in o.Strings("components")) go.AddComponent(SceneTools.ComponentType(c));
            ctx.Count("objects");
        }

        static void MakeLight(Ctx ctx)
        {
            if (ctx.Is2D)
            {
                // URP's 2D renderer lights sprites with a Light2D; add a global one when the package is there.
                var light2d = Type.GetType("UnityEngine.Rendering.Universal.Light2D, Unity.RenderPipelines.Universal.Runtime");
                if (light2d != null && GraphicsSettings.currentRenderPipeline != null)
                {
                    var go2 = new GameObject("Global Light 2D");
                    go2.transform.SetParent(ctx.Root, false);
                    var comp = go2.AddComponent(light2d);
                    var so = new SerializedObject(comp);
                    var lt = so.FindProperty("m_LightType");
                    if (lt != null) { lt.intValue = 4; so.ApplyModifiedProperties(); }
                }
                return;
            }
            var go = new GameObject("Sun");
            go.transform.SetParent(ctx.Root, false);
            go.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
            var l = go.AddComponent<Light>();
            l.type = LightType.Directional;
            l.intensity = 1.2f;
            l.shadows = LightShadows.Soft;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.55f, 0.6f, 0.7f);
            RenderSettings.ambientEquatorColor = new Color(0.4f, 0.4f, 0.42f);
            RenderSettings.ambientGroundColor = new Color(0.2f, 0.2f, 0.2f);
        }

        static Camera MakeCamera(Ctx ctx, Args c)
        {
            var go = new GameObject("Main Camera");
            go.tag = "MainCamera";
            go.transform.SetParent(ctx.Root, false);
            var cam = go.AddComponent<Camera>();
            go.AddComponent<AudioListener>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = Args.ToColor(c.Raw("background"), ctx.Is2D ? new Color(0.16f, 0.18f, 0.24f) : new Color(0.45f, 0.6f, 0.78f));
            var mode = c.Str("mode", ctx.Dim == "2.5d" ? "isometric" : ctx.Is2D ? "orthographic" : "follow");
            float span = Mathf.Max(ctx.Rows, ctx.Cols, 4) * ctx.Cell;
            var center = ctx.Is2D ? new Vector3(ctx.Cols * ctx.Cell * 0.5f, ctx.Rows * ctx.Cell * 0.5f, 0f) : new Vector3((ctx.Cols - 1) * ctx.Cell * 0.5f, 0f, (ctx.Rows - 1) * ctx.Cell * 0.5f);
            bool follow = c.Bool("follow", mode == "follow" || mode == "isometric" || (ctx.Is2D && span > 18f));
            HarnessFollowCamera f = null;
            if (follow) { f = go.AddComponent<HarnessFollowCamera>(); f.target = ctx.Player; }

            if (ctx.Is2D)
            {
                cam.orthographic = true;
                cam.orthographicSize = c.Float("size", follow ? 6f * ctx.Cell : Mathf.Max(ctx.Rows * 0.5f + 1f, ctx.Cols * 0.5f / (16f / 9f) + 1f) * ctx.Cell);
                go.transform.position = center + new Vector3(0f, 0f, -10f);
                if (f != null) { f.offset = new Vector3(0f, 0f, -10f); f.lookAtTarget = false; }
            }
            else if (mode == "isometric")
            {
                cam.orthographic = true;
                cam.orthographicSize = c.Float("size", Mathf.Clamp(span * 0.35f, 4f, 30f));
                var rot = Quaternion.Euler(c.Float("pitch", 30f), c.Float("yaw", 45f), 0f);
                go.transform.rotation = rot;
                var offset = rot * Vector3.back * c.Float("distance", 30f);
                go.transform.position = (ctx.Player != null ? ctx.Player.position : center) + offset;
                cam.nearClipPlane = 0.1f; cam.farClipPlane = 200f;
                if (f != null) { f.offset = offset; f.lookAtTarget = false; }
            }
            else if (mode == "orthographic")
            {
                cam.orthographic = true;
                cam.orthographicSize = c.Float("size", span * 0.55f);
                go.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
                go.transform.position = center + Vector3.up * 30f;
                if (f != null) { f.offset = Vector3.up * 30f; f.lookAtTarget = false; }
            }
            else if (mode == "perspective")
            {
                cam.fieldOfView = 50f;
                go.transform.position = center + new Vector3(0f, span * 0.9f, -span * 0.75f);
                go.transform.LookAt(center);
                if (f != null) Object.DestroyImmediate(f);
            }
            else
            {
                cam.fieldOfView = 55f;
                var offset = new Vector3(0f, c.Float("height", 7f), -c.Float("distance", 7f));
                go.transform.position = (ctx.Player != null ? ctx.Player.position : center) + offset;
                go.transform.LookAt(ctx.Player != null ? ctx.Player.position : center);
                if (f != null) f.offset = offset;
            }
            if (f != null && f) f.Snap();
            return cam;
        }
    }
}
