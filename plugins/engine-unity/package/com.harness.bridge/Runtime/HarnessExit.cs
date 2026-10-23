// The exit for HarnessGameRules: closed (red) until every collectible is taken, then open (green).

using UnityEngine;

namespace Harness.Bridge
{
    public sealed class HarnessExit : MonoBehaviour
    {
        public float radius = 0.9f;
        public Color closedColor = new Color(0.8f, 0.2f, 0.2f);
        public Color openColor = new Color(0.2f, 0.85f, 0.35f);
        public bool Open { get; private set; }

        public void SetOpen(bool open)
        {
            Open = open;
            var c = open ? openColor : closedColor;
            var r = GetComponent<Renderer>();
            if (r != null && r.material != null) r.material.color = c;
            var s = GetComponent<SpriteRenderer>();
            if (s != null) s.color = c;
        }
    }
}
