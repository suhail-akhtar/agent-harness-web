// Setting a new project up after the harness wrote it (from a template or a minimal one):
// the product name, input handling (both the Input System and the old Input Manager, so
// HarnessInput and Input System actions both work), URP when it was asked for and is not
// active yet, the main scene, and the scenes in the build.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace Harness.Bridge.Editor
{
    public static class ProjectSetup
    {
        /// <summary>name, company, dimension (2d | 2.5d | 3d), urp (bool), scene (the main scene to make when missing).</summary>
        public static Dictionary<string, object> Configure(Args a)
        {
            var notes = new List<object>();
            if (a.Has("name")) PlayerSettings.productName = a.Str("name");
            if (a.Has("company")) PlayerSettings.companyName = a.Str("company");
            var dim = a.Str("dimension", "3d");
            EditorSettings.defaultBehaviorMode = dim == "2d" ? EditorBehaviorMode.Mode2D : EditorBehaviorMode.Mode3D;

            bool inputSystem = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem") != null;
            var handler = InputHandler();
            if (inputSystem && handler != 2 && a.Bool("bothInputs", true))
            {
                SetInputHandler(2);
                notes.Add("input handling set to Both (the Input System and the Input Manager); it applies after the editor restarts");
            }

            if (a.Bool("urp") && GraphicsSettings.defaultRenderPipeline == null)
            {
                var made = MakeUrp(dim == "2d");
                notes.Add(made ?? "URP was asked for but its package is not installed");
            }

            var scenePath = a.Str("scene", "Assets/Scenes/Main.unity");
            if (!File.Exists(Path.Combine(EditorBridge.ProjectRoot, scenePath)) && a.Bool("makeScene", true))
            {
                var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
                var cam = Camera.main;
                if (cam != null && dim == "2d")
                {
                    cam.orthographic = true;
                    cam.orthographicSize = 5f;
                    cam.transform.position = new Vector3(0f, 0f, -10f);
                    cam.transform.rotation = Quaternion.identity;
                    cam.clearFlags = CameraClearFlags.SolidColor;
                    foreach (var l in Object.FindObjectsByType<Light>(FindObjectsSortMode.None)) Object.DestroyImmediate(l.gameObject);
                }
                Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(EditorBridge.ProjectRoot, scenePath)));
                EditorSceneManager.SaveScene(scene, scenePath);
                notes.Add("made " + scenePath);
            }
            if (File.Exists(Path.Combine(EditorBridge.ProjectRoot, scenePath))) AddToBuild(scenePath, true);
            foreach (var f in new[] { "Assets/Scenes", "Assets/Scripts", "Assets/Prefabs", "Assets/Art", "Assets/Audio" }) LevelBuilder.Folder(f);
            AssetDatabase.SaveAssets();
            return new Dictionary<string, object>
            {
                { "productName", PlayerSettings.productName }, { "renderPipeline", GraphicsSettings.defaultRenderPipeline == null ? "Built-in" : GraphicsSettings.defaultRenderPipeline.name },
                { "inputHandler", InputHandlerName(InputHandler()) }, { "inputSystem", inputSystem }, { "scenes", EditorBuildSettings.scenes.Select(s => (object)s.path).ToList() },
                { "notes", notes }, { "unity", Application.unityVersion },
            };
        }

        /// <summary>Adds a scene to the build settings (first when main), once.</summary>
        public static void AddToBuild(string path, bool main)
        {
            var list = EditorBuildSettings.scenes.Where(s => s.path != path).ToList();
            var entry = new EditorBuildSettingsScene(path, true);
            if (main) list.Insert(0, entry); else list.Add(entry);
            EditorBuildSettings.scenes = list.ToArray();
        }

        static SerializedObject PlayerSettingsObject()
        {
            var all = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset");
            return all != null && all.Length > 0 ? new SerializedObject(all[0]) : null;
        }

        /// <summary>0: the Input Manager, 1: the Input System, 2: both (-1 when unknown).</summary>
        public static int InputHandler()
        {
            var so = PlayerSettingsObject();
            var p = so == null ? null : so.FindProperty("activeInputHandler");
            return p == null ? -1 : p.intValue;
        }

        public static string InputHandlerName(int v) { return v == 0 ? "Input Manager" : v == 1 ? "Input System" : v == 2 ? "Both" : "unknown"; }

        static void SetInputHandler(int v)
        {
            var so = PlayerSettingsObject();
            var p = so == null ? null : so.FindProperty("activeInputHandler");
            if (p == null) return;
            p.intValue = v;
            so.ApplyModifiedProperties();
        }

        /// <summary>A URP asset with a (2D) renderer, made active; by reflection, so this compiles without URP.</summary>
        static string MakeUrp(bool twoD)
        {
            const string asm = ", Unity.RenderPipelines.Universal.Runtime";
            var assetType = Type.GetType("UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset" + asm);
            var dataType = Type.GetType((twoD ? "UnityEngine.Rendering.Universal.Renderer2DData" : "UnityEngine.Rendering.Universal.UniversalRendererData") + asm);
            if (assetType == null || dataType == null) return null;
            LevelBuilder.Folder("Assets/Settings");
            var data = ScriptableObject.CreateInstance(dataType);
            AssetDatabase.CreateAsset(data, "Assets/Settings/Harness_Renderer.asset");
            var create = assetType.GetMethods(BindingFlags.Public | BindingFlags.Static).FirstOrDefault(m => m.Name == "Create" && m.GetParameters().Length == 1);
            if (create == null) return "URP is installed but UniversalRenderPipelineAsset.Create was not found";
            var asset = (RenderPipelineAsset)create.Invoke(null, new object[] { data });
            AssetDatabase.CreateAsset(asset, "Assets/Settings/Harness_URP.asset");
            GraphicsSettings.defaultRenderPipeline = asset;
            for (int i = 0; i < QualitySettings.names.Length; i++)
            {
                QualitySettings.SetQualityLevel(i, false);
                QualitySettings.renderPipeline = asset;
            }
            AssetDatabase.SaveAssets();
            return "made URP active (Assets/Settings/Harness_URP.asset, " + (twoD ? "2D renderer" : "universal renderer") + ")";
        }
    }
}
