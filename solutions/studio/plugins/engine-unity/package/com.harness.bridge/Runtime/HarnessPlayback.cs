// Runs the game for the harness: an input timeline for N seconds with frames and metrics
// (fps, frame times, memory, draw calls, errors) written to a report, or step by step for
// the AI player (inputs in, the game advances some frames and pauses, a frame and the
// state come back). In a built player it starts only when the harness passed
// -harnessPlay <file> or -harnessBridgeFile <file>; in the editor the bridge starts it.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Unity.Profiling;
using UnityEngine;

namespace Harness.Bridge
{
    [DefaultExecutionOrder(-10000)]
    public sealed class HarnessPlayback : MonoBehaviour
    {
        public static HarnessPlayback Instance { get; private set; }
        /// <summary>Raised with the report when a timed session ends.</summary>
        public static event Action<Dictionary<string, object>> Finished;
        public static Dictionary<string, object> LastReport { get; private set; }

        HarnessServer server;

        // A timed session.
        bool playing;
        float seconds;
        float startTime;
        List<Dictionary<string, object>> timeline = new List<Dictionary<string, object>>();
        int nextInput;
        float captureEvery;
        float nextCapture;
        int width = 960;
        int height = 540;
        string outDir;
        bool quitAtEnd;
        readonly List<string> frames = new List<string>();
        int capturesPending;
        float pendingSince;
        bool forceCameras;
        bool finishing;
        float finishingAt;
        int eventsAtStart;

        // Metrics.
        readonly List<float> frameMs = new List<float>();
        float windowStart;
        int windowFrames;
        float minFps = float.MaxValue;
        long peakAllocated;
        ProfilerRecorder drawCalls;
        ProfilerRecorder triangles;
        double drawSum;
        double triSum;
        int drawSamples;
        int errors;
        readonly List<string> errorMessages = new List<string>();
        readonly object logGate = new object();

        // Step mode.
        int stepFramesLeft = -1;
        Dictionary<string, object> stepResult;
        bool stepCapture = true;
        int lastEventSeq;
        string stepCamera;
        float screenSince = -1f;

        public bool Playing { get { return playing; } }
        public bool Stepping { get { return stepFramesLeft >= 0; } }

        public static HarnessPlayback Ensure()
        {
            if (Instance != null) return Instance;
            var go = new GameObject("HarnessPlayback");
            DontDestroyOnLoad(go);
            Instance = go.AddComponent<HarnessPlayback>();
            return Instance;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (Application.isEditor) return;
            var args = Environment.GetCommandLineArgs();
            var play = Arg(args, "-harnessPlay");
            var bridge = Arg(args, "-harnessBridgeFile");
            if (play == null && bridge == null) return;
            var p = Ensure();
            try
            {
                if (bridge != null)
                {
                    var cfg = new Args(Json.ParseObject(File.ReadAllText(bridge)));
                    p.StartServer(cfg.Int("port", 0), cfg.Str("token"));
                    if (cfg.Bool("step", true)) p.BeginStepMode();
                }
                if (play != null) p.Begin(new Args(Json.ParseObject(File.ReadAllText(play))));
            }
            catch (Exception e)
            {
                Debug.LogError("[Harness] could not start: " + e.Message);
                if (play != null) Application.Quit(3);
            }
        }

        static string Arg(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }

        // ---------- the runtime bridge (a player started for the AI player) ----------

        public void StartServer(int port, string token)
        {
            server = new HarnessServer(port, token);
            server.Register("status", a => Status());
            server.Register("play.step", Step);
            server.Register("play.observe", Observe);
            server.Register("play.state", a => new Dictionary<string, object> { { "state", HarnessState.Snapshot() }, { "events", HarnessState.EventsSince(a.Int("after", 0)) } });
            server.Register("play.quit", a => { Application.Quit(); return HarnessVoid.Value; });
            server.Start();
            Debug.Log("[Harness] runtime bridge on 127.0.0.1:" + server.Port);
        }

        public Dictionary<string, object> Status()
        {
            return new Dictionary<string, object>
            {
                { "unity", Application.unityVersion }, { "product", Application.productName }, { "isEditor", Application.isEditor },
                { "playing", Application.isPlaying }, { "session", playing }, { "stepping", Stepping }, { "frame", Time.frameCount },
                { "time", Math.Round(Time.timeSinceLevelLoad, 3) }, { "timeScale", Time.timeScale },
                { "scene", UnityEngine.SceneManagement.SceneManager.GetActiveScene().path },
            };
        }

