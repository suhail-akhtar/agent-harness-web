# Harness Bridge for Blender (engine-blender): the harness's agents work in the Blender the
# person has open. A socket server on 127.0.0.1 only, on the first free port from 47620,
# with a random token; the port and token go to the connection file named in config.json
# (written by the blender tool's bridge.install), removed when the add-on stops.
# One JSON object per line each way:
#   {"id": 1, "token": "...", "cmd": "scene", "params": {}}  ->  {"id": 1, "ok": true, "result": {...}}
# Commands: ping, scene, exec (Python; `result` is sent back), operator (bpy.ops by name),
# capture (the viewport, or a quick Workbench render in background mode), save, quit
# (background mode only). Requests run on Blender's main thread (a timer), one at a time.

bl_info = {
    "name": "Harness Bridge",
    "author": "engine-blender",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "Runs in the background while enabled",
    "description": "Lets the harness's agents work in this Blender: the scene, Python, operators, viewport captures (127.0.0.1 only, with a token)",
    "category": "System",
}

import base64
import io
import json
import os
import queue
import secrets
import socket
import tempfile
import threading
import traceback
from contextlib import redirect_stdout

import bpy

from . import harness_blender as hb

FIRST_PORT = 47620
HERE = os.path.dirname(os.path.abspath(__file__))

_state = {"server": None, "thread": None, "token": "", "port": 0, "info": "", "stop": False}
_requests = queue.Queue()


def _config():
    try:
        with open(os.path.join(HERE, "config.json"), encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _listen():
    for port in range(FIRST_PORT, FIRST_PORT + 40):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", port))
            s.listen(4)
            return s, port
        except OSError:
            s.close()
    raise RuntimeError(f"Harness Bridge: no free port from {FIRST_PORT}")


def _write_info(info_path):
    if not info_path:
        return
    os.makedirs(os.path.dirname(info_path), exist_ok=True)
    with open(info_path, "w", encoding="utf8") as f:
        json.dump({"port": _state["port"], "token": _state["token"], "pid": os.getpid(), "blender": bpy.app.version_string, "file": bpy.data.filepath, "background": bpy.app.background}, f)


def _capture(params):
    if not bpy.app.background:
        # The viewport as the person sees it: an OpenGL render of the first 3D view.
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type == "VIEW_3D":
                    path = os.path.join(tempfile.gettempdir(), f"harness-viewport-{os.getpid()}.png")
                    scene = bpy.context.scene
                    old = scene.render.filepath
                    scene.render.filepath = path
                    region = next(r for r in area.regions if r.type == "WINDOW")
                    with bpy.context.temp_override(window=window, area=area, region=region):
                        bpy.ops.render.opengl(write_still=True, view_context=True)
                    scene.render.filepath = old
                    with open(path, "rb") as f:
                        data = f.read()
                    os.remove(path)
                    return {"png": base64.b64encode(data).decode("ascii"), "source": "viewport"}
    path = os.path.join(tempfile.gettempdir(), f"harness-capture-{os.getpid()}.png")
    hb.capture({"output": path, "view": params.get("view", "three-quarter"), "size": params.get("size") or [640, 480], "engine": "workbench"})
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return {"png": base64.b64encode(data).decode("ascii"), "source": "render"}


def handle(cmd, params):
    """One command, on the main thread."""
    if cmd == "ping":
        return {"blender": bpy.app.version_string, "file": bpy.data.filepath, "scene": bpy.context.scene.name, "objects": len(bpy.context.scene.objects), "background": bpy.app.background}
    if cmd == "scene":
        return hb.describe()
    if cmd == "exec":
        code = str(params.get("code", ""))
        env = {"bpy": bpy, "hb": hb, "result": None}
        buf = io.StringIO()
        with redirect_stdout(buf):
            exec(compile(code, "<harness>", "exec"), env)
        r = env.get("result")
        try:
            json.dumps(r)
        except TypeError:
            r = repr(r)
        return {"result": r, "stdout": buf.getvalue()[-20000:]}
    if cmd == "operator":
        op = str(params.get("op", ""))
        group, _, name = op.partition(".")
        fn = getattr(getattr(bpy.ops, group, None), name, None) if group and name else None
        if fn is None:
            raise ValueError(f"no operator bpy.ops.{op}")
        out = fn(**(params.get("kwargs") or {}))
        return {"result": sorted(out)}
    if cmd == "capture":
        return _capture(params)
    if cmd == "save":
        path = params.get("path")
        if path:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(path))
        elif bpy.data.filepath:
            bpy.ops.wm.save_mainfile()
        else:
            raise ValueError("the file was never saved: give a path")
        return {"file": bpy.data.filepath}
    if cmd == "quit":
        if not bpy.app.background:
            raise ValueError("quit only stops a background bridge; close Blender yourself")
        _state["stop"] = True
        return {"stopping": True}
    raise ValueError(f"unknown command {cmd} (ping, scene, exec, operator, capture, save, quit)")


