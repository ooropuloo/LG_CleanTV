# tv-home scene factory (場景工廠)

Generates new animated TV-home wallpapers ("living images", **v2 packs**) automatically **on the HA host**
(192.168.1.10, aarch64, 4 cores) — no laptop needed. One run = try to produce ONE new scene; a broken scene is
never published (rejecting is fine).

## What runs where
| piece | where | notes |
|---|---|---|
| `run.sh` | host, root crontab | launcher: lock, rate limit, `docker run --rm` with `nice -n 15`, `--cpus=2`, `--memory=700m` |
| image `tvhome-factory` | host Docker | python:3.12-slim + numpy/scipy/opencv-headless (`Dockerfile`); code is **mounted**, not copied: editing a `.py` needs no rebuild |
| `factory.py` + modules | container | the pipeline (below); runs as uid 1000 |
| agy | container (host binary mounted, `~/.gemini` mounted) | image generation + vision (owner's Google Pro quota, free) |
| state | `/opt/tv-home/factory-data/` | `state/status.json`, `state/history.json`, `inbox/` (requests from the TV), `work/r*/` (last 6 runs incl. debug images), `logs/factory.log` |
| output | `/opt/tv-home/cats/gen-live/<id>/` + `cats/gen-live/scenes.json` | style module `cats/gen-live/index.js` loads packs by id with `cats/live/engine2.js` |
| bridge | `tv-home` container | `/api/config` merges `cats/gen-live/scenes.json` on every request; `GET /api/scenes/factory`; `POST /api/scenes/factory/run` writes `inbox/request-*.json` (its only writable mount; no Docker socket) |
| page | `web/` | `wallpaper.js genPick()`: a generated scene may take over a schedule slot; settings sheet section「自動生成場景」 |

## Pipeline (`factory.py run`)
1. **Recipe** (`recipes.json`): subject (owner's tabby / black cat / heroine + tabby) × style (stylised 3D film / photoreal) ×
   theme (yarn, butterfly, snow, Christmas lights, autumn leaves, plants, moon, rainy window, tea, sleeping) × time of day.
   Seasonal themes only in their months; the last 8 recipe keys are skipped and the last 3 themes down-weighted (`state/history.json`).
   Prompt = proven layout text (subject behind a ledge filling the bottom ~27 %, tail separated on the left, eyes open and large,
   top-left third and right 20 % calm) + style + time + theme. Reference images in `refs/` (owner's cat photos, the hand-made
   style images, the heroine) are passed to agy as files ("use as references") — this works: the tabby's markings / heroine's face carry over.
2. **Generate** with agy (~1–3 min, 1376×768 JPEG) → centre-crop 16:9 → Lanczos up to **1672×941** (+ light unsharp).
   Quick composition check of the clock area (brightness / detail).
3. **Check + landmarks**: ONE agy vision call (`landmarks.py`, `gemini-3.8-flash-medium`, fallback `-low`) with the picture and a
   copy with a labelled 0..1000 grid: `usable` + problems (wrong count, closed eyes, extra limbs, text…) and per subject eye boxes,
   nose, chin, head outline, ear tip/base, tail centreline + width, body outline, paws; people: face outline, eyes, hair polygons,
   shoulder/arm lines; the ledge line.
4. **Rig** (`rigbuild.py`): v2 rig for `cats/live/tools/prep_scene.py`. Refinement: eye ellipse = robust fit to the innermost dark
   rim along 36 rays (never larger than 1.08× the agy box; falls back to 0.85× the box), pupil = darkest-pixel centroid, ledge
   snapped to the strongest horizontal edge. Validation (any failure rejects the image): eyes inside the head and ordered, sizes
   plausible, not overlapping; nose below the eyes; ears plausible and pointing up; tail width/length plausible and not over the
   face; ledge within the recipe's height band and roughly horizontal; heads not touching the border / not in the clock area;
   faces of two subjects not overlapping. Face polygon = head outline ×1.05, clipped above the ledge (weight exactly 1 = rigid).
5. **Prep**: `prep_scene.py <work pack>` (headless; `LIVE_DBG` env sends debug images to the run folder), ~15 s.
6. **QA**: `warpqa.py` re-implements engine2's `extremes()` on the CPU from the pack's own `mesh.bin` + motion and renders both
   extreme poses (incl. the eye warp). Rejects on: face not rigid (similarity-fit residual RMS > 0.4 px or p99.5 > 2.5 px),
   visible squash/fold on textured areas > 0.2 %, motion outside the tail > 25 px, tail > 130 px, background drag > 6 %.
   Then an agy review (`gemini-3.8-flash-medium`) of: rig overlay, extreme poses A|B, face close-ups A|rest|B → pass + score ≥ 6.
7. **Publish** (atomic): copy into `cats/gen-live/.tmp-<id>/` (dot folders are never served) → `rename` → rewrite
   `scenes.json` (tmp + rename). Keeps ≤ 30 generated scenes (oldest pruned, entries with `"keep": true` never); hand-made packs are
   never touched (the container sees `cats/` read-only except `cats/gen-live`). An interrupted run leaves at most a `.tmp-*` folder
   or a work folder, cleaned on the next run.

## Triggers
- **Scheduled**: root crontab `30 3 * * 2,5 sh /opt/tv-home/factory/run.sh scheduled` (Tue + Fri 03:30).
- **On demand**: TV settings sheet「自動生成場景 → 立刻生成一張新場景」→ bridge writes `factory-data/inbox/request-<t>.json`
  (allow-listed IPs only, ≤ 3 per 24 h) → root crontab `*/5 * * * * sh …/run.sh watch` starts it within 5 min (host-side limit 4/24 h).
- By hand on the host: `sudo sh /opt/tv-home/factory/run.sh manual [--recipe tabby:film3d:snow:night] [--no-publish]`.
- **Disable**: `touch /opt/tv-home/factory-data/DISABLED` (both cron modes exit at once), or `sudo crontab -e` and delete the
  two `tv-home factory` lines. Remove generated scenes: delete their entries from `cats/gen-live/scenes.json` (folders are cleaned up).
- On the TV: generated scenes join the rotation via `wallpaper_schedule.generated` in `bridge/config.json`
  (`chance` per slot, `new_chance` for scenes ≤ `new_days` old, `recent_days`); delete that key to stop showing them in slots
  (they stay selectable in the settings sheet).

## Disk budget (owner request, host root fs 29 GB shared with HA)
- Before each run: skip with status `disk low` when `/` has < 4 GB free (`FACTORY_MIN_FREE_GB`).
- `cats/gen-live` kept within **30 scenes and 300 MB** (`FACTORY_GEN_MAX_MB`), oldest first; `"keep": true` never; hand-made packs are read-only to the container.
- Every run deletes all work folders (raw image, pack copies, debug images) at start and end; rejected images keep only a 320x180
  thumbnail in `state/rejects/` (last 50) + the JSON in `history.json`. `FACTORY_KEEP_WORK=1` keeps the newest run folder for debugging/recheck.
- `run.sh build` prunes dangling `label=tvhome-factory=1` images + builder cache; `bridge/run.sh` prunes `label=tv-home=1`.
- agy's own folders under `~/.gemini/antigravity-cli/` are cleaned host-wide by `/opt/agy-cleanup.sh` (root cron 04:20, > 2 days; token/config untouched).
- `status.json.disk` = {free_gb, gen_mb, gen_count, work_mb} -> TV settings「主機剩餘空間」. `run.sh cleanup` = housekeeping only.
- First cleanup 2026-11-15 15:12: work folders 73 MB + test folder 15 MB + 7 dangling tv-home/factory images; free space 9.35 GB before
  the rebuilds -> 9.55 GB after rebuild + cleanup (10.0 GB by the factory's own measure of /data).

## Measured (2026-11-15, host aarch64, 4 cores)
| step | time |
|---|---|
| agy image generation | 61–214 s (median ~105 s) |
| agy check + landmarks (flash-medium) | 90–170 s |
| prep_scene.py | 12 s (one cat) / 23 s (girl + cat) |
| warp QA (CPU extremes) | ~5 s |
| agy review | 53–147 s |
| **whole run, first attempt passes** | **249–298 s** (3 attempts worst case ~15 min) |
- Container memory (docker stats every 5 s): 230–440 MiB peak (agy ~250 MiB, numpy prep of a 2-subject scene ~440 MiB); limit 700 MiB.
- Pack size ~1.0 MB (+ 0.37 MB source.jpg kept for re-prep). TV (LG 75QNED81, real device via CDP): **60.0–60.1 rAF/s** on each generated scene.
- Image quota: after ~12 generated images in a few hours agy's `gemini-3.1-flash-image` returned 429 QUOTA_EXHAUSTED (reset ~4–5 h later).
  The factory detects it from agy's own log (`--log-file`), stops the run (`result: quota`, `quota_reset` in status.json), later runs skip
  until the reset, and the TV button answers「額度暫時用完」. Twice a week + a few manual runs is far below that.

## Results so far
Published: `g20261115-140215` 虎斑・熱茶黃昏(寫實) (photoreal, tea, dusk), `g20261115-141005` 虎斑・聖誕燈夜晚 (film-3D, Christmas
lights, night; triggered from the TV button), `g20261115-143217-150118` 女孩與虎斑・熱茶黃昏(寫實) (heroine + tabby; passed after
`recheck` with the fixed reviewer prompt). 8 generated images reached the checks: 2 passed first time, 6 rejected — 1 by the old ear
rule, 1 by the old global ledge band, 3 by reviewer misreadings (table line, soft tint halos, black padding in the face sheet) that the
prompt / sheet now address, 1 legitimately (tail centreline folding back — now the tail is simply not animated). Sleeping-cat path
tested on the hand-made sleep picture (rig + warp QA OK). So the honest first-pass rate today is 2/8; with the fixes ~4–5/8 expected.

## Weak points / limits
- Everything depends on agy (free, but undocumented, slow on the host, image quota ~12 per few hours). If agy changes its output
  behaviour the brain-folder watch in `agyx.py` is the first thing to check.
- Landmarks come from a general vision model: face polygons are a bit loose (grown 5 %), whiskers/paws are not animated (no paw channel,
  no swat in generated scenes), the tail chain is sometimes off-centre (the soft weights hide most of it). Small eyes (< 12 px) are rejected.
- The heroine recipe copies the reference layout closely (variety = clothes, light, props) and her cat sits behind the right panel.
- The reviewer is strict and sometimes wrong (false negatives cost an image; false positives are what the geometric checks are for).
- Pruning is "oldest first" (no like/dislike signal yet). `"keep": true` in scenes.json protects an entry.
- Generated scenes only rotate in when 自動換桌布 is on (the TV currently has it off — scenes are still pickable by hand).

## Maintenance
- `sudo sh run.sh recheck /data/work/r<run>/a<k> [--publish]` — QA + review of a kept attempt again (after changing a prompt/threshold).
- Upload changed code with the files' owner kept (the non-root host user); `run.sh` is read whole by dash (< 8 KB) but replace it atomically anyway.
- Calibration of `warpqa.verdict` thresholds: run `warpqa.check` on the hand-made v2 packs (heroine morning passes; tabby play has a
  big paw swat, so it fails `max_disp` by design).

## Progress (checkpoint log)
- 13:30 started. Design: v2 full-frame-warp packs (prep_scene.py) — no matte/plate, so the failure modes of an
  automatic pipeline are limited to landmark placement, which is validated + checked with an offline warp render.
  Docker image `tvhome-factory` (python:3.12-slim + numpy/scipy/opencv-headless) building on host.
  agy reference-image test running (`/tmp/factory-test/`).
- 14:00 code written: agyx.py (agy wrapper; image found in agy's brain folder because agy often never copies it
  and never exits), landmarks.py (one vision call = check + landmarks on a 0..1000 grid), rigbuild.py (rig v2 +
  eye rim-fit + ledge snap + validation), warpqa.py (CPU re-implementation of engine2 extremes: fold / face
  rigidity / drag / motion), factory.py (orchestrator, history, atomic publish, prune), run.sh (host launcher),
  recipes.json. Bridge: factory_api.py (+ /api/config merge), web: gen-live style, genPick() slot takeover,
  settings section. Calibrated warpqa on the hand-made packs. First real run started 13:58.
  Findings: agy vision with flash-high times out (>200 s); medium 90 s, low 15 s (both usable, medium a bit
  better); agy may run its own python on the image unless told not to (now: --sandbox + "do not run code").
- 14:05 first real run (autumn/dusk tabby): generation 100 s, landmarks OK, eye rim-fit good after switching to the
  innermost-edge rule + 1.08x box cap, prep 12 s, face rigid (rms 0.13 px). Rejected only because ear-tip motion
  (big film-style ears) was counted as body motion -> ears now judged by angle (tip motion / ear length <= 0.22).
  Interrupt path verified (docker kill -> status "interrupted"). Second run started 14:02 with the fixed QA.
  Bridge/web tested in mock mode (settings section renders, no console errors).
- 14:10 **run 2 published** `cats/gen-live/g20261115-140215` (虎斑・熱茶黃昏(寫實), tabby:photo:tea:dusk) in 298 s:
  generate 115 s, landmarks 95 s, prep 12 s, warp QA 5 s, review 69 s (pass, score 9). Peak container memory sampled
  262 MiB. Bridge rebuilt (factory mounts), web + cats/gen-live/index.js deployed, root cron installed. On the real
  TV: scene listed with thumbnail, selected, renders correctly, **60.0 rAF/s**. Pressed「立刻生成一張新場景」on the
  TV -> inbox request written -> cron `watch` picks it up (run 3).
- 14:17 **run 3 published** via the TV button + cron `watch` (manual trigger end-to-end): `cats/gen-live/g20261115-141005`
  (虎斑・聖誕燈夜晚, film3d xmas night) in 249 s, review score 9. On the TV: 60.1 rAF/s. Composition note: the cat sat
  right of centre (head x 0.48–0.83, right ear/cheek under the 家裡控制 panel) -> prompt now asks for a centred head
  (<= 35 % wide) and rigbuild rejects head centre outside 0.36–0.62 W or right edge > 0.80 W. Tail prompt moved to
  ~1/4 from the left (was under the info card). Heroine recipe test run started 14:14.
- 14:27 heroine recipe test: the image keeps her face well (agy follows the reference closely — layout is almost
  the reference's, only clothes/light/props change). Person rig OK (face rms 0.001 px, cat 0.07 px). Rejections seen:
  ledge band check was global 0.55–0.88 (table at 0.89) -> now per recipe; reviewer misread the table line
  (false negative) -> review prompt explains the table case; clock area too bright on a sunny picture (lum 0.475)
  -> threshold 0.42 (hand-made scenes <= 0.31) and the person prompt asks for a shadowed top-left.
- 14:55 heroine published via `recheck` after the reviewer-prompt fix; image quota hit at 14:41 (detection + skip
  implemented and tested: `run.sh test` -> rc 4 "quota still exhausted"); sleep path tested on the hand-made sleep
  picture with `FACTORY_FROM_IMAGE`; TV state restored (自動換桌布 關, 寫實・虎斑) after checking `genPick` on the TV
  (`__home.setTime('19:05')` with auto on -> `why: generated`).
- 15:15 disk budget implemented and tested (disk-low skip rc 5, cleanup, gen-live count+size prune, rejects thumbs,
  image prune by label); factory no longer cleans agy folders itself (host script). Sleep path passes after the
  "tail lies on the ledge -> static tail" rule; the published heroine pack was re-rigged with that rule (its tail
  tore the table edge at extreme pose) and republished as g20261115-143217-150118. SKILL.md section rewritten.
