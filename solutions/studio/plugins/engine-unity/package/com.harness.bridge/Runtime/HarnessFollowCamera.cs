// A camera that follows the player at a fixed offset and angle: behind and above for 3D,
// a fixed isometric angle for 2.5D, straight on (XY) for 2D.

using UnityEngine;

namespace Harness.Bridge
{
    public sealed class HarnessFollowCamera : MonoBehaviour
    {
        public Transform target;
        public Vector3 offset = new Vector3(0f, 8f, -8f);
        public float smooth = 8f;
        public bool lookAtTarget = true;

        void LateUpdate()
        {
            if (target == null) return;
            var want = target.position + offset;
            transform.position = Time.deltaTime > 0f ? Vector3.Lerp(transform.position, want, 1f - Mathf.Exp(-smooth * Time.deltaTime)) : transform.position;
            if (lookAtTarget) transform.LookAt(target.position);
        }

        /// <summary>Jumps straight to the target (on level load and in captures).</summary>
        public void Snap()
        {
            if (target == null) return;
            transform.position = target.position + offset;
            if (lookAtTarget) transform.LookAt(target.position);
        }

        void Start() { Snap(); }
    }
}
