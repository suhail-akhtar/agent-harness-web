// The project as JSON: settings, packages, the scenes in the build, the asset tree by type,
// and the hierarchy of the open (or a named) scene.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace Harness.Bridge.Editor
{
    public static class Describe
    {
        static readonly string[] Kinds = { "Scene", "Prefab", "Script", "Material", "Texture2D", "Sprite", "Model", "AudioClip", "AnimationClip", "AnimatorController", "Shader", "ScriptableObject", "TileBase" };

        public static Dictionary<string, object> Project(Args a)
        {
            if (a.Has("scene") && !EditorApplication.isPlaying) CaptureOps.OpenScene(a.Str("scene"));
            var target = EditorUserBuildSettings.activeBuildTarget;
            var group = BuildPipeline.GetBuildTargetGroup(target);
            var settings = new Dictionary<string, object>
            {
                { "unity", Application.unityVersion }, { "productName", PlayerSettings.productName }, { "companyName", PlayerSettings.companyName },
                { "version", PlayerSettings.bundleVersion }, { "renderPipeline", GraphicsSettings.currentRenderPipeline == null ? "Built-in" : GraphicsSettings.currentRenderPipeline.GetType().Name },
                { "renderPipelineAsset", GraphicsSettings.defaultRenderPipeline == null ? null : AssetDatabase.GetAssetPath(GraphicsSettings.defaultRenderPipeline) },
                { "colorSpace", PlayerSettings.colorSpace.ToString() }, { "activeBuildTarget", target.ToString() },
                { "scriptingBackend", PlayerSettings.GetScriptingBackend(NamedBuildTarget.FromBuildTargetGroup(group)).ToString() },
                { "inputHandler", ProjectSetup.InputHandlerName(ProjectSetup.InputHandler()) },
                { "editorMode", EditorSettings.defaultBehaviorMode.ToString() },
            };
            var packages = new List<object>();
            foreach (var p in UnityEditor.PackageManager.PackageInfo.GetAllRegisteredPackages())
            {
                if (p.source == UnityEditor.PackageManager.PackageSource.BuiltIn && p.name.StartsWith("com.unity.modules.")) continue;
                packages.Add(new Dictionary<string, object> { { "name", p.name }, { "version", p.version }, { "source", p.source.ToString() } });
            }
            int max = a.Int("maxAssets", 300);
            var assets = new Dictionary<string, object>();
            foreach (var k in Kinds)
            {
                var guids = AssetDatabase.FindAssets("t:" + k, new[] { "Assets" });
                var paths = guids.Select(AssetDatabase.GUIDToAssetPath).Distinct().ToList();
                if (paths.Count == 0) continue;
                assets[k] = new Dictionary<string, object> { { "count", paths.Count }, { "paths", paths.Take(max).Cast<object>().ToList() } };
            }
            var result = new Dictionary<string, object>
            {
                { "settings", settings }, { "packages", packages },
                { "buildScenes", EditorBuildSettings.scenes.Select(s => (object)new Dictionary<string, object> { { "path", s.path }, { "enabled", s.enabled } }).ToList() },
                { "assets", assets }, { "activeScene", EditorSceneManager.GetActiveScene().path },
            };
            if (a.Bool("hierarchy", true)) result["hierarchy"] = SceneTools.Hierarchy(a.Int("depth", 4), a.Int("max", 1500), false);
            return result;
        }
    }
}
