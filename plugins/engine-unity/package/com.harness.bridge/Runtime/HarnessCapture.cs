// Frames as PNG: a camera drawn into a RenderTexture (works headless, in edit mode and in
// batch mode; URP through a render request), or the screen at the end of a frame (what a
// player sees, with overlay UI) in a player or the editor's Game view.

using System;
using System.Collections;
using UnityEngine;
using UnityEngine.Rendering;

namespace Harness.Bridge
{
    public static class HarnessCapture
    {
        /// <summary>The camera to draw: by name, else the main camera, else the first enabled one.</summary>
        public static Camera FindCamera(string name)
        {
            if (!string.IsNullOrEmpty(name))
            {
                foreach (var c in UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                    if (c.name == name) return c;
            }
            if (Camera.main != null) return Camera.main;
            foreach (var c in UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsSortMode.None)) if (c.enabled) return c;
            return null;
        }

        /// <summary>Draws a camera into a width x height texture and encodes it as PNG.</summary>
        public static byte[] RenderCamera(Camera cam, int width, int height)
        {
            if (cam == null) throw new InvalidOperationException("no camera to draw from: add one to the scene, or pass a camera position");
            width = Mathf.Clamp(width, 16, 7680);
            height = Mathf.Clamp(height, 16, 4320);
            var rt = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
            var previousTarget = cam.targetTexture;
            var previousActive = RenderTexture.active;
            var previousAspect = cam.aspect;
            try
            {
                cam.aspect = (float)width / height;
                bool drawn = false;
#if UNITY_6000_0_OR_NEWER
                if (GraphicsSettings.currentRenderPipeline != null)
                {
                    var request = new RenderPipeline.StandardRequest();
                    if (RenderPipeline.SupportsRenderRequest(cam, request))
                    {
                        request.destination = rt;
                        RenderPipeline.SubmitRenderRequest(cam, request);
                        drawn = true;
                    }
                }
#endif
                if (!drawn)
                {
                    cam.targetTexture = rt;
                    cam.Render();
                }
                return ReadBack(rt, width, height);
            }
            finally
            {
                cam.targetTexture = previousTarget;
                cam.aspect = previousAspect;
                RenderTexture.active = previousActive;
                RenderTexture.ReleaseTemporary(rt);
            }
        }

        static byte[] ReadBack(RenderTexture rt, int width, int height)
        {
            RenderTexture.active = rt;
            var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
            try
            {
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
                return tex.EncodeToPNG();
            }
            finally { UnityEngine.Object.DestroyImmediate(tex); }
        }

        /// <summary>The screen after this frame is drawn, scaled to width x height (0: as it is). Run as a coroutine.</summary>
        public static IEnumerator CaptureScreen(int width, int height, Action<byte[]> done)
        {
            yield return new WaitForEndOfFrame();
            Texture2D shot = null;
            try
            {
                shot = ScreenCapture.CaptureScreenshotAsTexture();
                if (width <= 0 || height <= 0 || (shot.width == width && shot.height == height)) { done(shot.EncodeToPNG()); yield break; }
                var rt = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
                var previous = RenderTexture.active;
                try
                {
                    Graphics.Blit(shot, rt);
                    done(ReadBack(rt, width, height));
                }
                finally
                {
                    RenderTexture.active = previous;
                    RenderTexture.ReleaseTemporary(rt);
                }
            }
            finally { if (shot != null) UnityEngine.Object.Destroy(shot); }
        }

        /// <summary>Whether frames come from cameras (batch mode has no screen) or from the screen.</summary>
        public static bool UseCameras { get { return Application.isBatchMode || SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null; } }
    }
}
