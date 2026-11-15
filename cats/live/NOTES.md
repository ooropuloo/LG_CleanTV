# Living-image cats: `pixar-live` / `real-live`

## Status
All four packs are done; polish pass finished. Owner decisions applied: **no blinking at all** (`poke('blink')` is a no-op and `sleepy` does not close the lids); the **face moves rigidly** (no depth parallax, tiny roll), and "looking" is carried by the eyes and ears. The home page letterboxes the scene to 16:9, so `aspect` is always 16/9 there.

## Files
| path | what |
|---|---|
| `cats/live/engine.js` | shared runtime: loading, shaders, all animation (`createLiveScene`) |
| `cats/pixar-live/index.js`, `cats/real-live/index.js` | `meta` (`coats: ['black','tabby']`) + per-style motion tunables; unknown coat → black |
| `cats/<style>-live/<coat>/rig.json` | hand-placed landmarks (source px) + prep tunables |
| `cats/<style>-live/<coat>/assets/` | `plate.jpg`, `cat.png` (RGBA, cropped, whisker-free), `eyes.png` (eye crop: highlight colour + mask), `whisk.png` (whisker overlay, RGBA), `mesh.bin`, `pack.json` |
| `cats/live/tools/prep.py <style> <coat>` | offline prep (deterministic; ~20 s each) |
| `cats/live/tools/look.py` | crop/zoom with a pixel grid, for placing landmarks |
| `cats/live/tools/finals.sh <style> <coat>` | the final screenshots, one at a time (`EYEZOOM=x,y,w,h` env) |

