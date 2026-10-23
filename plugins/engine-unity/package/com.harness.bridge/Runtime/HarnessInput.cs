// Input the harness can drive. Games read keys and axes through HarnessInput (or through
// the Input System, which gets the same keys on a virtual keyboard); the real keyboard and
// mouse keep working beside it. Playback timelines and the AI player's steps call SetKey
// and SetAxis; everything else only reads.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Harness.Bridge
{
    public static class HarnessInput
    {
        static readonly HashSet<KeyCode> held = new HashSet<KeyCode>();
        static readonly Dictionary<KeyCode, int> pressedAt = new Dictionary<KeyCode, int>();
        static readonly Dictionary<KeyCode, int> releasedAt = new Dictionary<KeyCode, int>();
        static readonly Dictionary<string, float> axes = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);

        /// <summary>Keys the harness holds down now.</summary>
        public static IEnumerable<KeyCode> Held { get { return held; } }

        public static bool TryKey(string name, out KeyCode key)
        {
            key = KeyCode.None;
            if (string.IsNullOrEmpty(name)) return false;
            if (name.Length == 1 && char.IsDigit(name[0])) name = "Alpha" + name;
            return Enum.TryParse(name, true, out key) && key != KeyCode.None;
        }

        /// <summary>Presses (down) or releases a key by its KeyCode name: "W", "Space", "LeftArrow".</summary>
        public static bool SetKey(string name, bool down)
        {
            KeyCode k;
            if (!TryKey(name, out k)) return false;
            if (down) { if (held.Add(k)) pressedAt[k] = Time.frameCount; }
            else if (held.Remove(k)) releasedAt[k] = Time.frameCount;
            PushInputSystem();
            return true;
        }

        /// <summary>Holds exactly these keys (the others the harness held are released).</summary>
        public static void Hold(IEnumerable<string> names)
        {
            var want = new HashSet<KeyCode>();
            foreach (var n in names) { KeyCode k; if (TryKey(n, out k)) want.Add(k); }
            foreach (var k in new List<KeyCode>(held)) if (!want.Contains(k)) { held.Remove(k); releasedAt[k] = Time.frameCount; }
            foreach (var k in want) if (held.Add(k)) pressedAt[k] = Time.frameCount;
            PushInputSystem();
        }

        public static void SetAxis(string axis, float value) { axes[axis] = Mathf.Clamp(value, -1f, 1f); }
        public static void ClearAxis(string axis) { axes.Remove(axis); }

        public static void Reset()
        {
            foreach (var k in held) releasedAt[k] = Time.frameCount;
            held.Clear();
            axes.Clear();
            PushInputSystem();
        }

        public static bool GetKey(KeyCode k) { return held.Contains(k) || RealKey(k); }

        public static bool GetKeyDown(KeyCode k)
        {
            int f;
            return (pressedAt.TryGetValue(k, out f) && f == Time.frameCount) || RealKeyDown(k);
        }

        public static bool GetKeyUp(KeyCode k)
        {
            int f;
            return (releasedAt.TryGetValue(k, out f) && f == Time.frameCount) || RealKeyUp(k);
        }

        /// <summary>Horizontal and Vertical from an injected axis, the held keys (WASD and arrows) and the real input.</summary>
        public static float GetAxis(string axis)
        {
            float v;
            if (axes.TryGetValue(axis, out v)) return v;
            float keys = 0f;
            if (string.Equals(axis, "Horizontal", StringComparison.OrdinalIgnoreCase))
                keys = (GetKey(KeyCode.D) || GetKey(KeyCode.RightArrow) ? 1f : 0f) - (GetKey(KeyCode.A) || GetKey(KeyCode.LeftArrow) ? 1f : 0f);
            else if (string.Equals(axis, "Vertical", StringComparison.OrdinalIgnoreCase))
                keys = (GetKey(KeyCode.W) || GetKey(KeyCode.UpArrow) ? 1f : 0f) - (GetKey(KeyCode.S) || GetKey(KeyCode.DownArrow) ? 1f : 0f);
            if (keys != 0f) return keys;
            return RealAxis(axis);
        }

        public static Vector2 Move() { return Vector2.ClampMagnitude(new Vector2(GetAxis("Horizontal"), GetAxis("Vertical")), 1f); }

        public static bool Jump() { return GetKeyDown(KeyCode.Space); }

        // ---------- the real devices ----------

        static bool RealKey(KeyCode k)
        {
#if ENABLE_LEGACY_INPUT_MANAGER
            try { return Input.GetKey(k); } catch (InvalidOperationException) { return false; }
#elif HARNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            var c = Control(k);
            return c != null && c.isPressed;
#else
            return false;
#endif
        }

        static bool RealKeyDown(KeyCode k)
        {
#if ENABLE_LEGACY_INPUT_MANAGER
            try { return Input.GetKeyDown(k); } catch (InvalidOperationException) { return false; }
#elif HARNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            var c = Control(k);
            return c != null && c.wasPressedThisFrame;
#else
            return false;
#endif
        }

        static bool RealKeyUp(KeyCode k)
        {
#if ENABLE_LEGACY_INPUT_MANAGER
            try { return Input.GetKeyUp(k); } catch (InvalidOperationException) { return false; }
#elif HARNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            var c = Control(k);
            return c != null && c.wasReleasedThisFrame;
#else
            return false;
#endif
        }

        static float RealAxis(string axis)
        {
#if ENABLE_LEGACY_INPUT_MANAGER
            try { return Input.GetAxisRaw(axis); } catch (ArgumentException) { return 0f; } catch (InvalidOperationException) { return 0f; }
#else
            return 0f;
#endif
        }

#if HARNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        static UnityEngine.InputSystem.Keyboard virtualKeyboard;

        /// <summary>The Input System name of a KeyCode (Alpha1 is Digit1, Return is Enter).</summary>
        public static bool ToInputSystemKey(KeyCode k, out UnityEngine.InputSystem.Key key)
        {
            var n = k.ToString();
            if (n.StartsWith("Alpha")) n = "Digit" + n.Substring(5);
            else if (n.StartsWith("Keypad") && n.Length == 7 && char.IsDigit(n[6])) n = "Numpad" + n.Substring(6);
            else if (k == KeyCode.Return) n = "Enter";
            else if (k == KeyCode.LeftControl) n = "LeftCtrl";
            else if (k == KeyCode.RightControl) n = "RightCtrl";
            return Enum.TryParse(n, true, out key) && key != UnityEngine.InputSystem.Key.None;
        }

        static UnityEngine.InputSystem.Controls.ButtonControl Control(KeyCode k)
        {
            if (k == KeyCode.Mouse0 || k == KeyCode.Mouse1 || k == KeyCode.Mouse2)
            {
                var m = UnityEngine.InputSystem.Mouse.current;
                if (m == null) return null;
                return k == KeyCode.Mouse0 ? m.leftButton : k == KeyCode.Mouse1 ? m.rightButton : m.middleButton;
            }
            var kb = UnityEngine.InputSystem.Keyboard.current;
            UnityEngine.InputSystem.Key key;
            if (kb == null || !ToInputSystemKey(k, out key)) return null;
            return kb[key];
        }

        static void PushInputSystem()
        {
            if (!Application.isPlaying) return;
            if (virtualKeyboard == null || !virtualKeyboard.added) virtualKeyboard = UnityEngine.InputSystem.InputSystem.AddDevice<UnityEngine.InputSystem.Keyboard>("HarnessKeyboard");
            var keys = new List<UnityEngine.InputSystem.Key>();
            foreach (var k in held) { UnityEngine.InputSystem.Key key; if (ToInputSystemKey(k, out key)) keys.Add(key); }
            UnityEngine.InputSystem.InputSystem.QueueStateEvent(virtualKeyboard, new UnityEngine.InputSystem.LowLevel.KeyboardState(keys.ToArray()));
        }
#else
        static void PushInputSystem() { }
#endif
    }
}
