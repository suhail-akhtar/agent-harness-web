// The batch entry points for Unity.exe -batchmode -projectPath <p> -executeMethod
// Harness.Bridge.Batch.<Name> -harnessArgs <args.json> -harnessResult <result.json>.
// Each one exits the editor itself (no -quit), with 0 when it worked.

using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEngine;
using Ed = Harness.Bridge.Editor;

namespace Harness.Bridge
{
    public static class Batch
    {
        /// <summary>Set by the test runner part of the package when the Test Framework is installed.</summary>
        public static Action<Args, Action<Dictionary<string, object>>> TestRunner;

        /// <summary>The project opened and every script compiled (Unity stops before this when they do not).</summary>
        public static void Check()
        {
            Ed.BatchRunner.Run("Check", a => new Dictionary<string, object> { { "compiled", true }, { "messages", Ed.EditorBridge.CompileMessages() }, { "console", Ed.EditorBridge.ConsoleEntries("warning", 100) } });
        }

        /// <summary>Product name, input handling, URP, the main scene and the build's scenes.</summary>
        public static void ConfigureProject() { Ed.BatchRunner.Run("ConfigureProject", Ed.ProjectSetup.Configure); }

        /// <summary>A scene from a layout (see LevelBuilder), with a capture when asked.</summary>
        public static void BuildLevelFromLayout() { Ed.BatchRunner.Run("BuildLevelFromLayout", a => Ed.LevelBuilder.Build(a, false)); }

        public static void ImportAssets()
        {
            Ed.BatchRunner.Run("ImportAssets", a =>
            {
                Ed.AssetOps.Import(a, a.Str("dimension", "3d") == "2d" || EditorSettings.defaultBehaviorMode == EditorBehaviorMode.Mode2D, r => Ed.BatchRunner.Finish(r, !(r["ok"] is bool) || (bool)r["ok"], null));
                return null;
            });
        }

        public static void ExportAssets()
        {
            Ed.BatchRunner.Run("ExportAssets", a =>
            {
                Ed.AssetOps.Export(a, r => Ed.BatchRunner.Finish(r, (bool)r["ok"], null));
                return null;
            });
        }

        public static void Capture() { Ed.BatchRunner.Run("Capture", Ed.CaptureOps.Capture); }

        public static void Render() { Ed.BatchRunner.Run("Render", Ed.CaptureOps.Render); }

        public static void Build() { Ed.BatchRunner.Run("Build", Ed.BuildOps.Build); }

        public static void Describe() { Ed.BatchRunner.Run("Describe", Ed.Describe.Project); }

        public static void RunScript() { Ed.BatchRunner.Run("RunScript", Ed.ScriptOps.Invoke); }

        /// <summary>Play mode headless for N seconds with an input timeline; the report has frames and metrics.</summary>
        public static void Play()
        {
            Ed.BatchRunner.Run("Play", a =>
            {
                Ed.PlayRunner.StartBatch(a, Ed.BatchRunner.Arg("-harnessResult"));
                return null;
            });
        }

        /// <summary>Unity Test Framework through its API: platform (EditMode | PlayMode), filter, results (an XML file).</summary>
        public static void RunTests()
        {
            Ed.BatchRunner.Run("RunTests", a =>
            {
                if (TestRunner == null) return new Dictionary<string, object> { { "ok", false }, { "error", "the Unity Test Framework (com.unity.test-framework) is not installed" } };
                TestRunner(a, r => Ed.BatchRunner.Finish(r, (bool)r["ok"], null));
                return null;
            });
        }

        /// <summary>Adds packages by name (the registry picks versions for this editor): add, remove.</summary>
        public static void AddPackages()
        {
            Ed.BatchRunner.Run("AddPackages", a =>
            {
                var add = a.Strings("add").ToArray();
                var remove = a.Strings("remove").ToArray();
                var req = Client.AddAndRemove(add, remove);
                EditorApplication.CallbackFunction poll = null;
                poll = () =>
                {
                    if (!req.IsCompleted) return;
                    EditorApplication.update -= poll;
                    var ok = req.Status == StatusCode.Success;
                    Ed.BatchRunner.Finish(new Dictionary<string, object> { { "added", add }, { "removed", remove }, { "error", ok ? null : (req.Error == null ? "failed" : req.Error.message) } }, ok, null);
                };
                EditorApplication.update += poll;
                return null;
            });
        }
    }
}
