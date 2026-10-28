"""The step server inside an editor -game session (the harness's play.start / play.step).

Started with -ExecCmds="py <this file> --port N --shots <folder>". It listens on 127.0.0.1:N for
JSON lines and answers each with one JSON line. The game stays paused between steps, so an AI
player can look at a frame, think, and send the next inputs without the world moving on.

  {"op": "state"}                                   -> pawn, score variables, coins left, frame
  {"op": "step", "ms": 500, "keys": ["W"], "actions": [{"name": "IA_Jump", "value": "true"}],
   "look": [yaw, pitch], "capture": true}            -> plays ms of game time with those held, pauses,
                                                       captures a frame; answers state + frame path
  {"op": "console", "command": "stat fps"}          -> runs a console command
  {"op": "eval", "code": "..."}                     -> runs Python; 'result' is the value of `result`
  {"op": "quit"}
"""

import json
import os
import socket
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


PORT = int(_arg("--port", "30150"))
SHOTS = _arg("--shots")
WIDTH = int(_arg("--width", "1280"))
HEIGHT = int(_arg("--height", "720"))
WATCH = [c for c in (_arg("--watch", "") or "").split("+") if c]

S = {"frame": 0, "game_ms": 0.0, "clients": [], "buf": {}, "job": None, "pc": None, "shot": 0, "wall0": time.time()}

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", PORT))
server.listen(2)
server.setblocking(False)


def live(cls):
    for o in unreal.ObjectIterator(cls):
        try:
            if not o.get_name().startswith("Default__") and o.get_world() is not None:
                return o
        except Exception:
            pass
    return None


def pc():
    p = S["pc"]
    try:
        if p is not None and p.get_world() is not None:
            return p
    except Exception:
        pass
    S["pc"] = live(unreal.PlayerController)
    return S["pc"]


def plain(v):
    if isinstance(v, unreal.Vector):
        return [round(v.x, 1), round(v.y, 1), round(v.z, 1)]
    if isinstance(v, unreal.Rotator):
        return [round(v.pitch, 1), round(v.yaw, 1), round(v.roll, 1)]
    if isinstance(v, (bool, int, float, str)) or v is None:
        return v
    if isinstance(v, unreal.Object):
        return v.get_path_name()
    return str(v)


def state():
    p = pc()
    out = {"frame": S["frame"], "gameMs": round(S["game_ms"]), "wallS": round(time.time() - S["wall0"], 2)}
    if p is None:
        out["ready"] = False
        return out
    out["ready"] = True
    world = p.get_world()
    out["paused"] = unreal.GameplayStatics.is_game_paused(world)
    pawn = p.get_controlled_pawn()
    if pawn is not None:
        out["pawn"] = {
            "class": pawn.get_class().get_name(),
            "location": plain(pawn.get_actor_location()),
            "rotation": plain(pawn.get_actor_rotation()),
            "velocity": plain(pawn.get_velocity()),
        }
        try:
            out["pawn"]["falling"] = pawn.character_movement.is_falling()
        except Exception:
            pass
    out["view"] = plain(p.get_control_rotation())
    gm = unreal.GameplayStatics.get_game_mode(world)
    if gm is not None:
        out["gameMode"] = gm.get_class().get_name()
        vars_ = {}
        for name in ("Score", "Total", "Won", "Lives", "Health"):
            try:
                vars_[name] = plain(gm.get_editor_property(name))
            except Exception:
                pass
        out["vars"] = vars_
    counts = {}
    for cls_path in WATCH:
        try:
            cls = unreal.load_class(None, cls_path)
            name = cls_path.rsplit(".", 1)[-1]
            counts[name[:-2] if name.endswith("_C") else name] = len(unreal.GameplayStatics.get_all_actors_of_class(world, cls))
        except Exception:
            pass
    if counts:
        out["counts"] = counts
    return out


def console(cmd):
    p = pc()
    unreal.SystemLibrary.execute_console_command(p.get_world() if p else None, cmd, p)


def set_paused(paused):
    p = pc()
    if p is not None:
        unreal.GameplayStatics.set_game_paused(p.get_world(), paused)


def newest_shot():
    root = unreal.Paths.screen_shot_dir()
    best = None
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.lower().endswith(".png"):
                full = os.path.join(dirpath, f)
                t = os.path.getmtime(full)
                if best is None or t > best[0]:
                    best = (t, full)
    return best


