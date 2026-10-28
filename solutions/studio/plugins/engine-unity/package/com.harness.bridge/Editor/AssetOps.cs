// Importing files the harness copied into Assets/ with the right settings (sprites and
// sprite sheets, textures and normal maps, models, glTF through glTFast, audio), and
// exporting (a .unitypackage, a prefab, FBX through the FBX Exporter package, glTF/GLB
// through glTFast). Optional packages are used by reflection, so this compiles without them.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Harness.Bridge.Editor
{
    public static class AssetOps
    {
        public const string GltfPackage = "com.unity.cloud.gltfast";
        static readonly string[] TextureExt = { ".png", ".jpg", ".jpeg", ".tga", ".psd", ".exr", ".hdr", ".tif", ".tiff", ".bmp" };
        static readonly string[] ModelExt = { ".fbx", ".obj", ".dae", ".3ds", ".blend" };
        static readonly string[] AudioExt = { ".wav", ".mp3", ".ogg", ".aif", ".aiff", ".flac" };

        static bool HasGltfast()
        {
            return AppDomain.CurrentDomain.GetAssemblies().Any(x => x.GetName().Name.StartsWith("glTFast"));
        }

        /// <summary>
        /// files: [{path: "Assets/...", kind?: sprite | texture | normal | ui | model | gltf | audio | music, ppu?, filter?: point | bilinear,
        /// maxSize?, compression?: none | normal | high, slice?: [w, h], scale?, animations?, loop?, loadType?: decompress | compressed | streaming}].
        /// Calls done when finished (at once, or after glTFast was added).
        /// </summary>
        public static void Import(Args a, bool twoD, Action<Dictionary<string, object>> done)
        {
            var items = a.List("files").Select(x => new Args(x as Dictionary<string, object>)).ToList();
            if (items.Any(i => IsGltf(i.Str("path"))) && !HasGltfast())
            {
                if (!a.Bool("addPackages", true)) { done(new Dictionary<string, object> { { "ok", false }, { "error", "glTF files need the glTFast package (" + GltfPackage + "); pass addPackages: true to add it" } }); return; }
                var req = Client.Add(GltfPackage);
                EditorApplication.CallbackFunction poll = null;
                poll = () =>
                {
                    if (!req.IsCompleted) return;
                    EditorApplication.update -= poll;
                    if (req.Status == StatusCode.Success) done(new Dictionary<string, object> { { "ok", true }, { "restart", true }, { "added", req.Result.name + "@" + req.Result.version }, { "note", "glTFast was added; the import runs again once it has compiled" } });
                    else done(new Dictionary<string, object> { { "ok", false }, { "error", "could not add " + GltfPackage + ": " + (req.Error == null ? "unknown error" : req.Error.message) } });
                };
                EditorApplication.update += poll;
                return;
            }
            var results = new List<object>();
            int failed = 0;
            AssetDatabase.StartAssetEditing();
            try { foreach (var i in items) AssetDatabase.ImportAsset(i.Str("path"), ImportAssetOptions.ForceUpdate); }
            finally { AssetDatabase.StopAssetEditing(); }
            foreach (var i in items)
            {
                var r = ImportOne(i, twoD);
                if (!(bool)r["ok"]) failed++;
                results.Add(r);
            }
            AssetDatabase.SaveAssets();
            done(new Dictionary<string, object> { { "ok", failed == 0 }, { "results", results }, { "failed", failed } });
        }

        public static object ImportLive(Args a)
        {
            Dictionary<string, object> result = null;
            Import(a, EditorSettings.defaultBehaviorMode == EditorBehaviorMode.Mode2D, r => result = r);
            return new HarnessPending(() => result, 600);
        }

        static bool IsGltf(string p) { var e = Path.GetExtension(p ?? "").ToLowerInvariant(); return e == ".glb" || e == ".gltf"; }

        static Dictionary<string, object> ImportOne(Args i, bool twoD)
        {
            var path = i.Str("path");
            var r = new Dictionary<string, object> { { "path", path } };
            try
            {
                if (string.IsNullOrEmpty(path) || !path.StartsWith("Assets/")) throw new ArgumentException("path is a file under Assets/");
                if (!File.Exists(Path.Combine(EditorBridge.ProjectRoot, path))) throw new FileNotFoundException("not found: " + path);
                var ext = Path.GetExtension(path).ToLowerInvariant();
                var kind = i.Str("kind", TextureExt.Contains(ext) ? (twoD ? "sprite" : "texture") : ModelExt.Contains(ext) ? "model" : AudioExt.Contains(ext) ? "audio" : IsGltf(path) ? "gltf" : "other");
                var importer = AssetImporter.GetAtPath(path);
                if (importer == null) throw new InvalidOperationException("Unity has no importer for " + path);
                if (importer is TextureImporter) ApplyTexture((TextureImporter)importer, kind, i);
                else if (importer is ModelImporter) ApplyModel((ModelImporter)importer, i);
                else if (importer is AudioImporter) ApplyAudio((AudioImporter)importer, kind, i);
                importer.SaveAndReimport();
                var main = AssetDatabase.LoadMainAssetAtPath(path);
                if (main == null) throw new InvalidOperationException("Unity imported " + path + " but made no asset from it (see the log)");
                r["kind"] = kind;
                r["type"] = main.GetType().Name;
                r["importer"] = importer.GetType().Name;
                var tex = main as Texture2D;
                if (tex != null) { r["width"] = tex.width; r["height"] = tex.height; }
                var sprites = AssetDatabase.LoadAllAssetRepresentationsAtPath(path).OfType<Sprite>().Count();
                if (sprites > 0) r["sprites"] = sprites;
                var go = main as GameObject;
                if (go != null)
                {
                    var meshes = go.GetComponentsInChildren<MeshFilter>(true).Where(m => m.sharedMesh != null).Select(m => m.sharedMesh).ToList();
                    var skinned = go.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(m => m.sharedMesh != null).Select(m => m.sharedMesh);
                    meshes.AddRange(skinned);
                    r["meshes"] = meshes.Count;
                    r["triangles"] = meshes.Sum(m => (long)m.triangles.Length / 3);
                    var bounds = go.GetComponentsInChildren<Renderer>(true).Select(x => x.bounds).ToList();
                    if (bounds.Count > 0) { var b = bounds[0]; foreach (var x in bounds) b.Encapsulate(x); r["sizeM"] = new List<object> { Math.Round(b.size.x, 3), Math.Round(b.size.y, 3), Math.Round(b.size.z, 3) }; }
                }
                var clip = main as AudioClip;
                if (clip != null) { r["lengthS"] = Math.Round(clip.length, 2); r["channels"] = clip.channels; r["frequency"] = clip.frequency; }
                r["ok"] = true;
            }
            catch (Exception e)
            {
                r["ok"] = false;
                r["error"] = e.Message;
            }
            return r;
        }

#pragma warning disable 618
        static void ApplyTexture(TextureImporter t, string kind, Args i)
        {
            if (kind == "sprite" || kind == "ui")
            {
                t.textureType = TextureImporterType.Sprite;
                t.spritePixelsPerUnit = i.Float("ppu", 32f);
                t.alphaIsTransparency = true;
                t.mipmapEnabled = false;
                var slice = i.List("slice");
                if (slice.Count >= 2)
                {
                    int w = Convert.ToInt32(slice[0]), h = Convert.ToInt32(slice[1]);
                    t.spriteImportMode = SpriteImportMode.Multiple;
                    Slice(t, w, h);
                }
                else t.spriteImportMode = SpriteImportMode.Single;
            }
            else if (kind == "normal") t.textureType = TextureImporterType.NormalMap;
            else t.textureType = TextureImporterType.Default;
            var filter = i.Str("filter", kind == "sprite" && i.Float("ppu", 32f) <= 64f ? "point" : "bilinear");
            t.filterMode = filter == "point" ? FilterMode.Point : filter == "trilinear" ? FilterMode.Trilinear : FilterMode.Bilinear;
            if (i.Has("maxSize")) t.maxTextureSize = i.Int("maxSize");
            var comp = i.Str("compression", filter == "point" ? "none" : "normal");
            t.textureCompression = comp == "none" ? TextureImporterCompression.Uncompressed : comp == "high" ? TextureImporterCompression.CompressedHQ : comp == "low" ? TextureImporterCompression.CompressedLQ : TextureImporterCompression.Compressed;
        }
#pragma warning restore 618

        /// <summary>Cuts a sprite sheet into w x h cells, left to right and top to bottom (name_0, name_1, ...).</summary>
        static void Slice(TextureImporter t, int w, int h)
        {
            int tw, th;
            t.GetSourceTextureWidthAndHeight(out tw, out th);
            var baseName = Path.GetFileNameWithoutExtension(t.assetPath);
            var cells = new List<Rect>();
            for (int y = th - h; y >= 0; y -= h)
                for (int x = 0; x + w <= tw; x += w) cells.Add(new Rect(x, y, w, h));
#if HARNESS_2D_SPRITE
            var factory = new UnityEditor.U2D.Sprites.SpriteDataProviderFactories();
            factory.Init();
            var provider = factory.GetSpriteEditorDataProviderFromObject(t);
            provider.InitSpriteEditorDataProvider();
            var rects = new List<UnityEditor.SpriteRect>();
            for (int n = 0; n < cells.Count; n++)
                rects.Add(new UnityEditor.SpriteRect { name = baseName + "_" + n, rect = cells[n], pivot = new Vector2(0.5f, 0.5f), alignment = SpriteAlignment.Center, spriteID = GUID.Generate() });
            provider.SetSpriteRects(rects.ToArray());
            var names = provider.GetDataProvider<UnityEditor.U2D.Sprites.ISpriteNameFileIdDataProvider>();
            if (names != null) names.SetNameFileIdPairs(rects.Select(r => new UnityEditor.SpriteNameFileIdPair(r.name, r.spriteID)).ToList());
            provider.Apply();
#elif !UNITY_2023_1_OR_NEWER
#pragma warning disable 618
            var metas = new List<SpriteMetaData>();
            for (int n = 0; n < cells.Count; n++) metas.Add(new SpriteMetaData { name = baseName + "_" + n, rect = cells[n], pivot = new Vector2(0.5f, 0.5f), alignment = (int)SpriteAlignment.Center });
            t.spritesheet = metas.ToArray();
#pragma warning restore 618
#else
            throw new InvalidOperationException("slicing a sprite sheet needs the 2D Sprite package (com.unity.2d.sprite, part of the 2D feature set): add it, then import again");
#endif
        }

        static void ApplyModel(ModelImporter m, Args i)
        {
            if (i.Has("scale")) m.globalScale = i.Float("scale");
            m.importAnimation = i.Bool("animations", true);
            if (i.Has("materials")) m.materialImportMode = i.Str("materials") == "none" ? ModelImporterMaterialImportMode.None : ModelImporterMaterialImportMode.ImportStandard;
            m.isReadable = i.Bool("readable", false);
            if (i.Bool("generateColliders", false)) m.addCollider = true;
        }

        static void ApplyAudio(AudioImporter au, string kind, Args i)
        {
            var s = au.defaultSampleSettings;
            var load = i.Str("loadType", kind == "music" ? "streaming" : "decompress");
            s.loadType = load == "streaming" ? AudioClipLoadType.Streaming : load == "compressed" ? AudioClipLoadType.CompressedInMemory : AudioClipLoadType.DecompressOnLoad;
            au.defaultSampleSettings = s;
            if (i.Has("mono")) au.forceToMono = i.Bool("mono");
        }

        // ---------- export ----------

        /// <summary>items: [{source: "Assets/..." | "scene:Root/Child", format: unitypackage | prefab | fbx | glb | gltf, out}].</summary>
        public static void Export(Args a, Action<Dictionary<string, object>> done)
        {
            var results = new List<object>();
            var cleanup = new List<GameObject>();
            var waits = new List<KeyValuePair<Dictionary<string, object>, Task<bool>>>();
            foreach (var x in a.List("items"))
            {
                var i = new Args(x as Dictionary<string, object>);
                var r = new Dictionary<string, object> { { "source", i.Str("source") }, { "format", i.Str("format") }, { "out", i.Str("out") } };
                results.Add(r);
                try
                {
                    var task = ExportOne(i, r, cleanup);
                    if (task != null) waits.Add(new KeyValuePair<Dictionary<string, object>, Task<bool>>(r, task));
                    else r["ok"] = true;
                }
                catch (Exception e) { r["ok"] = false; r["error"] = (e is TargetInvocationException && e.InnerException != null ? e.InnerException : e).Message; }
            }
            Action finish = () =>
            {
                foreach (var g in cleanup) if (g != null) Object.DestroyImmediate(g);
                int failed = results.Count(r => !(bool)((Dictionary<string, object>)r)["ok"]);
                done(new Dictionary<string, object> { { "ok", failed == 0 }, { "results", results }, { "failed", failed } });
            };
            if (waits.Count == 0) { finish(); return; }
            EditorApplication.CallbackFunction poll = null;
            poll = () =>
            {
                if (waits.Any(w => !w.Value.IsCompleted)) return;
                EditorApplication.update -= poll;
                foreach (var w in waits)
                {
                    w.Key["ok"] = w.Value.Status == TaskStatus.RanToCompletion && w.Value.Result;
                    if (!(bool)w.Key["ok"]) w.Key["error"] = w.Value.Exception != null ? w.Value.Exception.GetBaseException().Message : "glTFast did not write the file";
                }
                finish();
            };
            EditorApplication.update += poll;
        }

        public static object ExportLive(Args a)
        {
            Dictionary<string, object> result = null;
            Export(a, r => result = r);
            return new HarnessPending(() => result, 600);
        }

        static Task<bool> ExportOne(Args i, Dictionary<string, object> r, List<GameObject> cleanup)
        {
            var source = i.Str("source");
            var format = i.Str("format", Path.GetExtension(i.Str("out", "")).TrimStart('.')).ToLowerInvariant();
            var output = i.Str("out");
            if (string.IsNullOrEmpty(output)) throw new ArgumentException("out is required");
            var full = Path.IsPathRooted(output) ? output : Path.Combine(EditorBridge.ProjectRoot, output);
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            if (format == "unitypackage")
            {
                var paths = i.Strings("sources");
                if (paths.Count == 0) paths.Add(source);
                AssetDatabase.ExportPackage(paths.ToArray(), full, ExportPackageOptions.Recurse | ExportPackageOptions.IncludeDependencies);
                if (!File.Exists(full)) throw new InvalidOperationException("Unity wrote no package");
                r["bytes"] = new FileInfo(full).Length;
                return null;
            }
            GameObject go = null;
            bool temp = false;
            if (source.StartsWith("scene:")) go = SceneTools.Require(source.Substring(6));
            else
            {
                var asset = AssetDatabase.LoadAssetAtPath<GameObject>(source);
                if (asset == null) throw new ArgumentException("no GameObject asset (prefab or model) at " + source);
                if (format == "fbx") go = asset;
                else { go = (GameObject)PrefabUtility.InstantiatePrefab(asset); temp = true; }
            }
            try
            {
                if (format == "prefab")
                {
                    bool ok;
                    PrefabUtility.SaveAsPrefabAsset(go, output, out ok);
                    if (!ok) throw new InvalidOperationException("Unity did not save the prefab " + output + " (out must be under Assets/)");
                    return null;
                }
                if (format == "fbx")
                {
                    var t = Type.GetType("UnityEditor.Formats.Fbx.Exporter.ModelExporter, Unity.Formats.Fbx.Editor");
                    if (t == null) throw new InvalidOperationException("FBX export needs the FBX Exporter package (com.unity.formats.fbx): add it, then export again");
                    var m = t.GetMethods(BindingFlags.Public | BindingFlags.Static).First(x => x.Name == "ExportObject" && x.GetParameters().Length == 2);
                    var written = m.Invoke(null, new object[] { full, go }) as string;
                    if (string.IsNullOrEmpty(written)) throw new InvalidOperationException("the FBX Exporter wrote nothing");
                    r["bytes"] = new FileInfo(full).Length;
                    return null;
                }
                if (format == "glb" || format == "gltf")
                {
                    var t = AppDomain.CurrentDomain.GetAssemblies().Select(x => x.GetType("GLTFast.Export.GameObjectExport")).FirstOrDefault(x => x != null);
                    if (t == null) throw new InvalidOperationException("glTF export needs glTFast (" + GltfPackage + "): import a .glb once (it is added), or add it in the Package Manager");
                    var ctor = t.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
                    var export = ctor.Invoke(ctor.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
                    var add = t.GetMethods().First(x => x.Name == "AddScene" && x.GetParameters().Length >= 1 && x.GetParameters()[0].ParameterType == typeof(GameObject[]));
                    add.Invoke(export, add.GetParameters().Length == 1 ? new object[] { new[] { go } } : new object[] { new[] { go }, go.name });
                    var save = t.GetMethods().First(x => x.Name == "SaveToFileAndDispose" && x.GetParameters().Length >= 1 && x.GetParameters()[0].ParameterType == typeof(string));
                    var args = save.GetParameters().Select((p, n) => n == 0 ? (object)full : p.ParameterType == typeof(CancellationToken) ? (object)CancellationToken.None : p.HasDefaultValue ? p.DefaultValue : null).ToArray();
                    if (temp) { cleanup.Add(go); temp = false; }
                    return (Task<bool>)save.Invoke(export, args);
                }
                throw new ArgumentException("format is unitypackage, prefab, fbx, glb or gltf");
            }
            finally { if (temp && go != null) Object.DestroyImmediate(go); }
        }
    }
}