        void OnDestroy()
        {
            if (server != null) server.Stop("the game stopped");
            Application.logMessageReceivedThreaded -= OnLog;
            if (drawCalls.Valid) drawCalls.Dispose();
            if (triangles.Valid) triangles.Dispose();
            if (Instance == this) Instance = null;
        }

        // ---------- a timed session ----------

        /// <summary>
        /// Starts a session: seconds, inputs [{t, type: "key", key, down} | {t, type: "axis", axis, value}],
        /// captureEvery (seconds, 0: first and last frame only), width, height, outDir, quit.
        /// </summary>
        public void Begin(Args a)
        {
            seconds = Mathf.Clamp(a.Float("seconds", 10f), 0.1f, 3600f);
            timeline = new List<Dictionary<string, object>>();
            foreach (var x in a.List("inputs")) { var d = x as Dictionary<string, object>; if (d != null) timeline.Add(d); }
            timeline.Sort((p, q) => new Args(p).Num("t").CompareTo(new Args(q).Num("t")));
            nextInput = 0;
            captureEvery = Mathf.Max(0f, a.Float("captureEvery", 1f));
            width = a.Int("width", 960);
            height = a.Int("height", 540);
            outDir = a.Str("outDir", Path.Combine(Application.persistentDataPath, "harness-play"));
            quitAtEnd = a.Bool("quit", !Application.isEditor);
            Directory.CreateDirectory(Path.Combine(outDir, "frames"));
            frames.Clear();
            frameMs.Clear();
            lock (logGate) { errors = 0; errorMessages.Clear(); }
            minFps = float.MaxValue;
            peakAllocated = 0;
            drawSum = 0; triSum = 0; drawSamples = 0;
            HarnessInput.Reset();
            eventsAtStart = HarnessState.LastSeq;
            Application.logMessageReceivedThreaded -= OnLog;
            Application.logMessageReceivedThreaded += OnLog;
            if (!drawCalls.Valid) drawCalls = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count");
            if (!triangles.Valid) triangles = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Triangles Count");
            Time.timeScale = 1f;
            startTime = Time.time;
            windowStart = Time.unscaledTime;
            windowFrames = 0;
            nextCapture = 0f;
            finishing = false;
            playing = true;
            HarnessState.Emit("session-start", seconds.ToString("0.##") + " s");
        }

        void OnLog(string message, string stack, LogType type)
        {
            if (type != LogType.Error && type != LogType.Exception && type != LogType.Assert) return;
            lock (logGate)
            {
                errors++;
                if (errorMessages.Count < 20) errorMessages.Add(type + ": " + message + (string.IsNullOrEmpty(stack) ? "" : "\n" + string.Join("\n", stack.Split('\n').Take(3))));
            }
        }

        void Update()
        {
            // The Game view draws nothing while it is hidden: end-of-frame captures never come, so cameras draw instead.
            if (capturesPending > 0 && Time.realtimeSinceStartup - pendingSince > 1.5f) forceCameras = true;
            if (screenSince >= 0f && stepResult == null && Time.realtimeSinceStartup - screenSince > 1.5f)
            {
                screenSince = -1f;
                forceCameras = true;
                stepResult = Observation(CameraFrame());
            }
            if (stepFramesLeft > 0)
            {
                stepFramesLeft--;
                if (stepFramesLeft == 0) PauseAndObserve();
            }
            if (server != null) server.Pump();
            if (!playing || finishing) return;

            float elapsed = Time.time - startTime;
            while (nextInput < timeline.Count && new Args(timeline[nextInput]).Num("t") <= elapsed) Apply(new Args(timeline[nextInput++]));

            float dt = Time.unscaledDeltaTime;
            if (Time.frameCount > 2 && dt > 0f) frameMs.Add(dt * 1000f);
            windowFrames++;
            if (Time.unscaledTime - windowStart >= 1f)
            {
                minFps = Mathf.Min(minFps, windowFrames / (Time.unscaledTime - windowStart));
                windowStart = Time.unscaledTime;
                windowFrames = 0;
            }
            peakAllocated = Math.Max(peakAllocated, UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong());
            if (drawCalls.Valid && drawCalls.LastValue > 0) { drawSum += drawCalls.LastValue; triSum += triangles.Valid ? triangles.LastValue : 0; drawSamples++; }

            if (elapsed >= nextCapture)
            {
                Capture(Path.Combine(outDir, "frames", frames.Count.ToString("0000") + ".png"), true);
                nextCapture = captureEvery > 0f ? nextCapture + captureEvery : float.MaxValue;
            }
            if (elapsed >= seconds)
            {
                finishing = true;
                finishingAt = Time.realtimeSinceStartup;
                Capture(Path.Combine(outDir, "frames", frames.Count.ToString("0000") + ".png"), true);
            }
            if (finishing && (capturesPending == 0 || Time.realtimeSinceStartup - finishingAt > 3f)) Finish();
        }

