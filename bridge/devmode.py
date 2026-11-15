"""TODO (needs the real TV): keep LG Developer Mode alive (it expires; session is 1000 hours).

NOT IMPLEMENTED. Design notes (from DECISION.md, 2026-11-15):

* Once a day, press "Extend" for the Developer Mode app, equivalent to
      ares-launch --device <tv> com.palmdts.devmode -p '{"extend":true}'
  Options: (a) install @webos-tools/cli in the container and shell out to ares-launch with a device
  entry (ssh key from the TV's Developer Mode app, kept in a git-ignored volume); or (b) over SSAP:
  `ssap://system.launcher/launch {"id":"com.palmdts.devmode","params":{"extend":true}}` (couch-tv
  `extend_devmode_now`), or from inside our app via luna `applicationManager/launch` (lg/app/webos.js
  has a placeholder `extendDevMode`).
* `check_devmode_left`: read the remaining time (devmode app / `ares-device -i`) and log/alert in HA
  when below ~100 hours, so a missed extend never silently uninstalls the home app.
* Only extend while the TV is on; schedule the attempt after the power-on hook (tv_power.py).
"""


async def extend_now():  # pragma: no cover - placeholder
    raise NotImplementedError("Developer Mode extend: needs the real TV (see module docstring)")
