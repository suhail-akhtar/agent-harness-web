// A 2D player on a Rigidbody2D: a platformer (left and right, Space jumps, gravity) or
// top-down (all four directions, no gravity). Input comes through HarnessInput.

using UnityEngine;

namespace Harness.Bridge
{
    [RequireComponent(typeof(Rigidbody2D))]
    public sealed class HarnessPlayerController2D : MonoBehaviour
    {
        public bool topDown = false;
        public float speed = 6f;
        public float jumpSpeed = 11f;

        Rigidbody2D body;
        readonly ContactPoint2D[] contacts = new ContactPoint2D[8];
        bool jumpQueued;

        void Awake()
        {
            body = GetComponent<Rigidbody2D>();
            body.freezeRotation = true;
            if (topDown) body.gravityScale = 0f;
        }

        void Update()
        {
            if (!topDown && HarnessInput.Jump()) jumpQueued = true;
        }

        void FixedUpdate()
        {
            var input = HarnessInput.Move();
#if UNITY_6000_0_OR_NEWER
            var v = body.linearVelocity;
#else
            var v = body.velocity;
#endif
            if (topDown) v = input * speed;
            else
            {
                v.x = input.x * speed;
                if (jumpQueued && Grounded()) { v.y = jumpSpeed; HarnessState.Emit("jump", null); }
                jumpQueued = false;
            }
#if UNITY_6000_0_OR_NEWER
            body.linearVelocity = v;
#else
            body.velocity = v;
#endif
        }

        bool Grounded()
        {
            int n = body.GetContacts(contacts);
            for (int i = 0; i < n; i++) if (contacts[i].normal.y > 0.5f) return true;
            return false;
        }
    }
}
