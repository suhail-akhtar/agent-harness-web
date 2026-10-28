// Frames from the editor without play mode: a scene camera, or a camera placed to frame the
// level (overview, top, iso, front, side), drawn into a PNG. Render makes a set of them:
// a turntable around the level or the standard views.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Harness.Bridge.Editor
{
    public static class CaptureOps
    {
        static readonly Dictionary<string, Vector3> Views = new Dictionary<string, Vector3>
        {
            { "overview", new Vector3(45f, 30f, 0f) }, { "iso", new Vector3(35.264f, 45f, 0f) }, { "top", new Vector3(90f, 0f, 0f) },
            { "front", new Vector3(15f, 0f, 0f) }, { "side", new Vector3(15f, 90f, 0f) }, { "back", new Vector3(15f, 180f, 0f) },
        };

        /// <summary>
        /// scene?, camera? (a camera's name), view? (game | scene | overview | iso | top | front | side), position?, lookAt?,
        /// width, height, out? (a file to write), inline? (the PNG as base64 in the answer).
        /// </summary>
        public static Dictionary<string, object> Capture(Args a)
        {
            if (a.Has("scene")) OpenScene(a.Str("scene"));
            SnapFollowers();
            int w = a.Int("width", 960), h = a.Int("height", 540);
            var view = a.Str("view", a.Has("position") ? "custom" : "game");
            byte[] png;
            string used;
            if (view == "scene" && SceneView.lastActiveSceneView != null)
            {
                png = HarnessCapture.RenderCamera(SceneView.lastActiveSceneView.camera, w, h);
                used = "Scene view";
            }
            else if (view == "game")
            {
                var cam = HarnessCapture.FindCamera(a.Str("camera"));
                if (cam == null) { view = "overview"; png = Framed(a, view, w, h, out used); }
                else { png = HarnessCapture.RenderCamera(cam, w, h); used = cam.name; }
            }
            else png = Framed(a, view, w, h, out used);

            var result = new Dictionary<string, object> { { "width", w }, { "height", h }, { "camera", used }, { "view", view }, { "scene", EditorSceneManager.GetActiveScene().path } };
            var output = a.Str("out");
            if (!string.IsNullOrEmpty(output))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)));
                File.WriteAllBytes(output, png);
                result["out"] = output;
            }
            if (a.Bool("inline", string.IsNullOrEmpty(output))) result["frame"] = Convert.ToBase64String(png);
            result["bytes"] = png.Length;
            return result;
        }

        public static void OpenScene(string path)
        {
            if (EditorSceneManager.GetActiveScene().path == path) return;
            if (!File.Exists(Path.Combine(EditorBridge.ProjectRoot, path))) throw new ArgumentException("no scene at " + path);
            EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
        }

        /// <summary>Puts following cameras where they will be when the game starts (at the player).</summary>
        public static void SnapFollowers()
        {
            foreach (var f in Object.FindObjectsByType<HarnessFollowCamera>(FindObjectsSortMode.None)) f.Snap();
        }

        /// <summary>A temporary camera that frames the scene's renderers from a view angle (or a given position).</summary>
        static byte[] Framed(Args a, string view, int w, int h, out string used)
        {
            var go = new GameObject("Harness Capture Camera") { hideFlags = HideFlags.HideAndDontSave };
            try
            {
                var cam = go.AddComponent<Camera>();
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = Args.ToColor(a.Raw("background"), new Color(0.19f, 0.22f, 0.28f));
                cam.fieldOfView = a.Float("fov", 40f);
                var b = SceneTools.SceneBounds();
                var target = a.Has("lookAt") ? a.Vec3("lookAt", b.center) : b.center;
                if (a.Has("position"))
                {
                    go.transform.position = a.Vec3("position", Vector3.zero);
                    go.transform.LookAt(target);
                }
                else
                {
                    Vector3 euler;
                    if (!Views.TryGetValue(view, out euler)) euler = Views["overview"];
                    if (a.Has("yaw")) euler.y = a.Float("yaw");
                    var rot = Quaternion.Euler(euler);
                    float radius = Mathf.Max(b.extents.magnitude, 0.5f);
                    float dist = radius / Mathf.Sin(Mathf.Deg2Rad * cam.fieldOfView * 0.5f) * a.Float("zoom", 1.05f);
                    go.transform.rotation = rot;
                    go.transform.position = target - rot * Vector3.forward * dist;
                    cam.nearClipPlane = Mathf.Max(0.01f, dist - radius * 2f);
                    cam.farClipPlane = dist + radius * 4f;
                    if (a.Bool("orthographic", view == "top" && b.size.y < 0.5f))
                    {
                        cam.orthographic = true;
                        cam.orthographicSize = Mathf.Max(b.extents.x / ((float)w / h), b.extents.z, b.extents.y) * 1.1f;
                    }
                }
                used = view;
                return HarnessCapture.RenderCamera(cam, w, h);
            }
            finally { Object.DestroyImmediate(go); }
        }

        /// <summary>preset: turntable (frames around the level, default 12) or views (overview, front, side, top); outDir.</summary>
        public static Dictionary<string, object> Render(Args a)
        {
            if (a.Has("scene")) OpenScene(a.Str("scene"));
            SnapFollowers();
            var outDir = a.Str("outDir");
            if (string.IsNullOrEmpty(outDir)) throw new ArgumentException("outDir is required");
            Directory.CreateDirectory(outDir);
            int w = a.Int("width", 960), h = a.Int("height", 540);
            var files = new List<object>();
            var preset = a.Str("preset", "turntable");
            if (preset == "views")
            {
                foreach (var v in new[] { "overview", "front", "side", "top" })
                {
                    string used;
                    var file = Path.Combine(outDir, v + ".png");
                    File.WriteAllBytes(file, Framed(a, v, w, h, out used));
                    files.Add(file);
                }
            }
            else
            {
                int frames = Mathf.Clamp(a.Int("frames", 12), 1, 720);
                float pitch = a.Float("pitch", 30f);
                for (int i = 0; i < frames; i++)
                {
                    var args = new Args(new Dictionary<string, object>(a.Values));
                    args.Values["yaw"] = 360.0 * i / frames;
                    Views["turntable"] = new Vector3(pitch, 0f, 0f);
                    string used;
                    var file = Path.Combine(outDir, "frame_" + i.ToString("0000") + ".png");
                    File.WriteAllBytes(file, Framed(args, "turntable", w, h, out used));
                    files.Add(file);
                }
            }
            return new Dictionary<string, object> { { "files", files }, { "preset", preset }, { "width", w }, { "height", h } };
        }
    }
}
