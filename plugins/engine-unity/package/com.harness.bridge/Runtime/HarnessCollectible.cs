// A pickup for HarnessGameRules: it spins and bobs until the player comes within radius.

using UnityEngine;

namespace Harness.Bridge
{
    public sealed class HarnessCollectible : MonoBehaviour
    {
        public float radius = 0.7f;
        public int value = 1;
        public float spin = 90f;
        public bool bob = true;

        Vector3 home;
        public bool Taken { get; private set; }

        void Start() { home = transform.position; }

        void Update()
        {
            if (Taken) return;
            if (spin != 0f) transform.Rotate(0f, spin * Time.deltaTime, 0f, Space.World);
            if (bob) transform.position = home + Vector3.up * (Mathf.Sin(Time.time * 2.5f) * 0.1f);
        }

        public void Take()
        {
            Taken = true;
            gameObject.SetActive(false);
        }
    }
}