## Prep pipeline (`prep.py`)
- **Contact line**: blanket mask (gray > T, blue > red + k, below `ymin`), first solid row per column. Upward spikes against a wide median are rejected (light rim fur passes the colour test). Then median → min (upper envelope) → smooth. `bridge` ranges are linearly interpolated (use one under the paw, so the paw's lower half stays in the original pixels).
- **Matte**:
  - `kind: gradient` (Pixar): fit a degree-4 polynomial to the backdrop, then α = smoothstep(t0, t1, |src − B|). Keep components touching the landmark hull, fill holes, and fill interior gaps with a closed-then-eroded solid mask (dark fur next to blue rim light matches the backdrop colour).
  - `kind: inpaint` (real): grabCut seeded with a face ellipse, ear spines (extended a bit past the tip so dark tufts come along), the tail centreline, the paw core and optional `fgPolys`. Then B = push-pull fill of the background outside the dilated mask, plus grain. α = max(guided filter of the hard mask, difference matte in a thin band).
  - **Whiskers**: white top-hat inside `whiskerBoxes`, away from the eyes and the paw, kept only as long thin components (min-area-rect length ≥ `whiskMinLen` 60 px, mean width ≤ `whiskMaxW` 4 px). They are removed from the cat layer and the plate (push-pull fill under them) and exported as `whisk.png`. Its alpha is the smallest one that reproduces the source exactly with an in-range colour (≥ the whisker mask), so the rest frame is exact.
  - The cat colour is decontaminated with F = (src − (1−α)B)/α and bled outward with push-pull, so bilinear and mip sampling cause no dark fringes. At rest, composite = src exactly.
- **Plate**: `B` inside the matte dilated by `plateGrow` (16 px; covers fur fuzz that would otherwise ghost when the head moves; real packs also use `tailGrow`, a wider fill around the tail for stray fibres), original pixels from 3–7 px above the contact line down. For gradient packs a push-pull of the fit residual is added, so the fill matches the backdrop seamlessly. Cat colour is decontaminated against the actual plate, so the cat fading over original pixels at the contact is exact.
- **Eyes**: specular highlights only (compact, roundish, unsaturated, very bright blobs inside 0.62 of the eye radius: not the sclera crescent or the iris rim) are filled out of the warped layer by push-pull and stored in `eyes.png` with colours solved so the rest frame is exact. They stay put while the iris moves.
- **Weights** (all multiplied by the contact anchor, which is 0 at the contact line and 1 at `anchorBand` px above it):
  - tail: weight plus arc length along the Chaikin-smoothed centreline, and 12 joints resampled by arc length
  - ears: along the base→tip axis with lateral falloff
  - head: blurred landmark hull
  - paw: box falling off toward the contact line
  - whiskers: none in the mesh (they sway in the fragment shader, see below)
  - breathing: body
  - depth proxy: inflated head matte plus a muzzle bump
  - Weights are quantised to uint8 per vertex.
- Debug output goes to `dev/shots/live/_dbg/<style>_<coat>_{matte,rig,plate,depth}.png` (matte over magenta, landmark/weight overlay, plate).

## Runtime (`engine.js`)
- **Vertex shader**, the sum of displacements:
  - tail: a 12-joint FK chain, linear-blend between neighbouring joint frames by arc length
  - ears: rotation about their base
  - head: rigid (owner: no face skew), with a tiny roll about the neck, bob, and a small whole-head shift toward the gaze (`yawShift`, 2–3 px). The depth-parallax path (`yawPx`/`pitchPx`) still exists but is set to 0.
  - paw translation, breathing (vertical stretch from the contact line)
- **Fragment shader**: all texture reads use `textureGrad` with gradients taken once in uniform control flow. Implicit derivatives inside the per-eye branch caused the dotted ring on the eye ellipse.
  - per eye ellipse: iris and pupil shift for gaze with a falloff to identity at the rim (pixel-identical at rest); pupil scale around the pupil centre (anisotropic for slit pupils, `pupilAniso`); highlights re-added unwarped. No eyelids or blinking (owner decision).
  - whisker overlay: each pixel is rotated about its side's muzzle root by an angle ramping from 0 at the root to full at `whiskRamp` px, so tips sway and roots stay put; it composites over the cat.
- **Behaviour**: all from `(t, seed)`; seeded schedulers per channel, no allocation in `update`.
  - saccades every 1.5–4 s (free look: 32% at the viewer); eyes use an exponential follow (~35 ms), the head a 2nd-order spring (the Pixar style is underdamped, so it overshoots)
  - ear twitches every 4–12 s per ear, damped flick plus an occasional second flick; ears turn toward the gaze
  - tail: a travelling wave with phase lag along the tail, amplitude rising toward the tip, frequency and amplitude modulation, slow drift, and tip flicks every 6–14 s
  - curious head tilt every 8–20 s (with anticipation in the Pixar style); breathing ~0.45–0.5 Hz with whiskers lagging; paw knead every 22–45 s
- **API**:
  - `setGaze(x,y)` / `setGaze(null)`
  - `setMood('awake'|'sleepy'|'alert')`: sleepy = slower everything, ears droop, smaller tail motion (lids never close); alert = bigger pupils, faster saccades, ears up
  - `setHour(h)`: day / dawn / dusk / evening / night grade; pupils dilate at night
  - `poke`: `earTwitch` (both ears, staggered), `tailFlick`, `pawTap` (knead), `yawn` (substitute: head lifts back, ears go back, deep breath; no mouth or eyelids). `blink` is accepted and ignored.
- **Dev-only URL flag** read by the engine: `extremes=1` (all deformers pinned at max, side flips every 2 s).

## Tunables
- Motion: `MOTION` in each `index.js`:
  - eye: `eyeShift`, `eyeTau`, `pupilAniso`
  - head: `headHz`/`headZeta`, `yawPx`/`pitchPx`, `roll`/`tilt`/`antic`, `bob`
  - (`blink`, `lash` are unused leftovers)
  - `breath`/`breathHz`, `whisk`
  - `earTwitch`/`earGaze`, `pawPx`
  - tail: `tailAmp`/`tailHz`/`tailLag`/`tailDrift`/`flick`
- Pack (`rig.json`):
  - eyes: `c`, `r`, `rot` (deg), `pupil` (eye units)
  - `anchorBand`, `tailRadius`, `grid`, `matte.*`, `contact.*`
  - A pack can be re-prepped with no code change.

## Measured (this laptop, `bench=120`, after the polish pass)
| pack | tv ms/frame | desktop ms/frame | calls | tris | assets | init |
|---|---|---|---|---|---|---|
| pixar/black | 0.87 | 1.17 | 2 | 28.1k | 1.87 MB | 110–410 ms |
| pixar/tabby | 0.68 | 0.81 | 2 | 28.7k | 2.10 MB | 220–330 ms |
| real/black | 0.64 | 0.70 | 2 | 15.4k | 1.00 MB | ~330 ms |
| real/tabby | 0.63 | 0.67 | 2 | 17.0k | 1.24 MB | ~320 ms |

- An empty scene is ~1.3 ms, so these numbers are noise-level.
- JS `update`: 0.02–0.07 ms.
- Texture memory: ~14 MB per pack.
- No post passes or render targets.
- Rest frame equals the source within JPEG/8-bit error (p99 ≤ 7/255 above the contact line).
- Deterministic: the same URL twice gives a pixel diff of 0.

## Known artifacts / limits
- The eyes only look around (no blinking, by owner decision). Eye ellipses are hand-fitted: the gaze warp falls to identity at the rim, so a slightly small ellipse just makes the iris travel less.
- The head barely turns (rigid face by owner request); attention is shown with the eyes and ears.
- Real packs: the grabCut edges on dark fur against a dark room are a little hard in places. Thin stray fibres outside the matte stay in the plate (e.g. a faint light wisp next to the real tabby's tail tip under extreme tail motion).
- Whisker detection misses faint whiskers over dark fur or background (those stay static) and may include a short fur strand stuck to a whisker. Sway is small (≤ 0.025 rad) so the filled fur under a whisker is never exposed by more than ~1 px.
- The yawn is a substitute (no mouth); `pawTap` is a small knead (3–5 px).

## Preparing a new image
1. Use the same layout: the cat behind a horizontal blanket/ledge, the tail separate from the body with background around it, and a smooth or blurred background. Eyes open, ≥ ~30 px radius at 1672 px width, ideally looking at the camera. Ears not touching the frame edge, and nothing important crossing the eyes.
2. Copy a `rig.json` and set `src`. Place the landmarks with `python cats/live/tools/look.py <img> out.png x0 y0 x1 y1 [scale] [grid] [gamma]`:
   - eyes as the outer rim ellipse with a 2–3 px margin, plus `rot` and `pupil`
   - nose, neck, ear tip/base, tail centreline base→tip, paw box, whisker roots/boxes
3. Run `python cats/live/tools/prep.py <style> <coat>`. Check `_dbg/*_matte.png` (over magenta), `*_rig.png` (yellow = contact line) and `*_plate.png`. Fix holes with `matte.fgPolys`/`bgPolys`, `contact.bridge`, `maxUp` and thresholds.
4. Shoot with `zoom=` (eyes, mouth), `extremes=1`, `sheet=8`, `gaze=0.05,0.92` / `0.95,0.92`; then run `finals.sh`.
- **Gradient backdrops** (Pixar) matte far better than photos. A replacement *real* image would benefit most from a slightly brighter or more separated background behind the black cat, and from eyes a bit larger in frame.

## v2 scenes (multi-subject): `heroine-live` (morning / evening), `tabby-scenes-live` (play / sleep)
A v2 pack is **the whole picture on one full-frame grid mesh** (8 px cells, 25k verts, 49k tris) bent in the vertex shader — no cut-out, no plate. That makes person + cat + window in one image possible and rules out tearing, halos and doubled parts; the cost is that the surroundings stretch a little with each motion, so amplitudes are small and weights are smooth. **1 draw call**, ~0.7 ms/frame at `q=tv` on this laptop, ~1.0–1.3 MB per pack.
- Runtime `cats/live/engine2.js` (`createRigScene`), same contract as v1 (setGaze / setMood / setHour / poke, deterministic). `engine.js` is unchanged except for `export`s of shared helpers and the new `poke('swat', x, y)`.
- Prep `cats/live/tools/prep_scene.py <pack dir>` (imports the helpers of `prep.py`), debug `dev/shots/live/_dbg/<tag>_{rig,aux}.png`.
- **Channels** (≤ 8, attributes aA/aB): each = per-vertex weight × a uniform 2×3 transform computed in JS:
  - `head` (per subject): rigid — the face polygon has weight **exactly 1** (distance-transform falloff only *outside* it, `faceSoft`), roll about `neck` + tiny shift toward the gaze + bob. Owner rule: faces never warp inside.
  - `breath`: person = vertical rise ramping from `y0` (arms on the desk, 0) to `y1` (shoulders, 1) and constant above (the head rides it rigidly); cat = scale about `pivot` with the face excluded, the head follows the neck point (`headRide`).
  - `earL`/`earR`: rotation about the base (as v1, smaller amplitudes).
  - `paw` (bat): weight ramps from `base` (elbow, 0) to `pivot` (wrist, 1) inside the paw polygon; small arc about the wrist; `swat` adds anticipation → swipe toward a tile → recover.
  - `yarn`: rocking about its contact point, kicked after each bat.
- **Tail** (aC.xy): the v1 12-joint FK chain; `baseFade`, optional `mask` polygon. **Hair** (aC.zw): `hair[].poly` × ramp from `root` (0) to `tip` (1) along y, zeroed on the face (`faceGap`) and in `hairExclude` (headphones, the cat's ear); a travelling sine wave whose phase varies across the strands.
- Anchors: `contact.points` polyline (+ `band`), `pins` polygons, and the picture border (24 px) never move. A channel of one subject is zeroed on the *other* subject's face.
- **Eyes** (≤ 4): v1 ellipse warp with per-eye falloff `fall` (people: `[0.55,0.98]`), highlights pulled out into `eyes.png` (thresholds in rig `hl`). No eyelids. People: horizontal only, ~3 px.
- **fx** (`aux.png`, half res: R bokeh mask, G per-blob phase, B rain mask, A lamp mask): rain = sparse procedural streaks sliding down that slightly refract the window; bokeh = per-light slow twinkle (±16 %); lamp = ±3 % glow. `fx.exclude` keeps it off the subjects.
- Grade: `grade` in the rig mixes the hour grade (heroine 0.25–0.3, sleep 0.25, play 0.6), so lit-for-a-time-of-day pictures are only lightly graded.
- No gaze for the sleeping cat (no eyes → `setGaze` no-op); `swat: false` in the rig → `poke('swat')` ignored, `canSwat` false.
- Landmarks were placed with `look.py` crops (all in the rig files) and checked on the `_rig.png` overlays and extremes.

### Measured (this laptop, bench=120)
| scene | tv ms | desktop ms | calls | tris | assets |
|---|---|---|---|---|---|
| heroine-live/morning | 0.75 | 0.74 | 1 | 49.3k | 1.05 MB |
| heroine-live/evening | 0.64 | 0.75 | 1 | 49.3k | 1.05 MB |
| tabby-scenes-live/play | 0.69 | 0.65 | 1 | 49.3k | 1.05 MB |
| tabby-scenes-live/sleep | 0.85 | 0.66 | 1 | 49.3k | 1.02 MB |

JS update 0.04–0.05 ms; init 160–360 ms. **Real TV (CDP, 2026-11-15)**: all four at 60 rAF/s with the 30 fps cap (pixar-tabby the same). The first version ran the full eye loop + aux fetch on every pixel and dropped to 40–47 rAF/s on the PowerVR; the per-pixel work is now limited to `uEyeBox` / `uFxBox` (output unchanged, max diff 1/255).
Face rigidity (`cats/live/tools/rigid_check.py`, close-ups at 6 times aligned with a Euclidean fit): residual after the rigid fit 0.4–1.9/255 mean on the face (eyes move by design); play cat nose+mouth 1.4/255 — see `dev/shots/live2/*_face.txt`.
Regression: the 4 v1 packs re-shot with `finals.sh` are pixel-identical to the earlier finals (26/26; the 2 real `_eyes` shots used a custom EYEZOOM and were restored).

### Known limits (v2)
- The heroine's cat sits at the right edge, partly behind the 家裡控制 panel (composition of the supplied images).
- Human eyes are small (≈ 44 × 20 px): the iris moves ~3 px — subtle on purpose (bigger bends the lids).
- Continuous warp: around the play cat's tail the warm glow in the background is dragged a little at extreme tail poses; the yarn ball top follows the paw by ~1 px during a swat.

## Progress (v2 scenes, 2026-11-15, builder) — checkpoint log
- [x] engine2.js (v2 runtime: full-frame warp, 8 affine channels + tail + hair, 4 eyes, rain/bokeh/lamp fx), engine.js only gained `export`s.
- [x] tools/prep_scene.py (v2 prep, imports helpers from prep.py)
- [x] heroine-live/morning, heroine-live/evening rigs + packs (first pass; need finals)
- [x] tabby-scenes-live play / sleep (rigs + packs), swat poke in engine.js (old packs, no effect unless poked) + engine2.js; bench heroine evening tv 0.70 ms
- [x] swat poke (old engine + v2) + UI dwell/hit, random takeovers (wallpaper.js randomPlan/randomActive), settings thumbnails + 固定, colour keys, HDMI group tile, 壁爐 tile (/api/ytpick) — all checked with homeshot
- [x] finals per scene (`dev/shots/live2/`, script `tools/finals2.sh`), regression diff of old packs, real-TV fps check, docs

## Generated v2 packs (`cats/gen-live/`, 2026-11-15)
The host-side scene factory (`factory/README.md`) makes v2 packs automatically (agy image + agy landmarks → `factory/rigbuild.py` → `prep_scene.py`, headless; `LIVE_DBG` env redirects the debug images). `factory/warpqa.py` is a CPU re-implementation of `engine2.js` `extremes()` (channels, tail chain, hair, eye warp) used as an automatic max-deformation check — keep it in sync if engine2's motion model changes.
