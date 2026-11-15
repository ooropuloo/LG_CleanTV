"""Home Assistant connection for the tv-home bridge.

HAClient: talks to the real HA (websocket `subscribe_entities` filtered to the whitelist for live
state, REST for service calls and camera snapshots). Reconnects with exponential backoff.
MockHA:   the same interface with realistic fake states, so the bridge runs fully offline (--mock).

Both keep `self.states` = {entity_id: {"s": state, "a": {all attrs}, "lc": epoch seconds}} and call
`on_change(entity_id, record_or_None)` for every change, and `on_status(connected: bool)`.
The token stays in this process; nothing here is ever sent to the page untrimmed.
"""
import asyncio
import math
import json
import logging
import os
import random
import time

import aiohttp

log = logging.getLogger("tvhome.ha")


class HAError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


class _Base:
    def __init__(self, entity_ids, on_change, on_status):
        self.entity_ids = list(entity_ids)
        self.states = {}
        self.connected = False
        self._on_change = on_change
        self._on_status = on_status

    def _set_status(self, ok):
        if ok != self.connected:
            self.connected = ok
            self._on_status(ok)

    def _put(self, eid, rec):
        if rec is None:
            self.states.pop(eid, None)
        else:
            self.states[eid] = rec
        self._on_change(eid, rec)


