"""AI 助手 for the TV home page: text in (typed / LG keyboard dictation), actions out.

POST /api/assist {"text": "..."}  (allow-listed IPs only, rate-limited, text capped)
 -> {"ok": true, "reply": "...", "done": ["主燈 → 開"], "results": [{videoId,title,channel,duration}],
     "query": "...", "actions": [{"type": "play", "videoId", "title"}], "brain": "gemini:<model>" | "rules"}

Brain: Gemini REST generateContent with function calling (env GEMINI_API_KEY, header x-goog-api-key;
models from env GEMINI_MODELS tried in order). Without a key, or when every model fails, a small
rule-based parser does the same things (so --mock works offline).

Tools (all enforced here, not trusted from the model):
  ha_state(entity_id)                      any whitelisted entity in config.json
  ha_action(entity_id, service, data)      same whitelist + validation as /api/call (Bridge.check_call);
                                           entities with "confirm", covers, and assistant.deny_entities are
                                           never operable (garage door: state only)
  youtube_search(query)                    server-side fetch of youtube.com/results, parse ytInitialData, cached
  play_youtube(video_id, title)            returns an action; the PAGE launches youtube.leanback.v4 with
                                           params.contentTarget = https://www.youtube.com/tv?v=<id> (verified on the TV)
The Gemini key and the HA token never leave the bridge; logs show the text only.
"""
import asyncio
import collections
import json
import logging
import os
import re
import time
import urllib.parse

import aiohttp

log = logging.getLogger("tvhome.assist")

DEFAULT_MODELS = "gemini-3.5-flash-lite,gemini-flash-lite-latest"
GEMINI_URL = (os.environ.get("GEMINI_BASE") or "https://generativelanguage.googleapis.com") + "/v1beta/models/{model}:generateContent"  # GEMINI_BASE: tests only
YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36"

STATE_ZH = {"on": "開", "off": "關", "open": "開著", "closed": "關著", "opening": "開啟中", "closing": "關閉中",
            "cool": "冷氣", "heat": "暖氣", "dry": "除濕", "fan_only": "送風", "auto": "自動", "heat_cool": "自動",
            "docked": "在充電座", "cleaning": "清掃中", "returning": "回充中", "idle": "待機", "paused": "暫停", "error": "錯誤",
            "unavailable": "無法連線", "unknown": "不明"}

# Offline / mock search results (real video ids so thumbnails and the TV deep link can be tried).
CANNED_YT = [
    {"videoId": "WjpCrzdMtCk", "title": "貓電視給貓看 滿足的鳥和松鼠 4K HDR", "channel": "Birder King", "duration": "8:00:38"},
    {"videoId": "AJmNsIEYvZM", "title": "【猫用動画MIX11】蝶・鳥・ひも・ネズミ30分 GAME FOR CATS 11", "channel": "carumela", "duration": "30:30"},
    {"videoId": "wVWLrwqsq3c", "title": "Cat TV 貓咪電視水族館 LIVE 24/7 | 貓咪看真實魚缸 (4K)", "channel": "Cat TV Fish Tank 4K", "duration": "直播"},
    {"videoId": "85h2xmyhQPY", "title": "Music for Cats - Good Sleep Music and Stress Relief", "channel": "Sleepy Cats", "duration": "11:54:56"},
    {"videoId": "sjRFEDj0a50", "title": "Mama Cat Trims Fur on the Farm and Makes Tiger Hat For Kittens", "channel": "Kitty Cinematic", "duration": "29:23"},
    {"videoId": "jNQXAC9IVRw", "title": "Me at the zoo", "channel": "jawed", "duration": "0:19"},
]

