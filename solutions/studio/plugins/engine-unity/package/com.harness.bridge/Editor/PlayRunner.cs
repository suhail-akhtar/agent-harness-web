// Play mode for the harness, in batch mode (Batch.Play: headless, then the editor exits)
// or in the open editor (play.run, play.enter). Entering play mode reloads scripts, so the
// request waits in SessionState and is picked up on the other side of the reload; the
// report is written to the session's folder, where the harness reads it.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Harness.Bridge.Editor
{
    [InitializeOnLoad]
    public static class PlayRunner
    {
        const string RequestKey = "harness.play.request";
        const string ModeKey = "harness.play.mode";
        const string ResultKey = "harness.play.result";
        const string BegunKey = "harness.play.begun";
        const string ExitKey = "harness.play.exitAfter";

        static PlayRunner()
        {
            EditorApplication.playModeStateChanged += OnPlayMode;
            HarnessPlayback.Finished += OnFinished;
            // Already in play mode after this reload (the state event may have gone by).
            if (EditorApplication.isPlaying) EditorApplication.delayCall += () => OnPlayMode(PlayModeStateChange.EnteredPlayMode);
        }

        public static string SessionsDir { get { return Path.Combine(EditorBridge.BridgeDir, "play"); } }

        /// <summary>A timed session from Batch.Play: scene?, seconds, inputs, captureEvery, width, height, outDir.</summary>
        public static void StartBatch(Args a, string resultFile)
        {
            OpenFor(a);
            if (!a.Has("outDir")) a.Values["outDir"] = Path.Combine(SessionsDir, "batch-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"));
            Queue(a, "batch", resultFile, true);
            EditorApplication.EnterPlaymode();
        }

        /// <summary>A timed session in the open editor; answers at once with where its report will be (play.result reads it).</summary>
        public static object StartLive(Args a)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("already in play mode: play.exit first, or use play.step");
            OpenFor(a);
            var id = "live-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
            if (!a.Has("outDir")) a.Values["outDir"] = Path.Combine(SessionsDir, id);
            Queue(a, "live", null, a.Bool("exitAfter", true));
            EditorApplication.EnterPlaymode();
            return new Dictionary<string, object> { { "id", id }, { "outDir", a.Str("outDir").Replace('\\', '/') }, { "report", Path.Combine(a.Str("outDir"), "report.json").Replace('\\', '/') } };
        }

        /// <summary>Play mode for the AI player (stepMode, paused between steps) or for the person (just play).</summary>
        public static object Enter(Args a)
        {
            if (EditorApplication.isPlaying) return Status();
            OpenFor(a);
            if (a.Bool("stepMode", true)) Queue(a, "steps", null, false);
            EditorApplication.EnterPlaymode();
            return new Dictionary<string, object> { { "entering", true }, { "stepMode", a.Bool("stepMode", true) } };
        }

        public static object Exit()
        {
            Clear();
            if (EditorApplication.isPlaying) EditorApplication.ExitPlaymode();
            return new Dictionary<string, object> { { "exiting", true } };
        }

        public static object Status()
        {
            var p = HarnessPlayback.Instance;
            return new Dictionary<string, object>
            {
                { "playing", EditorApplication.isPlaying }, { "changing", EditorApplication.isPlayingOrWillChangePlaymode != EditorApplication.isPlaying },
                { "mode", SessionState.GetString(ModeKey, "") }, { "session", p != null && p.Playing }, { "ready", EditorApplication.isPlaying && p != null },
                { "scene", EditorSceneManager.GetActiveScene().path }, { "frame", Time.frameCount },
            };
        }

        public static object Result(string id)
        {
            var file = Path.Combine(SessionsDir, id ?? "", "report.json");
            if (string.IsNullOrEmpty(id) || !File.Exists(file)) return new Dictionary<string, object> { { "done", false } };
            return new Dictionary<string, object> { { "done", true }, { "report", Json.Parse(File.ReadAllText(file)) } };
        }

        static void OpenFor(Args a)
        {
            var scene = a.Str("scene");
            if (!string.IsNullOrEmpty(scene) && scene != EditorSceneManager.GetActiveScene().path)
            {
                if (EditorSceneManager.GetActiveScene().isDirty && !a.Bool("discard") && !Application.isBatchMode)
                    throw new InvalidOperationException("the open scene has unsaved changes: save it (scene.save) before playing another one, or pass discard: true");
                CaptureOps.OpenScene(scene);
            }
            else if (string.IsNullOrEmpty(EditorSceneManager.GetActiveScene().path) && EditorBuildSettings.scenes.Length > 0)
                EditorSceneManager.OpenScene(EditorBuildSettings.scenes[0].path);
        }

        static void Queue(Args a, string mode, string resultFile, bool exitAfter)
        {
            SessionState.SetString(RequestKey, Json.Write(a.Values));
            SessionState.SetString(ModeKey, mode);
            SessionState.SetString(ResultKey, resultFile ?? "");
            SessionState.SetBool(BegunKey, false);
            SessionState.SetBool(ExitKey, exitAfter);
        }

        static void Clear()
        {
            SessionState.EraseString(RequestKey);
            SessionState.EraseString(ModeKey);
            SessionState.EraseString(ResultKey);
            SessionState.EraseBool(BegunKey);
            SessionState.EraseBool(ExitKey);
        }

        static void OnPlayMode(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredPlayMode)
            {
                var req = SessionState.GetString(RequestKey, "");
                if (req.Length == 0 || SessionState.GetBool(BegunKey, false)) return;
                SessionState.SetBool(BegunKey, true);
                var mode = SessionState.GetString(ModeKey, "");
                try
                {
                    var p = HarnessPlayback.Ensure();
                    if (mode == "steps") p.BeginStepMode();
                    else
                    {
                        var args = new Args(Json.ParseObject(req));
                        args.Values["quit"] = false;
                        p.Begin(args);
                    }
                }
                catch (Exception e) { Fail(mode, e.Message); }
            }
            else if (change == PlayModeStateChange.EnteredEditMode)
            {
                var mode = SessionState.GetString(ModeKey, "");
                // Left play mode before the session finished (the person pressed Stop): it ends there.
                if (mode == "batch") Fail(mode, "play mode ended before the session finished");
                Clear();
            }
        }

        static void OnFinished(Dictionary<string, object> report)
        {
            var mode = SessionState.GetString(ModeKey, "");
            if (mode != "batch" && mode != "live") return;
            var resultFile = SessionState.GetString(ResultKey, "");
            bool exitAfter = SessionState.GetBool(ExitKey, true);
            Clear();
            if (mode == "batch")
            {
                BatchRunner.Finish(new Dictionary<string, object> { { "report", report } }, true, resultFile);
                return;
            }
            if (exitAfter) EditorApplication.delayCall += () => { if (EditorApplication.isPlaying) EditorApplication.ExitPlaymode(); };
        }

        static void Fail(string mode, string error)
        {
            Debug.LogError("[Harness] play: " + error);
            if (mode == "batch")
            {
                var resultFile = SessionState.GetString(ResultKey, "");
                Clear();
                BatchRunner.Finish(new Dictionary<string, object> { { "error", error } }, false, resultFile);
            }
        }
    }
}
