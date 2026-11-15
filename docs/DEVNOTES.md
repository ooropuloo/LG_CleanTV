> 開發筆記(英文,原作者開發過程的紀錄與量測)。IP / 實體 id 都已換成範例值。新使用者請先看根目錄的 `README.md`。

# tv-home — 貓咪首頁 for the LG TV (75QNED81SRA, webOS 26)

Architecture and platform facts: `DECISION.md`. Cat scene contract: `cats/README.md`.

```
TV: lg/ app (.ipk, Developer Mode) ── boot page probes the bridge ──> redirects to http://<host>:8790/
Host (192.168.1.10): bridge/ container ── serves web/, cats/, vendor/ ── proxies a whitelisted slice of HA (token stays here)
```

## Legacy mode — the second, older TV (2026-11-15, done + tested on the TV against a mock bridge, not deployed)
TV2 = LG 55UK6540PWD (2018, board LM18A), **webOS 4.4.3**, wired **192.168.1.51**, 4K panel (page 1920×1080 @ dpr 2), browser **Chrome 53** (no ES modules, no `?.`/`??`/object spread, no WebGL2, no CSS grid/flex-gap/inset/backdrop-filter). Same app `com.lgcleantv.home` (no-ACG 0.1.1) → `http://192.168.1.10:8790/?tv=1`.
- **Loader** (`web/index.html`, inline ES5): `'noModule' in script && WebGL2RenderingContext` → module `app.js` (TV1 unchanged), else `legacy/legacy.css` + `legacy/app.legacy.js`. `?legacy=1` / `?legacy=0` force; `window.__legacy`.
- **Bundle**: `node dev/build_legacy.mjs` (esbuild 0.25 from the repo devDependencies — `npm install` once — or `ESBUILD_DIR`) bundles `web/legacy/entry.js` = `polyfills.js` + the **unchanged** `web/app.js`/nav/assist/icons/launch/wallpaper, target chrome53 (async → generators, spread → helpers), with `./cat.js` swapped for `web/legacy/videocat.js`. `--check` fails if `app.legacy.js` is stale → **rebuild after every change to web/*.js** (also the other builders' changes to `wallpaper.js`). `legacy.css` (only `body.legacy`): flex-gap → margins, grid → wrap, `inset` → edges, no backdrop-filter / blur / big shadows, focus ring = box-shadow, **no tile transition** (nav 33 → 53 fps on TV2).
- **Background = loop videos**: `node dev/record_loop.mjs [sceneId…] [--crf 22]` renders each scene of `bridge/config.json` in headless Chrome (`dev/record.html`, fixed 1/30 s step, seed 1, gaze free, baked hour/mood per scene), picks the loop length in 24–36 s whose last 1.5 s best match the first, crossfades them (seamless wrap), encodes 1920×1080 30 fps H.264 main 4.0, **fragmented MP4**, + poster JPEG (= first frame) → `cats/video/<scene>.mp4|.jpg` + `cats/video/index.json`. 8 scenes, 53 MB, 1.1–2.6 Mbps (~3 min per scene). New scene → run the recorder for it; generated (`gen-live`) scenes without a video show their `image.jpg` still.
- **Playback** (`videocat.js`): one `<video>`; **MediaSource endless loop** (the fMP4 appended again with growing `timestampOffset`, old data removed) because a native `<video loop>` on webOS 4.4 **freezes ~1.5 s at every wrap** (measured). Scene switch: the new poster fades in over the old video (1.4 s), then the video is replaced underneath. Watchdog: frozen ≥ 30 s or > 25 % dropped → still image. `?bg=still`, `?bg=video`, `?mse=0`. Cat gaze/swat/mood are not available (baked video; `canSwat` false).
- **Measured on TV2** (mock bridge on the PC): video 30 fps, `webkitDroppedFrameCount` 0 of 2021 decoded (MSE), no loop freeze; page 59 fps idle, ~53 fps while navigating, key → paint ~30 ms; nav incl. HDMI group, Back 461, colour keys (scene switch), settings sheet (8 thumbs), garage confirm, light toggle `/api/call` from .39, C400 viewer, C425 snapshot, AI overlay → LG keyboard pops up → results cards (no auto-play). Launch via `PalmServiceBridge` `applicationManager/launch` works (YouTube `youtube.leanback.v4` opened from the tile; our app is closed by webOS). Shots: `dev/shots/home/tv2_legacy_home.png` (taken with `?bg=still`), `tv2_legacy_assist.png`.
- **Bridge**: `allow_call_from` += `192.168.1.51`. Static handler already serves `video/mp4` with HTTP Range (aiohttp `FileResponse`: 206 + `Accept-Ranges`), no code change.
- **Deploy (coordinator)**: copy `web/index.html`, `web/legacy/` (all 5 files), `cats/video/` (17 files), `bridge/config.json` (restart bridge: `sudo sh bridge/run.sh`). Dev-only: `dev/build_legacy.mjs`, `dev/record.html`, `dev/record_loop.mjs`, `dev/tvcdp.mjs`.
- Open: deep-linked YouTube **video** actually playing on TV2 and the HA browser / Netflix / Prime ids not seen on screen (no screen capture on webOS 4.4: `listLaunchPoints`, `getForegroundAppInfo` denied, `capture` service absent); CDP screenshots cannot show the video (hardware plane) — owner should glance at the TV once.

## Progress — AI 助手 / 換桌布 / C400 (2026-11-15, done, not deployed)
- DONE + tested in mock: `bridge/assist.py` + `/api/assist`, per-camera snapshot limits, `web/assist.js`, `web/wallpaper.js` (scenes + schedule + crossfade), C400 live viewer. Gemini loop tested against a fake Gemini server only (no key on the dev PC).
- Real TV (via CDP, mock bridge on the PC, TV restored to production afterwards): overlay + LG keyboard, dictation-style insert → auto send, live YouTube search → play deep link → video played; crossfade ~50 fps.
- Shots: `dev/shots/home/assist_open|assist_results|assist_done|schedule|cam_c400.png`.

## AI 助手 (`bridge/assist.py`, `web/assist.js`)
Dock tile「AI 助手」(first tile) or the mic quick button opens an overlay with a big text field.
- **Input (tested on the TV, webOS 26):** `webkitSpeechRecognition` exists but `start()` → `error: not-allowed` (http page, no mic); `navigator.mediaDevices` is undefined. Focusing the `<input>` opens the **LG virtual keyboard** (`PalmSystem.isKeyboardVisible`, `keyboardStateChange` event) — only while the app is *activated* (when the LG screensaver is up, `PalmSystem.isActivated` is false and focus does nothing). Voice = the keyboard's mic key / the remote's mic button while the field is focused (**owner must test by hand**). A multi-character non-IME insert (= dictation) auto-sends after 1.5 s; Enter / 送出 sends; after an answer the field is only highlighted (OK reopens the keyboard) so the keyboard does not cover the results.
- **Brain:** `POST /api/assist {text}` — allow-listed IPs only, `assistant.per_minute` per IP (default 8), text ≤ `assistant.max_text` (200). Gemini REST `generateContent` + function calling, header `x-goog-api-key`, env `GEMINI_API_KEY`, models env `GEMINI_MODELS` (default `gemini-3.5-flash-lite,gemini-flash-lite-latest`, tried in order, last good one first next time), 10 s per call, ≤ 5 tool rounds, 30 s total. No key / all models fail → small rule parser (lights, ACs incl. 「二十六度」, garage state, vacuum, indoor temp, 「播放/搜尋 X」).
- **Tools:** `ha_state`, `ha_action` (same `check_call` as `/api/call`; never: `confirm` entities, `cover.*`, `assistant.deny_entities` → garage door is state-only; `light.turn_on/off` → `light.toggle` only if needed), `youtube_search` (server fetch of `youtube.com/results`, `ytInitialData` parse, 10 min cache; in `--mock` canned results unless `MOCK_YT=live`), `play_youtube` (returns an action).
- **Page:** transcript, reply, ✓ chips, up to 4 result cards (`i.ytimg.com/vi/<id>/mqdefault.jpg`) + 「在 YouTube 裡搜尋」. Play = 2.6 s countdown chip (Back cancels) → `launch('youtube.leanback.v4', {contentTarget: 'https://www.youtube.com/tv?v=<id>'})` — **verified on the TV** (cold and warm start). The search deep link `https://www.youtube.com/tv#/search?q=` is **not verified**.
- Env for deployment: `GEMINI_API_KEY` (required for the AI brain), optional `GEMINI_MODELS`, `ASSIST_PER_MINUTE`. Logs show the text and the tools used, never keys.

## 換桌布: scenes + schedule (`web/wallpaper.js`)
A **scene** = `{id, name, style, coat, params?}` in `config.json` `scenes`: `style` = module folder under `cats/` (exports `createCatScene`), `coat` = pack id inside it, `params` passed to `createCatScene({..., params})` (packs may ignore it). Adding a new living-image pack (new cat action, a new character…) = add the pack folder + one `scenes` entry (+ a schedule entry) — no code change.
`wallpaper_schedule`:
```json
{"mode": "schedule", "entries": [{"from": "06:30", "scene": "pixar-tabby"}, {"from": "18:00", "scene": "real-tabby"}, {"from": "23:00", "scene": "real-black", "days": [0,6]}]}
{"mode": "rotate_daily", "scenes": ["pixar-tabby", "real-black"], "at": "06:00"}
```
(`days` 0 = Sunday; a bare list = mode schedule; an entry may give `style`/`coat` instead of `scene`.) Settings sheet:「背景場景」(all available scenes) and「自動換桌布」開/關 (localStorage, default 開) with today's list, the current row and the next switch. A manual pick while auto is on lasts until the next boundary. Switching crossfades (1.4 s) the new canvas over the frozen old one, then the old WebGL context is released. Test: `?time=2026-11-15T17:59` then `__home.setTime('2026-11-15T18:00')`.

### Random takeovers, manual pin, colour keys (2026-11-15)
`wallpaper_schedule.random` = `[{scene, between: ["07:00","17:00"], chance, min_minutes, max_minutes, max_per_day?, gap_minutes?, days?}]`, `check_minutes` (default 15), optional `seed`. Every check slot inside the window rolls a hash of *(seed, date, rule, slot)* — so a day's plan is reproducible and testable (`randomPlan(cfg, day)` in `web/wallpaper.js`) — and on a hit the scene takes over for a random `min..max` minutes, then the regular schedule returns (no new roll until `gap_minutes` after it). Defaults in config: heroine-morning 07:00–17:00 (chance 0.1, ≤ 2/day), heroine-evening 18:00–23:30 (0.15, ≤ 2/day), 20–45 min, 60 min gap. Today's takeovers are listed in the settings sheet (「隨機」 row).
Priority: 自動換桌布 關 (一直固定) > manual pick (until the next schedule boundary) > random takeover > schedule.
Settings sheet: 「背景場景」 = all scenes as thumbnails (`cats/<style>/<pack>/assets/thumb.jpg`, made by `cats/live/tools/thumbs.py`, or `scene.thumb`), 「固定這個場景」 到下個時段 / 一直固定, 「貓撲圖示」 開/關, and the colour-key legend.
Remote colour keys (webOS keyCodes): **red 403** previous scene, **green 404** 一直固定 the current scene (again = back to auto), **yellow 405** back to automatic, **blue 406** next scene; each shows a toast with the scene name (and until when). homeshot steps: `key:Red|Green|Yellow|Blue`.
Test: `?time=2026-11-15T12:10` → `__home.setTime('2026-11-15T12:16')` = heroine-morning (`__home.wall.why === 'random'`), 12:45 back to the schedule.

### Generated scenes (scene factory, `factory/`, 2026-11-15)
A host-side job (`factory/README.md`) generates new v2 living-image packs with agy (image + vision) twice a week at 03:30 and on demand, rigs + checks them automatically and publishes into `cats/gen-live/<id>/` + `cats/gen-live/scenes.json` (style module `cats/gen-live/index.js`, coat = pack id, per-pack `motion.json`). The bridge merges `scenes.json` into `/api/config` on every request (no restart; new scenes appear on the next page load) and serves `GET /api/scenes/factory` (status) / `POST /api/scenes/factory/run` (request one now; allow-listed IPs, 3/day; it only writes `factory-data/inbox/request-*.json`, a host cron picks it up). Generated scenes have `{gen: true, tod, created}`.
Rotation: `wallpaper_schedule.generated = {chance, new_chance, new_days, recent_days}` — `genPick(cfg, slotStart)` lets a generated scene whose time of day fits take over a regular schedule slot (seeded per slot; morning 5–10 → morning/day, day 10–17 → day/morning/rain, evening 17–23 → dusk/night/rain, night → sleeping-cat scenes only); a scene ≤ `new_days` old wins its first fitting slot with `new_chance`. Random heroine takeovers and manual picks still have priority. Settings sheet「自動生成場景」: latest scene + time, run state, button「立刻生成一張新場景」.
Priority: 自動換桌布 關 (一直固定) > manual pick > random takeover > generated slot takeover > schedule.

### Dock: group tile, ytsearch_play tiles, 貓撲圖示
- An app with `group: [{key, title, label, id}, ...]` (HDMI) is one tile that expands in place into compact sub-tiles while focused (transform/opacity only; left/right moves across, OK opens, collapses when focus leaves).
- `{"action": "ytsearch_play", "query": "...", "min_minutes": 60, "allow_live"?: false}` (壁爐): `GET /api/ytpick?key=<tile>` runs the assistant's YouTube search and picks the first result ≥ min_minutes (cached per tile per day); the page launches YouTube on that video. Add more "playlist" tiles by config only.
- 貓撲圖示: focus resting 1.5 s on a dock tile → `poke('swat', x, y)` (paw swipe toward the tile, eyes locked, ears forward), then the tile wobbles with a claw-mark overlay. Once per dwell, ≥ 6 s apart, off when `sleepy`, when the scene cannot swat (heroine: only ear + gaze; sleeping cat: nothing) or when the setting is 關.

## Cameras
`cameras` = `{key: {entity, name, min_interval_s, battery?, live?, refresh_s?}}` (old `{key: "camera.x"}` still accepted). Rate limit and lock are per camera. C425 garage (battery): manual only, 10 s; failure →「車庫相機在休眠,請稍後再試或用 Tapo App 喚醒」. C400 1F (mains, `ui.live_camera`):「一樓畫面」button in the control panel opens a viewer refreshing ~1.5 s, paused while the page is hidden, stopped when closed. `MOCK_CAM_FAIL=1` fakes a sleeping C425.

## Progress (checkpoint 2026-11-15)
- DONE bridge/ (aiohttp): static serving, /api/config|states|events(SSE)|call|snapshot, /api/launch 501 stub, `--mock`, Dockerfile, run.sh. TODO modules `tv_power.py`, `devmode.py`.
- DONE web/: clock/date/weather, status card, quick bar, control panel (lights, garage w/ confirm, 3 ACs), app row, settings sheet (style/coat, localStorage), toast, smoke banner, spatial nav, cat background with fallback.
- DONE lg/: appinfo (+ no-ACG variant), boot page with offline/retry, webos.js shim, pure-Python `build.py` (+ `--list` verification).
- Tested only locally (mock + a fake HA websocket); nothing deployed, the TV never touched.
- NEXT (needs the real TV): see "Open TODOs".

## Run locally (mock, offline)
```bash
cd LG_CleanTV
pip install -r bridge/requirements.txt
python bridge/server.py --mock                # http://127.0.0.1:8790/
```
`MOCK_SMOKE=1` starts with the smoke alarm on. In a desktop browser: arrows / Enter / Esc or Backspace (= TV Back 461), or the mouse.
Page query params: `q=tv|desktop` (cat quality), `fps=30`, `cat=0` (no background), `time=2026-11-15T21:30` (frozen clock).

Against real HA (read/write through the whitelist!): `HA_URL=http://192.168.1.10:8123 HA_TOKEN=... TV_IP=<tv ip> python bridge/server.py`.

## Tests / screenshots
`node dev/homeshot.mjs [--w 1280 --h 720] step...` starts `bridge --mock` on a random port + one headless Chrome, runs steps
(`key:ArrowUp*3`, `key:Enter`, `key:Back`, `type:<text>`, `until:<js>`, `eval:<js>`, `click:<css>`, `shot:<png>`, `wait:<ms>`), prints `window.__home`, then kills both.
`--no-bridge --url file:///<repo>/lg/app/index.html?bridge=http://127.0.0.1:8798` tests the boot page offline.
Final shots: `dev/shots/home/` (home_1080, home_720, focus_apps, focus_status, confirm_garage, settings, offline).

## Build the .ipk
```bash
python lg/build.py --bridge http://192.168.1.10:8790          # build/lg/com.lgcleantv.home_0.1.0_all.ipk (requiredACG application.launcher)
python lg/build.py --no-acg --version 0.1.1                    # variant without requiredACG
python lg/build.py --list build/lg/com.lgcleantv.home_0.1.0_all.ipk
```
Icons are generated by the script. `--bridge` is baked into `settings.js`; the boot page also accepts `?bridge=` for testing.

## Deploy (later, not done)
1. Host: copy `tv-home/` to the HA host, `cp bridge/.env.example bridge/.env`, fill `HA_TOKEN`, `TV_IP`; `sh bridge/run.sh`
   (`docker run -d --net=host --restart unless-stopped --env-file bridge/.env ...`, web/cats/config mounted read-only).
2. TV: Developer Mode app → `ares-install --device <tv> build/lg/com.lgcleantv.home_0.1.0_all.ipk` (or webOS Dev Manager).
3. On the TV check the "實機要先測" list in DECISION.md.

## Config reference (`bridge/config.json`, path override `TVHOME_CONFIG`)
| key | meaning |
|---|---|
| `port` | default 8790 (env `PORT`, `--port` win) |
| `tv_ip`, `allow_call_from` | IPs allowed to `/api/call` and `/api/snapshot` (env `TV_IP`, `ALLOW_CALL_FROM` add to it). Others can only read states. |
| `ha_browser_url` | target for the "HA 平面圖" tile (`$ha_browser_url` in app params) |
| `styles`, `default_style`, `default_coat` | cat styles tried in order (missing ones are skipped; `_example` is the last fallback) |
| `snapshot_min_interval_s` | default per-camera rate limit (10); per camera `cameras.<key>.min_interval_s` wins |
| `scenes`, `wallpaper_schedule` | background scenes and the schedule (see 換桌布 above) |
| `assistant` | `enabled`, `max_text`, `per_minute`, `deny_entities` |
| `ui` | roles → entity ids: `weather`, `indoor_temp`, `indoor_hum`, `smoke`, `person`, `vacuum`, `garage`, `garage_camera` / `live_camera` (camera keys), `lights[]`, `acs[]` |
| `entities` | the whitelist: `{id: {name, services: ["domain.svc"], confirm}}`. Only these ids are subscribed/served; only these services callable. `confirm: true` → `/api/call` needs `"confirm": true` (409 otherwise). |
| `cameras` | `{key: {entity, name, min_interval_s, battery, live, refresh_s}}` for `/api/snapshot/<key>` (battery cams only on button press) |
| `apps` | app row order: `{key, title, id, params?, icon, color, show?}`; `action: "settings"` opens the sheet; `show: false` hides |

Service data is validated in `server.py` (`SERVICE_DATA`: only `climate.set_temperature {temperature}`, clamped to min/max). Attributes sent to the page are trimmed per domain (`KEEP_ATTRS`; `entity_picture`/tokens never leave the bridge).

## Real HA check (one read-only GET of /api/states, 2026-11-15)
All 12 configured ids exist. Weather is `weather.forecast_home` (met.no). The 3 ACs are SmartIR (IR, assumed state, `current_temperature` null, so only the target is shown). Garage `cover` supports open/close only (no stop).

## Open TODOs (need the real TV)
- `launch()` in the hosted page: does `PalmServiceBridge`/`webOS.service` exist after the redirect to http, with/without `requiredACG`? If not, implement `/api/launch` via SSAP `system.launcher/launch` (`bridge/tv_power.py`). Until then on desktop it shows a toast (501).
- TV power-on → open our app (`bridge/tv_power.py`), Developer Mode daily extend (`bridge/devmode.py`). Not implemented.
- LG screensaver after ~3 min idle; WebGL2/fps of the cat on the TV GPU; cold start time.
- If the bridge dies while the hosted page is open, the page keeps the last states (dot turns red); a reload then shows the browser error page, not the boot page.
