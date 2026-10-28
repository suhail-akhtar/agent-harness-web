// A third-person (and 2.5D) player on a CharacterController: WASD or the arrows move it
// (relative to the camera's facing, so isometric views steer as they look), Space jumps.
// Input comes through HarnessInput, so playback timelines and the AI player drive it too.

using UnityEngine;

namespace Harness.Bridge
{
    [RequireComponent(typeof(CharacterController))]
    public sealed class HarnessPlayerController : MonoBehaviour
    {
        public float speed = 5f;
        public float jumpSpeed = 6f;
        public float gravity = -20f;
        public bool cameraRelative = true;
        public bool canJump = true;

        CharacterController controller;
        float vertical;

        void Awake() { controller = GetComponent<CharacterController>(); }

        void Update()
        {
            var input = HarnessInput.Move();
            var move = new Vector3(input.x, 0f, input.y);
            var cam = Camera.main;
            if (cameraRelative && cam != null)
            {
                var forward = Vector3.ProjectOnPlane(cam.transform.forward, Vector3.up);
                if (forward.sqrMagnitude < 0.01f) forward = Vector3.ProjectOnPlane(cam.transform.up, Vector3.up);
                forward.Normalize();
                var right = Vector3.Cross(Vector3.up, forward);
                move = right * input.x + forward * input.y;
            }
            if (move.sqrMagnitude > 0.001f) transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(move), 12f * Time.deltaTime);

            if (controller.isGrounded)
            {
                vertical = -1f;
                if (canJump && HarnessInput.Jump()) { vertical = jumpSpeed; HarnessState.Emit("jump", null); }
            }
            else vertical += gravity * Time.deltaTime;

            controller.Move((move * speed + Vector3.up * vertical) * Time.deltaTime);
        }
    }
}
