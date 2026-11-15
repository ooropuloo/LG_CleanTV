"""tv-home bridge: serves the TV home page and proxies a whitelisted slice of Home Assistant.

    python bridge/server.py --mock                 # offline, fake HA states
    HA_URL=http://192.168.1.10:8123 HA_TOKEN=... python bridge/server.py

Env: HA_URL, HA_TOKEN (never sent to the page), PORT (default from config.json, 8790), TV_IP,
ALLOW_CALL_FROM (comma list, added to config allow_call_from), TVHOME_CONFIG (path to config.json; falls back to config.example.json),
LOG_LEVEL, GEMINI_API_KEY (assistant; never sent to the page), GEMINI_MODELS (comma list, tried in order).

HTTP:
  GET  /                      web/index.html (also /web/...), /cats/..., /vendor/...
  GET  /api/health            {"ok": true, "ha": bool, "mock": bool}
  GET  /api/config            page-safe config (apps, ui roles, styles; no secrets)
  GET  /api/states            {entity_id: {s, a, lc}} whitelisted, attributes trimmed
  GET  /api/events            SSE: "states" (full, on connect), "state" (one change), "ha" (status)
  POST /api/call              {entity_id, service: "domain.svc", data?, confirm?}  allow-listed IPs only
  GET  /api/snapshot/<cam>    camera snapshot (whitelisted cam key), 1 per cameras.<cam>.min_interval_s, allow-listed IPs only
  POST /api/assist            {text} -> AI assistant (assist.py: Gemini + HA whitelist + YouTube), allow-listed IPs only
  GET  /api/ytpick?key=<tile> pick a long YouTube video for a "ytsearch_play" tile (cached per day)
  GET  /api/ytpick?key=<tile> long YouTube video for a "ytsearch_play" app tile (picked once a day)
  GET  /api/scenes/factory    scene factory status (latest generated scene, recent runs); see factory_api.py
  POST /api/scenes/factory/run request one new generated scene now (allow-listed IPs, rate-limited; host cron runs it)
  POST /api/launch            501 stub (TODO: SSAP system.launcher/launch, see tv_power.py)
"""
import argparse
import asyncio
import json
import logging
import mimetypes
import os
import sys
import time

from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import ha  # noqa: E402
import assist  # noqa: E402
import factory_api  # noqa: E402

log = logging.getLogger("tvhome")

STATIC_ROOTS = {"cats": os.path.join(ROOT, "cats"), "vendor": os.path.join(ROOT, "vendor"), "web": os.path.join(ROOT, "web")}
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
    ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".ktx2": "image/ktx2",
    ".hdr": "application/octet-stream", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
}
NO_SERVE = {".py", ".md", ".env", ".pyc", ".sh"}

# Attributes the page may see, per domain (plus friendly_name). Everything else (entity_picture with
# its access token, IR codes, model info...) is dropped.
KEEP_ATTRS = {
    "climate": ["temperature", "current_temperature", "min_temp", "max_temp", "target_temp_step", "hvac_action", "last_on_operation"],
    "cover": ["current_position", "device_class"],
    "light": ["brightness", "color_mode"],
    "sensor": ["unit_of_measurement", "device_class"],
    "binary_sensor": ["device_class"],
    "vacuum": ["battery_level", "status", "fan_speed"],
    "weather": ["temperature", "temperature_unit", "humidity", "wind_speed", "wind_speed_unit", "apparent_temperature"],
    "camera": [],
}
# Extra data keys allowed per service (validated & clamped); every other key is rejected.
SERVICE_DATA = {"climate.set_temperature": {"temperature": "number"}}


