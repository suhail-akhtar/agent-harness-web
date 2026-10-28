// The collect-and-escape rules the level builder sets up: pick up every collectible, then
// reach the exit (it opens when all are collected). Hazards and falling send the player
// back to the start. Everything is published to HarnessState (score, collected, total,
// won, player position) with events, and drawn as a small HUD.

using System.Collections.Generic;
using UnityEngine;

namespace Harness.Bridge
{
    public sealed class HarnessGameRules : MonoBehaviour
    {
        public Transform player;
        public bool exitNeedsAll = true;
        [Tooltip("Seconds to finish (0: no limit).")]
        public float timeLimit = 0f;
        public float fallY = -20f;
        public bool showHud = true;

        readonly List<HarnessCollectible> collectibles = new List<HarnessCollectible>();
        readonly List<HarnessHazard> hazards = new List<HarnessHazard>();
        HarnessExit exit;
        Vector3 spawn;
        int collected;
        int score;
        int hits;
        bool won;
        bool lost;
        bool exitOpen;

        public bool Won { get { return won; } }
        public int Collected { get { return collected; } }
        public int Total { get { return collectibles.Count; } }

        void Start()
        {
            collectibles.AddRange(FindObjectsByType<HarnessCollectible>(FindObjectsSortMode.InstanceID));
            hazards.AddRange(FindObjectsByType<HarnessHazard>(FindObjectsSortMode.None));
            exit = FindFirstObjectByType<HarnessExit>();
            if (player == null)
            {
                var c3 = FindFirstObjectByType<HarnessPlayerController>();
                var c2 = FindFirstObjectByType<HarnessPlayerController2D>();
                player = c3 != null ? c3.transform : c2 != null ? c2.transform : null;
            }
            if (player != null) spawn = player.position;
            exitOpen = !exitNeedsAll || collectibles.Count == 0;
            if (exit != null) exit.SetOpen(exitOpen);
            Publish();
            HarnessState.Emit("level-start", collectibles.Count + " to collect");
        }

        void Update()
        {
            if (player == null || won || lost) return;
            foreach (var c in collectibles)
            {
                if (c.Taken || !c.isActiveAndEnabled) continue;
                if (Near(c.transform.position, c.radius))
                {
                    c.Take();
                    collected++;
                    score += c.value;
                    HarnessState.Emit("pickup", c.name + " " + collected + "/" + collectibles.Count);
                    if (!exitOpen && collected >= collectibles.Count)
                    {
                        exitOpen = true;
                        if (exit != null) exit.SetOpen(true);
                        HarnessState.Emit("exit-open", null);
                    }
                }
            }
            foreach (var h in hazards)
            {
                if (h.isActiveAndEnabled && Near(h.transform.position, h.radius)) { hits++; HarnessState.Emit("hit", h.name); Respawn(); break; }
            }
            if (player.position.y < fallY) { hits++; HarnessState.Emit("fell", null); Respawn(); }
            if (exit != null && exitOpen && Near(exit.transform.position, exit.radius))
            {
                won = true;
                HarnessState.Emit("win", "escaped with " + collected + "/" + collectibles.Count);
            }
            if (timeLimit > 0f && Time.timeSinceLevelLoad > timeLimit && !won)
            {
                lost = true;
                HarnessState.Emit("lose", "time is up");
            }
            Publish();
        }

        bool Near(Vector3 p, float radius)
        {
            var d = player.position - p;
            // 2D levels compare on the XY plane; 3D on the ground plane with some height allowance.
            bool flat = player.GetComponent<Rigidbody2D>() != null;
            if (flat) d.z = 0f;
            else if (Mathf.Abs(d.y) < 1.5f) d.y = 0f;
            return d.sqrMagnitude <= radius * radius;
        }

        void Respawn()
        {
            var cc = player.GetComponent<CharacterController>();
            if (cc != null) cc.enabled = false;
            player.position = spawn;
            if (cc != null) cc.enabled = true;
            var rb2 = player.GetComponent<Rigidbody2D>();
#if UNITY_6000_0_OR_NEWER
            if (rb2 != null) rb2.linearVelocity = Vector2.zero;
#else
            if (rb2 != null) rb2.velocity = Vector2.zero;
#endif
        }

        void Publish()
        {
            HarnessState.Set("score", score);
            HarnessState.Set("collected", collected);
            HarnessState.Set("total", collectibles.Count);
            HarnessState.Set("exitOpen", exitOpen);
            HarnessState.Set("hits", hits);
            HarnessState.Set("won", won);
            HarnessState.Set("lost", lost);
            HarnessState.Set("done", won || lost);
            HarnessState.Set("time", System.Math.Round(Time.timeSinceLevelLoad, 2));
            if (player != null)
            {
                var p = player.position;
                HarnessState.Set("player", new List<object> { System.Math.Round(p.x, 2), System.Math.Round(p.y, 2), System.Math.Round(p.z, 2) });
            }
            if (exit != null)
            {
                var e = exit.transform.position;
                HarnessState.Set("exit", new List<object> { System.Math.Round(e.x, 2), System.Math.Round(e.y, 2), System.Math.Round(e.z, 2) });
            }
            var left = new List<object>();
            foreach (var c in collectibles)
            {
                if (c.Taken) continue;
                var q = c.transform.position;
                left.Add(new List<object> { System.Math.Round(q.x, 2), System.Math.Round(q.y, 2), System.Math.Round(q.z, 2) });
            }
            HarnessState.Set("collectibles", left);
        }

        void OnGUI()
        {
            if (!showHud) return;
            var style = new GUIStyle(GUI.skin.label) { fontSize = Mathf.Max(14, Screen.height / 28), fontStyle = FontStyle.Bold };
            style.normal.textColor = Color.white;
            GUI.Label(new Rect(16, 12, 600, 60), "Collected " + collected + " / " + collectibles.Count + (exitOpen && !won ? "   Exit open!" : ""), style);
            if (won || lost)
            {
                var big = new GUIStyle(style) { fontSize = Mathf.Max(24, Screen.height / 12), alignment = TextAnchor.MiddleCenter };
                big.normal.textColor = won ? new Color(1f, 0.9f, 0.3f) : new Color(1f, 0.4f, 0.4f);
                GUI.Label(new Rect(0, 0, Screen.width, Screen.height), won ? "You escaped!" : "Time is up", big);
            }
        }
    }
}
