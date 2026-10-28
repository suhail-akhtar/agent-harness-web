// Recording play mode with the Unity Recorder (com.unity.recorder) when the project has it:
// the Game view as a PNG sequence at a fixed frame rate for N seconds (render.record), so
// a shot is frame-exact even when the editor runs slower than real time. Without the
// Recorder this part does not compile and render uses frame captures instead.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Recorder;
using UnityEditor.Recorder.Input;
using UnityEngine;

namespace Harness.Bridge.Editor
{
    [InitializeOnLoad]
    public static class RecorderBridge
    {
        static RecorderController controller;
        static double stopAt;
        static string folder;

        static RecorderBridge()
        {
            EditorBridge.Register("render.record", Record);
            EditorBridge.Register("render.status", a => Status());
        }

        static object Record(Args a)
        {
            if (!EditorApplication.isPlaying) throw new InvalidOperationException("the Recorder records play mode: play.enter (stepMode: false) first");
            if (controller != null && controller.IsRecording()) throw new InvalidOperationException("already recording");
            folder = a.Str("outDir");
            if (string.IsNullOrEmpty(folder)) throw new ArgumentException("outDir is required");
            Directory.CreateDirectory(folder);
            var settings = ScriptableObject.CreateInstance<RecorderControllerSettings>();
            var images = ScriptableObject.CreateInstance<ImageRecorderSettings>();
            images.name = "Harness frames";
            images.Enabled = true;
            images.OutputFormat = ImageRecorderSettings.ImageRecorderOutputFormat.PNG;
            images.imageInputSettings = new GameViewInputSettings { OutputWidth = a.Int("width", 1280), OutputHeight = a.Int("height", 720) };
            images.OutputFile = Path.Combine(folder, "frame_") + DefaultWildcard.Frame;
            settings.AddRecorderSettings(images);
            settings.SetRecordModeToManual();
            settings.FrameRate = a.Float("fps", 30f);
            settings.CapFrameRate = true;
            RecorderOptions.VerboseMode = false;
            controller = new RecorderController(settings);
            controller.PrepareRecording();
            controller.StartRecording();
            stopAt = EditorApplication.timeSinceStartup + a.Num("seconds", 5);
            EditorApplication.update -= Tick;
            EditorApplication.update += Tick;
            return new Dictionary<string, object> { { "recording", true }, { "outDir", folder.Replace('\\', '/') }, { "seconds", a.Num("seconds", 5) } };
        }

        static void Tick()
        {
            if (controller == null || !controller.IsRecording()) { EditorApplication.update -= Tick; return; }
            if (EditorApplication.timeSinceStartup < stopAt && EditorApplication.isPlaying) return;
            controller.StopRecording();
            EditorApplication.update -= Tick;
        }

        static object Status()
        {
            bool recording = controller != null && controller.IsRecording();
            int frames = string.IsNullOrEmpty(folder) || !Directory.Exists(folder) ? 0 : Directory.GetFiles(folder, "frame_*.png").Length;
            return new Dictionary<string, object> { { "recording", recording }, { "frames", frames }, { "outDir", folder } };
        }
    }
}