def load_config(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    ents = cfg.setdefault("entities", {})
    cams = {}
    for cam, c in (cfg.get("cameras") or {}).items():
        c = {"entity": c} if isinstance(c, str) else dict(c)  # old form: {"key": "camera.x"}
        cams[cam] = c
        if c["entity"] not in ents:
            ents[c["entity"]] = {"name": c.get("name", cam)}
    cfg["cameras"] = cams
    return cfg


def trim(eid, rec):
    if rec is None:
        return None
    domain = eid.split(".", 1)[0]
    a = rec.get("a") or {}
    keep = {k: a[k] for k in ["friendly_name"] + KEEP_ATTRS.get(domain, []) if k in a}
    return {"s": rec.get("s"), "a": keep, "lc": rec.get("lc")}



async def knock_awake(hostport, max_s=15.0):
    """Battery Tapo (C425) in deep sleep is unreachable on the LAN; trying to connect about once a second wakes it
    within ~4 s (measured 2026-11-15). Returns seconds until reachable, or None."""
    host, _, port = hostport.partition(":")
    t0 = time.monotonic()
    while time.monotonic() - t0 < max_s:
        try:
            _, w = await asyncio.wait_for(asyncio.open_connection(host, int(port or 8800)), timeout=2)
            w.close()
            return round(time.monotonic() - t0, 1)
        except (OSError, asyncio.TimeoutError):
            await asyncio.sleep(1)
    return None


class Bridge:
    def __init__(self, cfg, mock, ha_url, ha_token):
        self.cfg = cfg
        self.mock = mock
        self.subscribers = set()
        ids = list(cfg["entities"].keys())
        if mock:
            self.ha = ha.MockHA(ids, self._on_change, self._on_status)
        else:
            if not ha_url or not ha_token:
                raise SystemExit("HA_URL and HA_TOKEN must be set (or use --mock)")
            self.ha = ha.HAClient(ha_url, ha_token, ids, self._on_change, self._on_status)
        allow = set(cfg.get("allow_call_from") or ["127.0.0.1", "::1"])
        tv_ip = os.environ.get("TV_IP") or cfg.get("tv_ip")
        if tv_ip:
            allow.add(tv_ip)
        allow.update(x.strip() for x in os.environ.get("ALLOW_CALL_FROM", "").split(",") if x.strip())
        self.allow = allow
        self.snap_interval = float(cfg.get("snapshot_min_interval_s", 10))  # default per camera
        self.snap_last = {}
        self.snap_locks = {}
        self.assistant = assist.Assistant(self)

    def cam_interval(self, cam):
        c = (self.cfg.get("cameras") or {}).get(cam) or {}
        return float(c.get("min_interval_s", self.snap_interval))

    # ---- push
    def _broadcast(self, event, payload):
        data = f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()
        for q in list(self.subscribers):
            if q.qsize() > 200:  # a stuck client: drop it, EventSource will reconnect and resync
                self.subscribers.discard(q)
                q.put_nowait(None)
            else:
                q.put_nowait(data)

    def _on_change(self, eid, rec):
        self._broadcast("state", {"id": eid, "st": trim(eid, rec)})

    def _on_status(self, ok):
        log.info("HA %s", "connected" if ok else "disconnected")
        self._broadcast("ha", {"connected": ok})

    def states(self):
        return {eid: trim(eid, rec) for eid, rec in self.ha.states.items() if eid in self.cfg["entities"]}

    def allowed(self, request):
        ip = request.remote or ""
        if ip.startswith("::ffff:"):
            ip = ip[7:]
        return ip in self.allow

    # ---- handlers
    async def health(self, request):
        return web.json_response({"ok": True, "ha": self.ha.connected, "mock": self.mock, "time": time.time()},
                                 headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})

    async def config(self, request):
        c = self.cfg
        apps = []
        for a in c.get("apps", []):
            if a.get("show", True) is False:
                continue
            a = json.loads(json.dumps(a))
            for k, v in (a.get("params") or {}).items():
                if v == "$ha_browser_url":
                    a["params"][k] = c.get("ha_browser_url", "")
            apps.append(a)
        gen = factory_api.gen_scenes(ROOT)
        pub = {
            "apps": apps, "ui": c.get("ui", {}), "styles": c.get("styles", ["_example"]) + (["gen-live"] if gen else []),
            "default_style": c.get("default_style", "_example"), "default_coat": c.get("default_coat", "black"),
            "names": {eid: e.get("name") for eid, e in c["entities"].items() if e.get("name")},
            "services": {eid: e.get("services", []) for eid, e in c["entities"].items() if e.get("services")},
            "confirm": [eid for eid, e in c["entities"].items() if e.get("confirm")],
            "cameras": list((c.get("cameras") or {}).keys()), "snapshot_min_interval_s": self.snap_interval,
            "camera_info": {k: {"name": v.get("name", k), "live": bool(v.get("live")), "battery": bool(v.get("battery")),
                                "refresh_s": float(v.get("refresh_s", 1.5)), "min_interval_s": self.cam_interval(k)}
                            for k, v in (c.get("cameras") or {}).items()},
            # hand-made scenes from config + scenes published by the factory (cats/gen-live/scenes.json, re-read when it changes)
            "scenes": (c.get("scenes") or []) + gen, "wallpaper_schedule": c.get("wallpaper_schedule"),
            "assistant": self.assistant.public_info(),
            "mock": self.mock, "can_call": self.allowed(request),
        }
        return web.json_response(pub, headers={"Cache-Control": "no-store"}, dumps=lambda o: json.dumps(o, ensure_ascii=False))

    async def get_states(self, request):
        return web.json_response({"connected": self.ha.connected, "states": self.states()},
                                 headers={"Cache-Control": "no-store"}, dumps=lambda o: json.dumps(o, ensure_ascii=False))

    async def events(self, request):
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-store",
                                           "X-Accel-Buffering": "no"})
        await resp.prepare(request)
        q = asyncio.Queue()
        self.subscribers.add(q)
        try:
            first = {"connected": self.ha.connected, "states": self.states()}
            await resp.write(b"retry: 3000\n" + f"event: states\ndata: {json.dumps(first, ensure_ascii=False)}\n\n".encode())
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=20)
                except asyncio.TimeoutError:
                    data = b": ping\n\n"
                if data is None:
                    break
                await resp.write(data)
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            self.subscribers.discard(q)
        return resp

    async def call(self, request):
        if not self.allowed(request):
            log.warning("call refused from %s", request.remote)
            return web.json_response({"ok": False, "error": "forbidden"}, status=403)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        eid, svc = str(body.get("entity_id", "")), str(body.get("service", ""))
        status, err = await self.do_call(eid, svc, body.get("data"), body.get("confirm") is True, request.remote)
        if status != 200:
            return web.json_response({"ok": False, "error": err}, status=status)
        return web.json_response({"ok": True})

    def check_call(self, eid, svc, data, confirm):
        """Whitelist + data validation shared by /api/call and the assistant. -> (status, error, ha_data)."""
        ent = self.cfg["entities"].get(eid)
        if not ent or svc not in (ent.get("services") or []):
            return 403, "not allowed", None
        if ent.get("confirm") and confirm is not True:
            return 409, "confirm required", None
        if data is not None and not isinstance(data, dict):
            return 400, "data must be an object", None
        out = {"entity_id": eid}
        schema = SERVICE_DATA.get(svc, {})
        for k, v in (data or {}).items():
            if k not in schema:
                return 400, f"data key {k} not allowed", None
            if schema[k] == "number":
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    return 400, f"{k} must be a number", None
                a = (self.ha.states.get(eid) or {}).get("a") or {}
                lo, hi = float(a.get("min_temp", 16)), float(a.get("max_temp", 30))
                v = max(lo, min(hi, float(v)))
            out[k] = v
        return 200, None, out

    async def do_call(self, eid, svc, data, confirm, who):
        status, err, hdata = self.check_call(eid, svc, data, confirm)
        if status != 200:
            return status, err
        domain, service = svc.split(".", 1)
        try:
            await self.ha.call(domain, service, hdata)
        except ha.HAError as e:
            return 502, f"HA {e.status}"
        except Exception as e:  # noqa: BLE001
            log.warning("call %s %s failed: %s", svc, eid, e)
            return 502, "HA unreachable"
        log.info("call %s %s from %s", svc, eid, who)
        return 200, None

    async def snapshot(self, request):
        if not self.allowed(request):
            return web.json_response({"ok": False, "error": "forbidden"}, status=403)
        cam = request.match_info["cam"]
        eid = ((self.cfg.get("cameras") or {}).get(cam) or {}).get("entity")
        if not eid:
            return web.json_response({"ok": False, "error": "unknown camera"}, status=404)
        lock = self.snap_locks.setdefault(cam, asyncio.Lock())
        async with lock:  # one fetch per camera at a time (a battery camera wakes up slowly)
            wait = self.snap_last.get(cam, 0) + self.cam_interval(cam) - time.monotonic()
            if wait > 0:
                return web.json_response({"ok": False, "error": "too soon", "retry_after": round(wait, 1)}, status=429,
                                         headers={"Retry-After": str(int(wait) + 1)})
            self.snap_last[cam] = time.monotonic()
            wake = ((self.cfg.get("cameras") or {}).get(cam) or {}).get("wake_host")
            if wake and not self.mock:
                waited = await knock_awake(wake)
                log.info("snapshot %s: knock %s -> %s", cam, wake, "asleep >15s" if waited is None else f"{waited}s")
            try:
                body, ctype = await self.ha.snapshot(eid)
            except Exception as e:  # noqa: BLE001
                log.warning("snapshot %s failed: %s", eid, e)
                return web.json_response({"ok": False, "error": "snapshot failed"}, status=502)
        return web.Response(body=body, content_type=ctype.split(";")[0], headers={"Cache-Control": "no-store"})

    async def ytpick(self, request):
        """GET /api/ytpick?key=<app key>: for an app tile {action: "ytsearch_play", query, min_minutes, allow_live?}
        search YouTube (assistant's youtube_search, no API key) and pick the first result at least min_minutes long.
        The pick is cached per tile for the day, so the tile plays the same video all day."""
        if not self.allowed(request):
            return web.json_response({"ok": False, "error": "forbidden"}, status=403)
        key = request.query.get("key", "")
        app = next((a for a in self.cfg.get("apps", []) if a.get("key") == key and a.get("action") == "ytsearch_play"), None)
        if not app or not app.get("query"):
            return web.json_response({"ok": False, "error": "unknown tile"}, status=404)
        today = time.strftime("%Y-%m-%d")
        cache = self.__dict__.setdefault("_ytpick", {})
        hit = cache.get(key)
        if hit and hit[0] == today:
            return web.json_response(dict(hit[1], cached=True), dumps=lambda o: json.dumps(o, ensure_ascii=False))
        res = await self.assistant.youtube_search(str(app["query"])[:80])
        need = float(app.get("min_minutes", 0))

        def minutes(d):
            parts = str(d or "").split(":")
            if not parts or not all(p.isdigit() for p in parts):
                return None
            v = 0
            for p in parts:
                v = v * 60 + int(p)
            return v / 60          # h:mm:ss or mm:ss -> minutes

        pick = next((r for r in res if (minutes(r.get("duration")) or 0) >= need), None)
        if not pick and app.get("allow_live"):
            pick = next((r for r in res if minutes(r.get("duration")) is None), None)
        if not pick:
            return web.json_response({"ok": False, "error": "no long enough result", "query": app["query"]}, status=404)
        out = {"ok": True, "videoId": pick["videoId"], "title": pick.get("title", ""), "duration": pick.get("duration", ""), "query": app["query"]}
        cache[key] = (today, out)
        log.info("ytpick %s -> %s %s (%s)", key, out["videoId"], out["title"][:50], out["duration"])
        return web.json_response(out, dumps=lambda o: json.dumps(o, ensure_ascii=False))

    async def launch(self, request):
        # TODO(real TV): forward to the TV over SSAP `ssap://system.launcher/launch` {id, params}
        # (needs the pairing key from tv_power.py). The page only gets here when PalmServiceBridge /
        # webOS.service is unavailable in the hosted page (e.g. desktop browser, or ACG refused it).
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        log.info("launch stub: %s", body)
        return web.json_response({"ok": False, "error": "not implemented", "todo": "SSAP system.launcher/launch",
                                  "id": body.get("id")}, status=501)

    async def static(self, request):
        tail = request.match_info.get("tail", "")
        parts = [p for p in tail.split("/") if p]
        if parts and parts[0] in STATIC_ROOTS:
            base, parts = STATIC_ROOTS[parts[0]], parts[1:]
        else:
            base = STATIC_ROOTS["web"]
        if any(p in ("..", ".") or p.startswith(".") for p in parts):
            raise web.HTTPForbidden()
        path = os.path.normpath(os.path.join(base, *parts)) if parts else base
        if not (path == base or path.startswith(base + os.sep)):
            raise web.HTTPForbidden()
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        ext = os.path.splitext(path)[1].lower()
        if ext in NO_SERVE or not os.path.isfile(path):
            raise web.HTTPNotFound()
        ctype = MIME.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
        cache = "no-cache" if ext in (".html", ".js", ".mjs", ".css", ".json") else "public, max-age=3600"
        resp = web.FileResponse(path, headers={"Content-Type": ctype, "Cache-Control": cache})
        return resp