class HAClient(_Base):
    def __init__(self, url, token, entity_ids, on_change, on_status):
        super().__init__(entity_ids, on_change, on_status)
        self.url = url.rstrip("/")
        self._token = token
        self._session = None
        self._task = None

    @property
    def _auth(self):
        return {"Authorization": "Bearer " + self._token}

    async def start(self):
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10))
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
        if self._session:
            await self._session.close()

    async def _run(self):
        backoff = 1
        while True:
            try:
                await self._session_once()
                backoff = 1
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - any failure means reconnect
                log.warning("HA websocket: %s: %s", type(e).__name__, e)
            if self.connected:  # we had a working session: start the backoff over
                backoff = 1
            self._set_status(False)
            delay = backoff + random.uniform(0, backoff / 2)
            log.info("HA reconnect in %.1f s", delay)
            await asyncio.sleep(delay)
            backoff = min(backoff * 2, 60)

    async def _session_once(self):
        ws_url = self.url.replace("http://", "ws://").replace("https://", "wss://") + "/api/websocket"
        async with self._session.ws_connect(ws_url, heartbeat=30, max_msg_size=8 * 1024 * 1024) as ws:
            msg = await ws.receive_json(timeout=15)
            if msg.get("type") != "auth_required":
                raise RuntimeError("unexpected hello: %s" % msg.get("type"))
            await ws.send_json({"type": "auth", "access_token": self._token})
            msg = await ws.receive_json(timeout=15)
            if msg.get("type") != "auth_ok":
                raise RuntimeError("auth failed (%s)" % msg.get("type"))
            await ws.send_json({"id": 1, "type": "subscribe_entities", "entity_ids": self.entity_ids})
            got_initial = False
            async for m in ws:
                if m.type != aiohttp.WSMsgType.TEXT:
                    if m.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        break
                    continue
                data = json.loads(m.data)
                for item in data if isinstance(data, list) else [data]:
                    if item.get("type") == "result" and item.get("id") == 1 and not item.get("success"):
                        raise RuntimeError("subscribe_entities failed: %s" % item.get("error"))
                    if item.get("type") != "event" or item.get("id") != 1:
                        continue
                    ev = item.get("event") or {}
                    self._apply(ev, initial=not got_initial)
                    if not got_initial and "a" in ev:
                        got_initial = True
                        self._set_status(True)
            raise RuntimeError("websocket closed")

    def _apply(self, ev, initial=False):
        """Apply one compressed subscribe_entities event: a = added/full, c = diff, r = removed."""
        allowed = set(self.entity_ids)
        if initial:  # the first "a" is the full set: anything we had and HA no longer has is gone
            for eid in list(self.states):
                if eid not in (ev.get("a") or {}):
                    self._put(eid, None)
        for eid, st in (ev.get("a") or {}).items():
            if eid in allowed:
                self._put(eid, {"s": st.get("s"), "a": dict(st.get("a") or {}), "lc": st.get("lc")})
        for eid, diff in (ev.get("c") or {}).items():
            if eid not in allowed or eid not in self.states:
                continue
            cur = self.states[eid]
            rec = {"s": cur["s"], "a": dict(cur["a"]), "lc": cur.get("lc")}
            plus, minus = diff.get("+") or {}, diff.get("-") or {}
            if "s" in plus:
                rec["s"] = plus["s"]
            if "lc" in plus:
                rec["lc"] = plus["lc"]
            rec["a"].update(plus.get("a") or {})
            for k in minus.get("a") or []:
                rec["a"].pop(k, None)
            self._put(eid, rec)
        for eid in ev.get("r") or []:
            if eid in self.states:
                self._put(eid, None)

    async def call(self, domain, service, data):
        async with self._session.post(f"{self.url}/api/services/{domain}/{service}", json=data,
                                      headers=self._auth, timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status >= 400:
                raise HAError(r.status, (await r.text())[:200])
            return True

    async def snapshot(self, camera_id):
        async with self._session.get(f"{self.url}/api/camera_proxy/{camera_id}", headers=self._auth,
                                     timeout=aiohttp.ClientTimeout(total=25)) as r:
            if r.status >= 400:
                raise HAError(r.status, "camera_proxy %d" % r.status)
            return await r.read(), r.headers.get("Content-Type", "image/jpeg")


# --------------------------------------------------------------------------------------------- mock

def _now():
    return time.time()


MOCK_STATES = {
    "weather.forecast_home": ("rainy", {"friendly_name": "Forecast Home", "temperature": 21.7, "temperature_unit": "°C",
                                          "humidity": 98, "wind_speed": 9.0, "wind_speed_unit": "km/h"}),
    "sensor.living_room_temperature": ("27.4", {"friendly_name": "客廳溫度", "unit_of_measurement": "°C", "device_class": "temperature"}),
    "sensor.living_room_humidity": ("62.1", {"friendly_name": "客廳濕度", "unit_of_measurement": "%", "device_class": "humidity"}),
    "binary_sensor.smoke_detector_smoke": ("off", {"friendly_name": "煙霧偵測器 煙霧", "device_class": "smoke"}),
    "binary_sensor.living_room_person": ("on", {"friendly_name": "客廳 有人", "device_class": "occupancy"}),
    "vacuum.robot_vacuum": ("docked", {"friendly_name": "掃地機器人", "fan_speed": "max"}),
    "camera.garage": ("idle", {"friendly_name": "車庫攝影機"}),
    "camera.living_room": ("streaming", {"friendly_name": "客廳攝影機"}),
    "cover.garage_door": ("closed", {"friendly_name": "車庫鐵門", "current_position": 0, "device_class": "garage"}),
    "light.living_room_main": ("off", {"friendly_name": "主燈", "brightness": None}),
    "light.bar_lamp": ("on", {"friendly_name": "Mi Smart LED Bulb", "brightness": 200}),
    "climate.living_room_ac": ("cool", {"friendly_name": "客廳冷氣", "temperature": 26, "current_temperature": None,
                                         "min_temp": 16, "max_temp": 30, "target_temp_step": 1, "last_on_operation": "cool"}),
    "climate.bedroom_ac": ("off", {"friendly_name": "主臥冷氣", "temperature": 18, "current_temperature": None,
                                       "min_temp": 16, "max_temp": 30, "target_temp_step": 1, "last_on_operation": "cool"}),
    "climate.study_ac": ("off", {"friendly_name": "工作室冷氣", "temperature": 18, "current_temperature": None,
                                             "min_temp": 10, "max_temp": 32, "target_temp_step": 1, "last_on_operation": "cool"}),
}

MOCK_JPEG_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a5260"/><stop offset="1" stop-color="#1c2027"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/>
<g stroke="#707a88" stroke-width="6">{slats}</g>
<rect x="250" y="470" width="420" height="170" rx="40" fill="#30353e"/><circle cx="330" cy="640" r="45" fill="#111"/><circle cx="590" cy="640" r="45" fill="#111"/>
<text x="40" y="60" font-family="monospace" font-size="34" fill="#fff">MOCK camera.garage  {ts}</text>
<text x="40" y="690" font-family="sans-serif" font-size="30" fill="#ffd27a">模擬畫面(--mock)</text></svg>"""


MOCK_C400_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="#3b3428"/><rect y="470" width="1280" height="250" fill="#5a4a36"/>
<rect x="120" y="300" width="520" height="200" rx="30" fill="#6d7c8c"/><rect x="140" y="250" width="480" height="90" rx="30" fill="#7d8c9c"/>
<rect x="860" y="120" width="300" height="220" rx="8" fill="#20252c" stroke="#111" stroke-width="10"/>
<circle cx="{x}" cy="560" r="38" fill="#e0a050"/><path d="M{x} 520 l-22 -30 l10 34 z M{x} 520 l22 -30 l-10 34 z" fill="#e0a050"/>
<text x="40" y="60" font-family="monospace" font-size="34" fill="#fff">MOCK camera.living_room  {ts}</text>
<text x="40" y="690" font-family="sans-serif" font-size="30" fill="#ffd27a">模擬一樓畫面(--mock)</text></svg>"""


class MockHA(_Base):
    """Fake HA: realistic states, services that behave (garage takes a few seconds), slow drift."""

    def __init__(self, entity_ids, on_change, on_status):
        super().__init__(entity_ids, on_change, on_status)
        self._tasks = []
        self.calls = []  # (domain, service, data) for tests

    async def start(self):
        t = _now()
        for eid in self.entity_ids:
            if eid in MOCK_STATES:
                s, a = MOCK_STATES[eid]
                self.states[eid] = {"s": s, "a": dict(a), "lc": t - random.uniform(60, 3600)}
        if os.environ.get("MOCK_SMOKE") and "binary_sensor.smoke_detector_smoke" in self.states:  # test the alert banner
            self.states["binary_sensor.smoke_detector_smoke"]["s"] = "on"
        self._set_status(True)
        self._tasks.append(asyncio.create_task(self._drift()))

    async def stop(self):
        for t in self._tasks:
            t.cancel()

    def _update(self, eid, s=None, **attrs):
        cur = self.states.get(eid)
        if not cur:
            return
        rec = {"s": cur["s"], "a": dict(cur["a"]), "lc": cur["lc"]}
        if s is not None and s != rec["s"]:
            rec["s"], rec["lc"] = s, _now()
        rec["a"].update(attrs)
        self._put(eid, rec)

    async def _drift(self):
        while True:
            await asyncio.sleep(30)
            for eid, lo, hi, step in (("sensor.living_room_temperature", 24, 31, 0.1),
                                      ("sensor.living_room_humidity", 50, 75, 0.4)):
                if eid in self.states:
                    v = float(self.states[eid]["s"]) + random.choice((-step, 0, step))
                    self._update(eid, "%.1f" % min(hi, max(lo, v)))

    async def _later(self, delay, eid, s, **attrs):
        await asyncio.sleep(delay)
        self._update(eid, s, **attrs)

    async def call(self, domain, service, data):
        eid = data.get("entity_id")
        self.calls.append((domain, service, dict(data)))
        log.info("mock call %s.%s %s", domain, service, data)
        if eid not in self.states:
            raise HAError(400, "unknown entity")
        cur = self.states[eid]
        later = lambda *a, **k: self._tasks.append(asyncio.create_task(self._later(*a, **k)))  # noqa: E731
        if (domain, service) == ("light", "toggle"):
            on = cur["s"] != "on"
            later(0.3, eid, "on" if on else "off", brightness=200 if on else None)
        elif (domain, service) == ("cover", "open_cover"):
            self._update(eid, "opening")
            later(4, eid, "open", current_position=100)
        elif (domain, service) == ("cover", "close_cover"):
            self._update(eid, "closing")
            later(4, eid, "closed", current_position=0)
        elif (domain, service) == ("climate", "turn_on"):
            later(0.3, eid, cur["a"].get("last_on_operation") or "cool")
        elif (domain, service) == ("climate", "turn_off"):
            later(0.3, eid, "off")
        elif (domain, service) == ("climate", "set_temperature"):
            later(0.2, eid, None, temperature=data.get("temperature"))
        return True

    async def snapshot(self, camera_id):
        if camera_id == "camera.living_room":  # mains powered, fast; a ticking clock shows the refresh
            await asyncio.sleep(0.15)
            t = time.time()
            x = 640 + int(260 * math.sin(t / 3))
            svg = MOCK_C400_SVG.replace("{ts}", time.strftime("%H:%M:%S")).replace("{x}", str(x))
            return svg.encode("utf-8"), "image/svg+xml"
        if os.environ.get("MOCK_CAM_FAIL"):  # test the "battery camera asleep" message
            await asyncio.sleep(0.6)
            raise HAError(500, "mock camera asleep")
        await asyncio.sleep(0.6)  # a battery camera wakes up slowly
        slats = "".join(f'<line x1="0" y1="{y}" x2="1280" y2="{y}"/>' for y in range(40, 470, 36))
        svg = MOCK_JPEG_SVG.replace("{slats}", slats).replace("{ts}", time.strftime("%H:%M:%S"))
        return svg.encode("utf-8"), "image/svg+xml"