TOOLS = [{"functionDeclarations": [
    {"name": "ha_state", "description": "讀取家裡某個裝置目前的狀態(只限清單內的 entity_id)。",
     "parameters": {"type": "OBJECT", "properties": {"entity_id": {"type": "STRING"}}, "required": ["entity_id"]}},
    {"name": "ha_action", "description": "控制家裡的裝置。只能用清單裡該裝置列出的 service。冷氣設溫度用 climate.set_temperature 並給 data.temperature。"
                                         "燈可以用 light.turn_on / light.turn_off(會自動換成切換)。",
     "parameters": {"type": "OBJECT", "properties": {
         "entity_id": {"type": "STRING"}, "service": {"type": "STRING", "description": "例如 light.turn_on、climate.turn_off、climate.set_temperature"},
         "data": {"type": "OBJECT", "properties": {"temperature": {"type": "NUMBER"}}}}, "required": ["entity_id", "service"]}},
    {"name": "youtube_search", "description": "在 YouTube 搜尋影片,回傳前幾筆結果(videoId、標題、頻道、長度)。",
     "parameters": {"type": "OBJECT", "properties": {"query": {"type": "STRING"}}, "required": ["query"]}},
    {"name": "play_youtube", "description": "在電視的 YouTube App 播放指定影片(videoId 必須來自 youtube_search 的結果)。",
     "parameters": {"type": "OBJECT", "properties": {"video_id": {"type": "STRING"}, "title": {"type": "STRING"}}, "required": ["video_id"]}},
]}]