def make_app(bridge):
    app = web.Application()
    app.router.add_get("/api/health", bridge.health)
    app.router.add_get("/api/config", bridge.config)
    app.router.add_get("/api/states", bridge.get_states)
    app.router.add_get("/api/events", bridge.events)
    app.router.add_post("/api/call", bridge.call)
    app.router.add_get("/api/snapshot/{cam}", bridge.snapshot)
    app.router.add_post("/api/launch", bridge.launch)
    app.router.add_get("/api/ytpick", bridge.ytpick)
    app.router.add_post("/api/assist", bridge.assistant.handle)
    app.router.add_get("/api/scenes/factory", factory_api.handle_status)
    app.router.add_post("/api/scenes/factory/run", factory_api.make_run_handler(bridge))
    app.router.add_get("/{tail:.*}", bridge.static)

    async def on_start(_app):
        await bridge.ha.start()

    async def on_stop(_app):
        await bridge.ha.stop()
        await bridge.assistant.close()
        for q in list(bridge.subscribers):
            q.put_nowait(None)

    app.on_startup.append(on_start)
    app.on_shutdown.append(on_stop)
    return app


def main():
    ap = argparse.ArgumentParser(description="tv-home bridge")
    ap.add_argument("--mock", action="store_true", help="fake Home Assistant (offline)")
    ap.add_argument("--port", type=int, default=0, help="port (default PORT env, else config port, 8790)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--config", default=os.environ.get("TVHOME_CONFIG", os.path.join(HERE, "config.json")))
    a = ap.parse_args()
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not os.path.exists(a.config) and os.path.exists(os.path.join(HERE, "config.example.json")):
        # fresh clone: cp bridge/config.example.json bridge/config.json and edit it for your home
        log.warning("%s not found, using config.example.json", a.config)
        a.config = os.path.join(HERE, "config.example.json")
    cfg = load_config(a.config)
    port = a.port or int(os.environ.get("PORT") or cfg.get("port") or 8790)
    bridge = Bridge(cfg, a.mock, os.environ.get("HA_URL", ""), os.environ.get("HA_TOKEN", ""))
    log.info("tv-home bridge on %s:%d (%s), /api/call allowed from %s", a.host, port,
             "MOCK" if a.mock else os.environ.get("HA_URL"), sorted(bridge.allow))
    web.run_app(make_app(bridge), host=a.host, port=port, print=None, access_log=None)


if __name__ == "__main__":
    main()