        void LateUpdate()
        {
            if (playing && finishing && (capturesPending == 0 || Time.realtimeSinceStartup - finishingAt > 3f)) Finish();
        }

        static void Apply(Args e)
        {
            var type = e.Str("type", e.Has("axis") ? "axis" : "key");
            if (type == "axis") HarnessInput.SetAxis(e.Str("axis"), e.Float("value"));
            else if (!HarnessInput.SetKey(e.Str("key"), e.Bool("down", true))) Debug.LogWarning("[Harness] unknown key \"" + e.Str("key") + "\" (use KeyCode names: W, Space, LeftArrow)");
        }

        void Capture(string file, bool record)
        {
            if (HarnessCapture.UseCameras || forceCameras)
            {
                try
                {
                    File.WriteAllBytes(file, HarnessCapture.RenderCamera(HarnessCapture.FindCamera(stepCamera), width, height));
                    if (record) frames.Add(file);
                }
                catch (Exception e) { Debug.LogWarning("[Harness] frame not captured: " + e.Message); }
                return;
            }
            if (capturesPending == 0) pendingSince = Time.realtimeSinceStartup;
            capturesPending++;
            StartCoroutine(HarnessCapture.CaptureScreen(width, height, png =>
            {
                try { File.WriteAllBytes(file, png); if (record) frames.Add(file); }
                catch (Exception e) { Debug.LogWarning("[Harness] frame not written: " + e.Message); }
                finally { capturesPending--; }
            }));
        }

        void Finish()
        {
            if (!playing) return;
            playing = false;
            Application.logMessageReceivedThreaded -= OnLog;
            HarnessInput.Reset();
            HarnessState.Emit("session-end", null);
            var sorted = frameMs.OrderBy(x => x).ToList();
            float elapsedReal = sorted.Sum() / 1000f;
            var metrics = new Dictionary<string, object>
            {
                { "frameCount", Time.frameCount },
                { "fpsAvg", sorted.Count > 0 && elapsedReal > 0 ? Math.Round(sorted.Count / elapsedReal, 1) : 0 },
                { "fpsMin", minFps == float.MaxValue ? 0 : Math.Round(minFps, 1) },
                { "frameMsAvg", sorted.Count > 0 ? Math.Round(sorted.Average(), 2) : 0 },
                { "frameMsP95", sorted.Count > 0 ? Math.Round(sorted[Mathf.Clamp((int)(sorted.Count * 0.95f), 0, sorted.Count - 1)], 2) : 0 },
                { "frameMsMax", sorted.Count > 0 ? Math.Round(sorted[sorted.Count - 1], 2) : 0 },
                { "memoryMb", Math.Round(peakAllocated / 1048576.0, 1) },
                { "reservedMb", Math.Round(UnityEngine.Profiling.Profiler.GetTotalReservedMemoryLong() / 1048576.0, 1) },
            };
            if (drawSamples > 0) { metrics["drawCalls"] = Math.Round(drawSum / drawSamples, 1); metrics["triangles"] = Math.Round(triSum / drawSamples); }
            int errorCount;
            List<string> messages;
            lock (logGate) { errorCount = errors; messages = new List<string>(errorMessages); }
            metrics["errors"] = errorCount;
            var report = new Dictionary<string, object>
            {
                { "engine", "unity" }, { "durationS", Math.Round(Time.time - startTime, 2) }, { "seconds", seconds },
                { "frames", frames.Select(f => "frames/" + Path.GetFileName(f)).ToList() },
                { "events", HarnessState.EventsSince(eventsAtStart) }, { "state", HarnessState.Snapshot() },
                { "metrics", metrics }, { "errors", messages }, { "unity", Application.unityVersion }, { "editor", Application.isEditor },
                { "scene", UnityEngine.SceneManagement.SceneManager.GetActiveScene().path },
            };
            LastReport = report;
            try { File.WriteAllText(Path.Combine(outDir, "report.json"), Json.Write(report)); }
            catch (Exception e) { Debug.LogError("[Harness] report not written: " + e.Message); }
            Debug.Log("[Harness] session finished: " + frames.Count + " frames, " + errorCount + " errors");
            var handler = Finished;
            if (handler != null) handler(report);
            if (quitAtEnd && !Application.isEditor) Application.Quit(0);
        }