CN_DIGIT = {"零": 0, "〇": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn_number(s):
    """'二十六' / '廿六' / '十八' / '26' -> int or None."""
    s = s.strip().replace("廿", "二十")
    if s.isdigit():
        return int(s)
    if not s or any(c not in CN_DIGIT and c != "十" for c in s):
        return None
    if "十" in s:
        a, _, b = s.partition("十")
        return (CN_DIGIT[a] if a else 1) * 10 + (CN_DIGIT[b] if b else 0)
    return CN_DIGIT.get(s) if len(s) == 1 else None


class Assistant:
    def __init__(self, bridge):
        self.b = bridge
        c = bridge.cfg.get("assistant") or {}
        self.enabled = c.get("enabled", True) is not False
        self.max_text = int(c.get("max_text", 200))
        self.per_minute = int(os.environ.get("ASSIST_PER_MINUTE") or c.get("per_minute", 8))
        self.deny = set(c.get("deny_entities") or [])
        self.key = os.environ.get("GEMINI_API_KEY", "").strip()
        self.models = [m.strip() for m in (os.environ.get("GEMINI_MODELS") or DEFAULT_MODELS).split(",") if m.strip()]
        self.hits = collections.defaultdict(collections.deque)
        self.yt_cache = {}
        self.sem = asyncio.Semaphore(2)
        self.session = None
        self.good_model = None  # last model that answered: tried first next time

    def public_info(self):
        return {"enabled": self.enabled, "brain": "gemini" if self.key else "rules"}

    async def close(self):
        if self.session:
            await self.session.close()

    def _sess(self):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession()
        return self.session

    # ------------------------------------------------------------------ HTTP
    async def handle(self, request):
        from aiohttp import web
        if not self.enabled:
            return web.json_response({"ok": False, "error": "disabled"}, status=404)
        if not self.b.allowed(request):
            return web.json_response({"ok": False, "error": "forbidden"}, status=403)
        ip = request.remote or "?"
        now = time.monotonic()
        dq = self.hits[ip]
        while dq and now - dq[0] > 60:
            dq.popleft()
        if len(dq) >= self.per_minute:
            return web.json_response({"ok": False, "error": "too many", "retry_after": round(60 - (now - dq[0]), 1)}, status=429)
        dq.append(now)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        text = re.sub(r"\s+", " ", str(body.get("text") or "")).strip()[: self.max_text]
        if not text:
            return web.json_response({"ok": False, "error": "empty"}, status=400)
        log.info("assist from %s: %s", ip, text[:120])
        t0 = time.monotonic()
        async with self.sem:
            try:
                out = await asyncio.wait_for(self.run(text), timeout=30)
            except asyncio.TimeoutError:
                out = {"reply": "想太久了,請再說一次。", "done": [], "results": [], "actions": [], "brain": "timeout"}
        out["ok"] = True
        out["text"] = text
        log.info("assist -> %s in %.1fs: %s | done=%s actions=%s", out.get("brain"), time.monotonic() - t0,
                 (out.get("reply") or "")[:80], out.get("done"), [a.get("type") for a in out.get("actions", [])])
        return web.json_response(out, dumps=lambda o: json.dumps(o, ensure_ascii=False))

    async def run(self, text):
        ctx = {"done": [], "results": [], "actions": [], "query": None}
        if self.key:
            try:
                reply, model = await self.run_gemini(text, ctx)
                return dict(ctx, reply=reply, brain="gemini:" + model)
            except Exception as e:  # noqa: BLE001
                log.warning("gemini failed (%s), using rules", str(e)[:160])
                if ctx["done"] or ctx["actions"]:  # something already happened: do not repeat it
                    return dict(ctx, reply="好了。", brain="gemini-partial")
                reply = await self.run_rules(text, ctx)
                return dict(ctx, reply=reply, brain="rules")
        reply = await self.run_rules(text, ctx)
        return dict(ctx, reply=reply, brain="rules")

    # ------------------------------------------------------------------ tools
    def _name(self, eid):
        return (self.b.cfg["entities"].get(eid) or {}).get("name") or eid

    def _state(self, eid):
        return (self.b.states().get(eid)) or None

    def operable(self, eid):
        ent = self.b.cfg["entities"].get(eid) or {}
        return bool(ent.get("services")) and not ent.get("confirm") and eid not in self.deny and not eid.startswith("cover.")

    async def t_ha_state(self, ctx, entity_id=""):
        eid = str(entity_id)
        if eid not in self.b.cfg["entities"]:
            return {"ok": False, "error": "沒有這個裝置(只能查清單內的)"}
        st = self._state(eid)
        if not st:
            return {"ok": False, "error": "目前沒有狀態"}
        return {"ok": True, "name": self._name(eid), "state": st["s"], "state_zh": STATE_ZH.get(st["s"], st["s"]), "attributes": st["a"]}

    async def t_ha_action(self, ctx, entity_id="", service="", data=None):
        eid, svc = str(entity_id), str(service)
        if eid not in self.b.cfg["entities"]:
            return {"ok": False, "error": "沒有這個裝置"}
        if not self.operable(eid):
            return {"ok": False, "error": "安全限制:助手不能操作這個裝置,只能查狀態"}
        name = self._name(eid)
        allowed = self.b.cfg["entities"][eid].get("services") or []
        st = self._state(eid)
        domain = eid.split(".", 1)[0]
        if domain == "light" and svc in ("light.turn_on", "light.turn_off") and svc not in allowed and "light.toggle" in allowed:
            want = svc == "light.turn_on"
            if st and st["s"] in ("on", "off") and (st["s"] == "on") == want:
                ctx["done"].append(f"{name}本來就是{'開' if want else '關'}的")
                return {"ok": True, "note": f"{name}已經是{'開' if want else '關'}的,沒有動作"}
            svc = "light.toggle"
        if domain == "climate" and svc in ("climate.turn_on", "climate.turn_off") and st:
            want_on = svc == "climate.turn_on"
            if (st["s"] != "off") == want_on and st["s"] not in ("unavailable", "unknown"):
                ctx["done"].append(f"{name}本來就是{'開' if want_on else '關'}的")
                return {"ok": True, "note": "已經是這個狀態"}
        if isinstance(data, dict):
            data = {k: v for k, v in data.items() if v is not None}
            if not data:
                data = None
        status, err, hdata = self.b.check_call(eid, svc, data, False)
        if status == 200:
            status, err = await self.b.do_call(eid, svc, data, False, "assistant")
        if status != 200:
            return {"ok": False, "error": err}
        label = {"light.toggle": "切換", "climate.turn_on": "開", "climate.turn_off": "關"}.get(svc, svc)
        if svc == "light.toggle" and st:
            label = "關" if st["s"] == "on" else "開"
        if svc == "climate.set_temperature":
            label = f"{hdata.get('temperature'):g}°"
        ctx["done"].append(f"{name} → {label}")
        return {"ok": True}

    async def t_youtube_search(self, ctx, query=""):
        q = str(query).strip()[:80]
        if not q:
            return {"ok": False, "error": "沒有關鍵字"}
        res = await self.youtube_search(q)
        ctx["results"], ctx["query"] = res, q
        if not res:
            return {"ok": False, "error": "搜尋失敗或沒有結果"}
        return {"ok": True, "results": res}

    async def t_play_youtube(self, ctx, video_id="", title=""):
        vid = str(video_id).strip()
        if not YT_ID.match(vid):
            return {"ok": False, "error": "videoId 格式不對"}
        if not title:
            title = next((r["title"] for r in ctx["results"] if r["videoId"] == vid), "")
        ctx["actions"] = [a for a in ctx["actions"] if a.get("type") != "play"] + [{"type": "play", "videoId": vid, "title": str(title)[:120]}]
        ctx["done"].append("在 YouTube 播放" + (f":{str(title)[:40]}" if title else ""))
        return {"ok": True, "note": "電視會開 YouTube 播放"}

    async def run_tool(self, name, args, ctx):
        fn = {"ha_state": self.t_ha_state, "ha_action": self.t_ha_action, "youtube_search": self.t_youtube_search,
              "play_youtube": self.t_play_youtube}.get(name)
        if not fn:
            return {"ok": False, "error": "unknown tool"}
        args = {k: v for k, v in (args or {}).items() if k in ("entity_id", "service", "data", "query", "video_id", "title")}
        try:
            return await fn(ctx, **args)
        except Exception as e:  # noqa: BLE001
            log.warning("tool %s failed: %s", name, e)
            return {"ok": False, "error": "內部錯誤"}

    # ------------------------------------------------------------------ YouTube search (no API key)
    async def youtube_search(self, q):
        hit = self.yt_cache.get(q)
        if hit and time.monotonic() - hit[0] < 600:
            return hit[1]
        if self.b.mock and os.environ.get("MOCK_YT") != "live":
            return [dict(r) for r in CANNED_YT]
        url = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": q, "hl": "zh-TW", "gl": "TW"})
        out = []
        try:
            async with self._sess().get(url, headers={"User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9"},
                                        timeout=aiohttp.ClientTimeout(total=8)) as r:
                html = await r.text()
            m = re.search(r"var ytInitialData\s*=\s*(\{.*?\});\s*</script>", html, re.S)
            if m:
                out = parse_yt(json.loads(m.group(1)))[:8]
        except Exception as e:  # noqa: BLE001
            log.warning("youtube search failed: %s", e)
        if out:
            if len(self.yt_cache) > 64:
                self.yt_cache.clear()
            self.yt_cache[q] = (time.monotonic(), out)
        return out

    # ------------------------------------------------------------------ Gemini
    def system_prompt(self):
        lines = []
        states = self.b.states()
        for eid, ent in self.b.cfg["entities"].items():
            if eid.startswith("camera.") or eid.startswith("weather."):
                continue
            st = states.get(eid) or {}
            a = st.get("a") or {}
            extra = ""
            if eid.startswith("climate.") and a.get("temperature") is not None:
                extra = f",設定 {a.get('temperature')}°(範圍 {a.get('min_temp', 16)}–{a.get('max_temp', 30)})"
            if eid.startswith("sensor.") and a.get("unit_of_measurement"):
                extra = a["unit_of_measurement"]
            svcs = ", ".join(ent.get("services") or []) if self.operable(eid) else "只能查狀態"
            lines.append(f"- {ent.get('name', eid)} | {eid} | 狀態 {st.get('s', '不明')}{extra} | 可用:{svcs}")
        now = time.strftime("%Y-%m-%d %H:%M")
        return (
            "你是客廳 LG 電視上的「貓咪首頁」AI 助手。使用者用遙控器打字或語音輸入(可能有錯字或同音字)。\n"
            "一律用繁體中文(台灣用語)回答,1–2 句,口語、簡短。\n"
            "你能做兩件事:\n"
            "1. 控制/查詢家裡裝置:只能用下面清單的 entity_id 與列出的 service;清單已有目前狀態,簡單問題可直接回答。"
            "車庫鐵門為了安全不能操作,只能回報狀態並請使用者用首頁的按鈕。不確定指哪個裝置時(例如只說「冷氣」),優先客廳的。\n"
            "2. YouTube:要「播放/放/看」某影片時,先 youtube_search,再對最符合的一筆呼叫 play_youtube;"
            "只說「搜尋/找/有哪些」時只搜尋,不要播放,回答說結果在畫面上可以用遙控器選。\n"
            "不要編造狀態或影片;工具失敗就照實說。做完後簡短說明做了什麼。\n"
            f"現在時間 {now}。裝置清單(名稱 | entity_id | 狀態 | 可用):\n" + "\n".join(lines)
        )

    async def _post(self, model, body):
        async with self._sess().post(GEMINI_URL.format(model=model), json=body,
                                     headers={"x-goog-api-key": self.key, "content-type": "application/json"},
                                     timeout=aiohttp.ClientTimeout(total=10)) as r:
            if r.status != 200:
                txt = (await r.text())[:200]
                raise RuntimeError(f"{model} HTTP {r.status}: {txt}")
            return await r.json()

    async def run_gemini(self, text, ctx):
        contents = [{"role": "user", "parts": [{"text": text}]}]
        base = {"systemInstruction": {"parts": [{"text": self.system_prompt()}]}, "tools": TOOLS,
                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 512}}
        model, errors = None, []
        for step in range(5):
            body = dict(base, contents=contents)
            if model is None:  # first turn: try the models in order, then stick with the one that answered
                order = ([self.good_model] if self.good_model in self.models else []) + [m for m in self.models if m != self.good_model]
                for m in order:
                    try:
                        resp = await self._post(m, body)
                        model = self.good_model = m
                        break
                    except Exception as e:  # noqa: BLE001
                        errors.append(str(e)[:120])
                if model is None:
                    raise RuntimeError("; ".join(errors) or "no model")
            else:
                resp = await self._post(model, body)
            cand = (resp.get("candidates") or [{}])[0]
            content = cand.get("content") or {}
            parts = content.get("parts") or []
            calls = [p["functionCall"] for p in parts if "functionCall" in p]
            if not calls:
                reply = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
                return (reply[:300] or "好了。"), model
            contents.append({"role": "model", "parts": parts})  # keep thought signatures as sent
            rparts = []
            for c in calls[:4]:
                res = await self.run_tool(c.get("name"), c.get("args") or {}, ctx)
                fr = {"name": c.get("name"), "response": res}
                if c.get("id"):
                    fr["id"] = c["id"]
                rparts.append({"functionResponse": fr})
            contents.append({"role": "user", "parts": rparts})
        return "好了。", model

    # ------------------------------------------------------------------ rule-based fallback (offline / no key)
    def _find(self, text, domain):
        ids = [e for e in self.b.cfg["entities"] if e.startswith(domain + ".")]
        best = None
        for e in ids:
            n = self._name(e)
            cands = [n, n.replace("冷氣", ""), n.replace("燈", "")]
            for c in cands:
                if c and c in text and (best is None or len(c) > best[1]):
                    best = (e, len(c))
        return best[0] if best else None

    async def run_rules(self, text, ctx):
        t = text.replace(" ", "")
        question = bool(re.search(r"嗎|呢|\?|？|有沒有|是不是|狀態|幾度|多少|怎樣|如何", t))
        off = "關" in t and not re.search(r"關著|關了嗎", t) or "熄" in t
        on = not off and ("開" in t or "打開" in t or "亮" in t)
        ents = self.b.cfg["entities"]

        if re.search(r"車庫|鐵門", t):
            g = (self.b.cfg.get("ui") or {}).get("garage") or next((e for e in ents if e.startswith("cover.")), None)
            st = g and self._state(g)
            s = STATE_ZH.get(st["s"], st["s"]) if st else "不明"
            if not question and (on or off or "開" in t):
                return f"為了安全,我不能開關車庫鐵門,請用首頁的車庫按鈕。目前是{s}。"
            return f"車庫鐵門目前{s}。"

        if "冷氣" in t:
            eid = self._find(t, "climate") or (self.b.cfg.get("ui") or {}).get("acs", [None])[0]
            if not eid:
                return "找不到冷氣。"
            name, st = self._name(eid), self._state(eid)
            m = re.search(r"([0-9]{2}|[二兩三廿十][十]?[一二三四五六七八九]?)\s*度", t)
            if m and not question and cn_number(m.group(1)) is not None:
                temp = cn_number(m.group(1))
                if st and st["s"] == "off":
                    await self.t_ha_action(ctx, eid, "climate.turn_on")
                r = await self.t_ha_action(ctx, eid, "climate.set_temperature", {"temperature": temp})
                return f"{name}設定到 {temp} 度。" if r.get("ok") else f"沒辦法設定:{r.get('error')}"
            if question or not (on or off):
                if not st:
                    return f"{name}目前沒有狀態。"
                temp = st["a"].get("temperature")
                if st["s"] == "off":
                    return f"{name}現在是關的。"
                return f"{name}開著({STATE_ZH.get(st['s'], st['s'])}),設定 {temp} 度。"
            r = await self.t_ha_action(ctx, eid, "climate.turn_on" if on else "climate.turn_off")
            return (f"好,{name}{'開' if on else '關'}了。" if r.get("ok") and not r.get("note") else
                    f"{name}本來就是{'開' if on else '關'}的。" if r.get("ok") else f"沒辦法:{r.get('error')}")

        if "燈" in t:
            lights = [e for e in ents if e.startswith("light.")]
            eid = self._find(t, "light")
            targets = lights if (eid is None and re.search(r"全部|所有|每", t)) else [eid or ((self.b.cfg.get("ui") or {}).get("lights") or lights or [None])[0]]
            targets = [e for e in targets if e]
            if not targets:
                return "找不到燈。"
            if question or not (on or off):
                return "、".join(f"{self._name(e)}{STATE_ZH.get((self._state(e) or {}).get('s'), '不明')}" for e in targets) + "。"
            changed, same, bad = [], [], []
            for e in targets:
                r = await self.t_ha_action(ctx, e, "light.turn_on" if on else "light.turn_off")
                (bad if not r.get("ok") else same if r.get("note") else changed).append(self._name(e))
            w = "開" if on else "關"
            parts = ([f"好,{'、'.join(changed)}{w}了"] if changed else []) + ([f"{'、'.join(same)}本來就是{w}的"] if same else [])                 + ([f"{'、'.join(bad)}沒辦法控制"] if bad else [])
            return ",".join(parts) + "。"

        if re.search(r"掃地", t):
            v = (self.b.cfg.get("ui") or {}).get("vacuum")
            st = v and self._state(v)
            return f"掃地機{STATE_ZH.get(st['s'], st['s'])}。" if st else "掃地機沒有狀態。"

        if re.search(r"室內|溫度|濕度|幾度|多熱|多冷", t):
            u = self.b.cfg.get("ui") or {}
            tt, hh = self._state(u.get("indoor_temp")), self._state(u.get("indoor_hum"))
            if tt:
                return f"室內 {tt['s']} 度" + (f",濕度 {hh['s']}%。" if hh else "。")

        m = re.match(r"^(?:請|幫我|我想|我要)*(播放|播|放|看|搜尋|搜|找|查)(?:一下|一些|個|點)?(.+?)(?:的影片|影片|給我看)?[。!！]?$", t)
        if m and m.group(2):
            verb, q = m.group(1), m.group(2).strip()
            r = await self.t_youtube_search(ctx, q)
            if not r.get("ok"):
                return f"YouTube 搜尋「{q}」失敗,請稍後再試。"
            if verb in ("播放", "播", "放", "看"):
                first = ctx["results"][0]
                await self.t_play_youtube(ctx, first["videoId"], first["title"])
                return f"幫你播放「{first['title'][:30]}」。"
            return f"找到 {len(ctx['results'])} 部「{q}」的影片,用遙控器選一部。"

        return "我可以開關燈、調冷氣、查車庫門,或找 YouTube 影片。例如「客廳冷氣調到 26 度」「播放貓咪影片」。"


def parse_yt(data):
    """ytInitialData -> [{videoId, title, channel, duration}] (videoRenderer items, in page order)."""
    out, seen = [], set()

    def text(o):
        if not isinstance(o, dict):
            return ""
        return o.get("simpleText") or "".join(r.get("text", "") for r in o.get("runs", []))

    def walk(o):
        if len(out) >= 12:
            return
        if isinstance(o, dict):
            v = o.get("videoRenderer")
            if isinstance(v, dict) and v.get("videoId") and v["videoId"] not in seen:
                seen.add(v["videoId"])
                out.append({"videoId": v["videoId"], "title": text(v.get("title"))[:120],
                            "channel": text(v.get("ownerText") or v.get("longBylineText"))[:60],
                            "duration": text(v.get("lengthText")) or "直播"})
                return
            for x in o.values():
                walk(x)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(data)
    return out
