"""A frame of the game as the player sees it, inside an editor -game session (the harness's
capture with view "game"). Started with -ExecCmds="py <this file> --out <png> [--at x,y,z
--rot pitch,yaw,roll | --target x,y,z] [--fov 70] [--frames 90] [--width 1280 --height 720]".
With a position it views the level from a camera put there; without one it shows the player's
own view. It waits some frames, takes a HighResShot, moves it to --out and quits the game."""

import os
import shutil
import sys
import time
import traceback

import unreal


def _arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def _nums(s):
    """Numbers joined with ':' (the console's ExecCmds splits commands at commas)."""
    return [float(v) for v in s.replace(",", ":").split(":")]


def _vec(s):
    x, y, z = _nums(s)
    return unreal.Vector(x, y, z)


OUT = _arg("--out")
AT = _arg("--at")
ROT = _arg("--rot")
TARGET = _arg("--target")
FOV = float(_arg("--fov", "70"))
FRAMES = int(_arg("--frames", "90"))
W = int(_arg("--width", "1280"))
H = int(_arg("--height", "720"))

S = {"n": 0, "cam": None, "phase": "wait", "t0": time.time(), "before": 0, "size": -1}


def live(cls):
    for o in unreal.ObjectIterator(cls):
        try:
            if not o.get_name().startswith("Default__") and o.get_world() is not None:
                return o
        except Exception:
            pass
    return None


def newest():
    best = None
    for d, _, files in os.walk(unreal.Paths.screen_shot_dir()):
        for f in files:
            if f.lower().endswith(".png"):
                p = os.path.join(d, f)
                t = os.path.getmtime(p)
                if best is None or t > best[0]:
                    best = (t, p)
    return best


def quit_game():
    pc = live(unreal.PlayerController)
    unreal.SystemLibrary.execute_console_command(pc.get_world() if pc else None, "quit", None)


def tick(dt):
    # An error ends the run (a tick that fails would fail every frame).
    try:
        step(dt)
    except Exception as e:
        unreal.log_error(traceback.format_exc())
        unreal.log_error("HARNESS_PROBLEM %s: %s" % (type(e).__name__, e))
        unreal.unregister_slate_post_tick_callback(HANDLE)
        quit_game()


def step(dt):
    S["n"] += 1
    pc = live(unreal.PlayerController)
    if pc is None:
        if time.time() - S["t0"] > 120:
            unreal.log_error("HARNESS_PROBLEM no player controller after 120 s")
            quit_game()
        return
    world = pc.get_world()
    if S["cam"] is None and AT:
        loc = _vec(AT)
        if ROT:
            p, y, r = _nums(ROT)
            rot = unreal.Rotator(roll=r, pitch=p, yaw=y)
        else:
            rot = unreal.MathLibrary.find_look_at_rotation(loc, _vec(TARGET) if TARGET else unreal.Vector(0, 0, 0))
        # Python cannot spawn in a running game: the level's HarnessCamera (put there with the
        # play driver), else any camera in it, is moved to the spot.
        cams = [c for c in unreal.ObjectIterator(unreal.CameraActor) if not c.get_name().startswith("Default__") and c.get_world() == world]
        cam = next((c for c in cams if "HarnessCamera" in (c.get_actor_label() if hasattr(c, "get_actor_label") else c.get_name())), cams[0] if cams else None)
        if cam is None:
            unreal.log_error("HARNESS_PROBLEM the level has no camera to look from: add the play driver (unreal play or package adds it)")
            S["phase"] = "done"
            quit_game()
            return
        cam.set_actor_location_and_rotation(loc, rot, False, False)
        cam.camera_component.set_editor_property("field_of_view", FOV)
        cam.camera_component.set_editor_property("constrain_aspect_ratio", False)
        S["cam"] = cam
    if S["cam"] is not None:
        pc.set_view_target_with_blend(S["cam"], 0.0)
    if S["phase"] == "wait" and S["n"] >= FRAMES:
        b = newest()
        S["before"] = b[0] if b else 0
        unreal.SystemLibrary.execute_console_command(world, "HighResShot %dx%d" % (W, H), pc)
        S["phase"] = "shot"
        S["shot_t0"] = time.time()
    elif S["phase"] == "shot":
        n = newest()
        if n and n[0] > S["before"]:
            size = os.path.getsize(n[1])
            if size > 0 and size == S["size"]:
                os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
                shutil.move(n[1], OUT)
                print("HARNESS_EVENT captured %s" % OUT)
                S["phase"] = "done"
                quit_game()
            S["size"] = size
        elif time.time() - S["shot_t0"] > 30:
            unreal.log_error("HARNESS_PROBLEM the screenshot was not written within 30 s")
            S["phase"] = "done"
            quit_game()


HANDLE = unreal.register_slate_post_tick_callback(tick)