        // ---------- step mode (the AI player) ----------

        /// <summary>Pauses the game (timeScale 0) until the first step.</summary>
        public void BeginStepMode()
        {
            HarnessInput.Reset();
            Time.timeScale = 0f;
            lastEventSeq = HarnessState.LastSeq;
            HarnessState.Emit("step-mode", null);
        }

        /// <summary>
        /// One step: hold these keys (others released), set these axes, run `frames` frames (default 6),
        /// pause, and answer with the frame (unless capture is false), the state and the new events.
        /// </summary>
        public object Step(Args a)
        {
            if (stepFramesLeft > 0) throw new InvalidOperationException("a step is already running");
            HarnessInput.Hold(a.Strings("hold"));
            var axes = a.Raw("axes") as Dictionary<string, object>;
            if (axes != null) foreach (var kv in axes) HarnessInput.SetAxis(kv.Key, Convert.ToSingle(kv.Value));
            foreach (var k in a.Strings("press")) HarnessInput.SetKey(k, true);
            stepCapture = a.Bool("capture", true);
            width = a.Int("width", width);
            height = a.Int("height", height);
            stepCamera = a.Str("camera", stepCamera);
            stepResult = null;
            Time.timeScale = Mathf.Clamp(a.Float("timeScale", 1f), 0.05f, 20f);
            stepFramesLeft = Mathf.Clamp(a.Int("frames", 6), 1, 600);
            var press = a.Strings("press");
            return new HarnessPending(() =>
            {
                if (stepResult == null) return null;
                foreach (var k in press) HarnessInput.SetKey(k, false);
                return stepResult;
            }, a.Num("timeoutS", 60));
        }

        /// <summary>The current frame and state without advancing.</summary>
        public object Observe(Args a)
        {
            stepCapture = a.Bool("capture", true);
            width = a.Int("width", width);
            height = a.Int("height", height);
            stepCamera = a.Str("camera", stepCamera);
            stepResult = null;
            PauseAndObserve(Time.timeScale);
            return new HarnessPending(() => stepResult, a.Num("timeoutS", 30));
        }

        void PauseAndObserve(float keepScale = 0f)
        {
            stepFramesLeft = -1;
            Time.timeScale = keepScale;
            if (!stepCapture) { stepResult = Observation(null); return; }
            if (HarnessCapture.UseCameras || forceCameras)
            {
                stepResult = Observation(CameraFrame());
                return;
            }
            screenSince = Time.realtimeSinceStartup;
            StartCoroutine(HarnessCapture.CaptureScreen(width, height, png =>
            {
                if (screenSince < 0f) return;
                screenSince = -1f;
                stepResult = Observation(png);
            }));
        }

        byte[] CameraFrame()
        {
            try { return HarnessCapture.RenderCamera(HarnessCapture.FindCamera(stepCamera), width, height); }
            catch (Exception e) { Debug.LogWarning("[Harness] frame not captured: " + e.Message); return null; }
        }

        Dictionary<string, object> Observation(byte[] png)
        {
            var state = HarnessState.Snapshot();
            var events = HarnessState.EventsSince(lastEventSeq);
            lastEventSeq = HarnessState.LastSeq;
            bool done = IsTrue(state, "done") || IsTrue(state, "won") || IsTrue(state, "lost");
            return new Dictionary<string, object>
            {
                { "frame", png == null ? null : Convert.ToBase64String(png) }, { "width", width }, { "height", height },
                { "state", state }, { "events", events }, { "t", Math.Round(Time.timeSinceLevelLoad, 3) },
                { "frameCount", Time.frameCount }, { "done", done },
            };
        }

        static bool IsTrue(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
    }
}