def start_step(client, req):
    keys = [str(k) for k in req.get("keys", [])]
    actions = req.get("actions", [])
    for k in keys:
        console("Input.+key %s %s" % (k, "1.0"))
    for a in actions:
        console("Input.+action %s %s" % (a["name"], a.get("value", "true")))
    # look: degrees added to the view (yaw, pitch), set directly rather than through the
    # project's input scale.
    look = req.get("look")
    p = pc()
    if look and p is not None:
        r = p.get_control_rotation()
        pitch = r.pitch + (float(look[1]) if len(look) > 1 else 0.0)
        p.set_control_rotation(unreal.Rotator(roll=r.roll, pitch=pitch, yaw=r.yaw + float(look[0])))
    set_paused(False)
    S["job"] = {"client": client, "req": req, "until": S["game_ms"] + float(req.get("ms", 250)), "keys": keys, "actions": actions, "phase": "run", "t0": time.time()}


def finish_inputs(job):
    for k in job["keys"]:
        console("Input.-key %s" % k)
    for a in job["actions"]:
        console("Input.-action %s" % a["name"])


def send(client, obj):
    try:
        client.sendall((json.dumps(obj) + "\n").encode("utf-8"))
    except Exception:
        pass


def handle(client, req):
    op = req.get("op")
    try:
        if op == "state":
            send(client, {"ok": True, "state": state()})
        elif op == "step":
            if S["job"] is not None:
                send(client, {"ok": False, "error": "a step is still running"})
            else:
                start_step(client, req)
        elif op == "console":
            console(req["command"])
            send(client, {"ok": True})
        elif op == "eval":
            scope = {"unreal": unreal, "pc": pc(), "state": state}
            exec(req["code"], scope)
            send(client, {"ok": True, "result": plain(scope.get("result"))})
        elif op == "quit":
            send(client, {"ok": True})
            console("quit")
        else:
            send(client, {"ok": False, "error": "unknown op %s" % op})
    except Exception as e:
        send(client, {"ok": False, "error": "%s: %s" % (type(e).__name__, e), "trace": traceback.format_exc()[-1500:]})


def tick(dt):
    # A failing tick would fail every frame: report it once to the waiting client and go on.
    try:
        serve(dt)
    except Exception as e:
        S["errors"] = S.get("errors", 0) + 1
        job = S.get("job")
        if job is not None:
            S["job"] = None
            send(job["client"], {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        if S["errors"] <= 3:
            unreal.log_error(traceback.format_exc())


def serve(dt):
    S["frame"] += 1
    p = pc()
    paused = p is not None and unreal.GameplayStatics.is_game_paused(p.get_world())
    if not paused:
        S["game_ms"] += dt * 1000.0
    # Hold the game still until the first request (and between steps).
    if S["frame"] == 2 and p is not None:
        set_paused(True)
    try:
        c, _ = server.accept()
        c.setblocking(False)
        S["clients"].append(c)
        S["buf"][c] = b""
    except BlockingIOError:
        pass
    except Exception:
        pass
    for c in list(S["clients"]):
        try:
            data = c.recv(65536)
            if not data:
                S["clients"].remove(c)
                continue
            S["buf"][c] += data
        except BlockingIOError:
            pass
        except Exception:
            S["clients"].remove(c)
            continue
        while b"\n" in S["buf"].get(c, b""):
            line, S["buf"][c] = S["buf"][c].split(b"\n", 1)
            if line.strip():
                try:
                    handle(c, json.loads(line.decode("utf-8")))
                except Exception as e:
                    send(c, {"ok": False, "error": str(e)})
    job = S["job"]
    if job is None:
        return
    if job["phase"] == "run" and S["game_ms"] >= job["until"]:
        finish_inputs(job)
        set_paused(True)
        if job["req"].get("capture", True):
            before = newest_shot()
            job["before"] = before[0] if before else 0
            console("HighResShot %dx%d" % (int(job["req"].get("width", WIDTH)), int(job["req"].get("height", HEIGHT))))
            job["phase"] = "shot"
            job["shot_t0"] = time.time()
        else:
            job["phase"] = "done"
    if job["phase"] == "shot":
        n = newest_shot()
        if n and n[0] > job["before"]:
            # Written in the background: done once its size holds for a frame.
            size = os.path.getsize(n[1])
            if size > 0 and job.get("last_size") == size:
                job["frame_file"] = n[1]
                job["phase"] = "done"
            job["last_size"] = size
        elif time.time() - job["shot_t0"] > 15:
            job["phase"] = "done"
            job["shot_error"] = "no screenshot within 15 s"
    if job["phase"] == "done":
        S["job"] = None
        out = {"ok": True, "state": state(), "wallMs": round((time.time() - job["t0"]) * 1000)}
        if job.get("frame_file"):
            out["frame"] = job["frame_file"]
        if job.get("shot_error"):
            out["frameError"] = job["shot_error"]
        send(job["client"], out)


unreal.register_slate_post_tick_callback(tick)
print("HARNESS_EVENT step-server listening %d" % PORT)