def _answer(req):
    msg, reply = req
    try:
        reply({"id": msg.get("id"), "ok": True, "result": handle(str(msg.get("cmd", "ping")), msg.get("params") or {})})
    except Exception as e:  # the agent sees what went wrong
        reply({"id": msg.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-4000:]})


def _client(conn):
    """Reads requests from one connection (a thread); the main thread answers them."""
    conn.settimeout(600)
    f = conn.makefile("rwb")
    authed = False
    lock = threading.Lock()

    def reply(obj):
        with lock:
            try:
                f.write((json.dumps(obj) + "\n").encode("utf8"))
                f.flush()
            except OSError:
                pass

    try:
        for line in f:
            try:
                msg = json.loads(line.decode("utf8"))
            except ValueError:
                reply({"ok": False, "error": "not JSON"})
                continue
            if not authed:
                if not secrets.compare_digest(str(msg.get("token", "")), _state["token"]):
                    reply({"id": msg.get("id"), "ok": False, "error": "bad token"})
                    break
                authed = True
            done = threading.Event()

            def finish(obj, done=done):
                reply(obj)
                done.set()

            _requests.put((msg, finish))
            done.wait()
    except OSError:
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _accept_loop(server):
    while not _state["stop"]:
        try:
            conn, _ = server.accept()
        except OSError:
            break
        threading.Thread(target=_client, args=(conn,), daemon=True).start()


def _tick():
    """The timer on Blender's main thread: answers what came in."""
    while True:
        try:
            req = _requests.get_nowait()
        except queue.Empty:
            break
        _answer(req)
    return None if _state["stop"] else 0.05


def start(info_path=None):
    if _state["server"]:
        return _state["port"]
    server, port = _listen()
    _state.update(server=server, port=port, token=secrets.token_hex(24), stop=False, info=info_path or _config().get("info", ""))
    _write_info(_state["info"])
    _state["thread"] = threading.Thread(target=_accept_loop, args=(server,), daemon=True)
    _state["thread"].start()
    print(f"Harness Bridge: listening on 127.0.0.1:{port}")
    return port


def stop():
    _state["stop"] = True
    if _state["server"]:
        try:
            _state["server"].close()
        except OSError:
            pass
    _state["server"] = None
    if _state["info"] and os.path.exists(_state["info"]):
        try:
            os.remove(_state["info"])
        except OSError:
            pass


def serve_forever(info_path=None):
    """Background mode (blender -b): no timers run, so the main thread answers requests here until quit."""
    start(info_path)
    try:
        while not _state["stop"]:
            try:
                req = _requests.get(timeout=0.2)
            except queue.Empty:
                continue
            _answer(req)
    finally:
        stop()


def register():
    if bpy.app.background:
        return
    start()
    bpy.app.timers.register(_tick, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    stop()
