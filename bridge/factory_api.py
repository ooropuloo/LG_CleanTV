"""Scene factory glue for the bridge (the factory itself runs on the host, see ../factory/README.md).

- gen_scenes(root): scenes published by the factory (cats/gen-live/scenes.json), merged into /api/config on every
  request, so a new scene shows up on the next page load without restarting this container.
- GET  /api/scenes/factory      status + latest scene + recent runs (state files are mounted read-only)
- POST /api/scenes/factory/run  "generate one now": writes a request file into the inbox (the ONLY writable mount);
  a host-side cron job (factory/run.sh watch) picks it up. Allow-listed IPs only, rate-limited.
The bridge never gets the Docker socket and never runs the factory itself.
"""
import json
import os
import time
import datetime as dt

from aiohttp import web

STATE = os.environ.get("FACTORY_STATE", "/app/factory/state")
INBOX = os.environ.get("FACTORY_INBOX", "/app/factory/inbox")
MAX_PER_DAY = int(os.environ.get("FACTORY_MAX_PER_DAY", "3"))


def _jload(p, default):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


_cache = {"mtime": None, "scenes": []}


def gen_scenes(root):
    p = os.path.join(root, "cats", "gen-live", "scenes.json")
    try:
        mt = os.path.getmtime(p)
    except OSError:
        return []
    if mt != _cache["mtime"]:
        d = _jload(p, {})
        out = []
        for s in d.get("scenes") or []:
            if isinstance(s, dict) and s.get("coat") and str(s.get("coat")).replace("-", "").isalnum():
                out.append({k: s.get(k) for k in ("id", "name", "style", "coat", "gen", "tod", "pose", "created")})
        _cache.update(mtime=mt, scenes=out)
    return list(_cache["scenes"])


def _pending():
    try:
        return sorted(f for f in os.listdir(INBOX) if f.startswith("request-") and f.endswith(".json"))
    except OSError:
        return []


def _recent_requests(hist):
    """Manual runs started in the last 24 h + requests still waiting."""
    cut = time.time() - 86400
    n = 0
    for h in hist[-50:]:
        if h.get("trigger") != "manual":
            continue
        try:
            if dt.datetime.fromisoformat(h["started"]).timestamp() >= cut:
                n += 1
        except (KeyError, ValueError):
            pass
    return n + len(_pending())


def status_payload():
    st = _jload(os.path.join(STATE, "status.json"), {})
    hist = _jload(os.path.join(STATE, "history.json"), [])
    runs = [{k: h.get(k) for k in ("run", "trigger", "started", "finished", "seconds", "result", "name", "scene")}
            | {"recipe": (h.get("recipe") or {}).get("name"), "attempts": len(h.get("attempts") or []),
               "reason": ((h.get("attempts") or [{}])[-1] or {}).get("reason") if h.get("result") != "published" else None}
            for h in hist[-8:]][::-1]
    used = _recent_requests(hist)
    if st.get("state") == "running":                  # killed without cleanup (run.sh normally fixes this): stale after 55 min
        try:
            if time.time() - dt.datetime.fromisoformat(st.get("updated", "")).timestamp() > 3300:
                st["state"] = "idle"
        except ValueError:
            pass
    return {
        "available": bool(st) or os.path.isdir(INBOX),
        "state": st.get("state", "idle"), "step": st.get("step"), "run": st.get("run"), "started": st.get("started"),
        "latest": st.get("latest"), "last_result": st.get("result"), "last_finished": st.get("last_finished"),
        "last_reason": st.get("last_reason"), "quota_reset": st.get("quota_reset"), "disk": st.get("disk"),
        "pending": len(_pending()), "requests_left": max(0, MAX_PER_DAY - used), "max_per_day": MAX_PER_DAY,
        "runs": runs,
    }


async def handle_status(request):
    return web.json_response(status_payload(), headers={"Cache-Control": "no-store"},
                             dumps=lambda o: json.dumps(o, ensure_ascii=False))


def make_run_handler(bridge):
    async def handle_run(request):
        if not bridge.allowed(request):
            return web.json_response({"ok": False, "error": "not allowed"}, status=403)
        p = status_payload()
        if p["pending"]:
            return web.json_response({"ok": True, "queued": False, "reason": "already requested", **p})
        if p["state"] == "running":
            return web.json_response({"ok": True, "queued": False, "reason": "running", **p})
        try:
            if p.get("quota_reset") and dt.datetime.fromisoformat(p["quota_reset"].replace("Z", "+00:00")).timestamp() > time.time():
                return web.json_response({"ok": False, "queued": False, "reason": "quota", **p}, status=429)
        except ValueError:
            pass
        if p["requests_left"] <= 0:
            return web.json_response({"ok": False, "queued": False, "reason": "daily limit", **p}, status=429)
        try:
            os.makedirs(INBOX, exist_ok=True)
            name = f"request-{int(time.time())}.json"
            tmp = os.path.join(INBOX, "." + name)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"at": time.time(), "from": request.remote}, f)
            os.replace(tmp, os.path.join(INBOX, name))
        except OSError as e:
            return web.json_response({"ok": False, "error": f"inbox not writable: {e}"}, status=503)
        return web.json_response({"ok": True, "queued": True, **status_payload()},
                                 dumps=lambda o: json.dumps(o, ensure_ascii=False))
    return handle_run
