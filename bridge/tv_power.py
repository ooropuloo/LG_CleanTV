"""TODO (needs the real TV): open the home page when the TV powers on, and SSAP launch.

NOT IMPLEMENTED. Nothing imports this module yet. Design notes (from DECISION.md, 2026-11-15):

* Goal: when the TV turns on, launch our app (com.lgcleantv.home), so the cat home is the first screen.
* Two ways, pick after testing on the TV:
  1. HA's own `webostv` integration: an HA automation on `media_player.<tv>` turning on calls
     `webostv.command` / `media_player.select_source`. No code here, but HA must already be paired.
  2. Our own SSAP client: websocket to wss://<TV_IP>:3001 (self-signed cert), `register` handshake
     with a PERMISSIONS manifest (couch-tv bridge/lg.py `_handshake`/`PERMISSIONS` is the reference,
     MIT, keep "Copyright (c) 2026 Seagey" if adapted). First pairing needs "Accept" on the TV; store
     the client-key in a git-ignored file next to .env (not in the image).
     - Power-on detection: `_watch` loop that polls port 3001 / subscribes to
       `ssap://com.webos.service.tvpower/power/getPowerState`; webOS 26 standby is known to miss the
       wake event (couch-tv issue #89) -> also poll every few seconds and treat "Active" after a gap
       as a power-on.
     - `_hook`: on power-on, if the foreground app is LG home / nothing (couch-tv `NOTHING` regex),
       call `ssap://system.launcher/launch {"id": "com.lgcleantv.home"}`; `_back_to_couch` = same after
       an app exits to the LG home.
* Also the /api/launch fallback in server.py should call `ssap://system.launcher/launch`
  {id, params} here, for when the hosted page has no PalmServiceBridge.
* Must not fight the user: do not relaunch while another app is in the foreground.
"""


async def launch(app_id, params=None):  # pragma: no cover - placeholder
    raise NotImplementedError("SSAP system.launcher/launch: needs TV pairing (see module docstring)")
