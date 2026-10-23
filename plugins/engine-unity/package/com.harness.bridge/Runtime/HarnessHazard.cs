// A hazard for HarnessGameRules: touching it (within radius) sends the player back to the start.

using UnityEngine;

namespace Harness.Bridge
{
    public sealed class HarnessHazard : MonoBehaviour
    {
        public float radius = 0.6f;
    }
}
