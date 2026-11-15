# cats/real — 擬真風(black kitten + tabby coat)

Procedural real-time kitten peeking over a chunky knitted blanket on a sofa arm, in a dim out-of-focus living room
(art target `dev/ref/gen/real_a.png`, tabby target `dev/ref/gen/real_tabby_a.png`). Everything is generated in code:
there are no downloads, no image assets, and no post-processing pass.

## How it is built
- **Sculpt (`sdf.js`)**: the head, body and paw are signed-distance fields (ellipsoids/capsules joined with smooth-min,
  plus nostrils, philtrum, mouth line and a gentle eye recess). A "star mesher" pushes cube-sphere vertices along rays
  until they hit the surface. That gives even triangles, per-face UVs for the fur strands, SDF-gradient normals and
  baked AO from the field.
- **Fur (`shaders.js` FUR_*)**: an opaque base layer plus N instanced shells in **one draw call per part**
  (`InstancedBufferGeometry`, `shell` = height). Shells use alpha-to-coverage (MSAA, no sorting). The coverage is two
  procedural strand layers (guard hairs plus a denser undercoat) with clumping toward clump centres.
  - The comb direction is a per-vertex flow field: it radiates back from the nose, runs down the cheeks and along the
    body, and runs toward the tip on the tail and toward the toes on the paw.
  - Length varies by region: very short on the muzzle and nose bridge, bare at the nose leather and lid edge, a cheek
    ruff, and a longer throat and tail.
  - Shading is Kajiya-Kay with two shifted lobes, per-strand spec and colour variation, darker roots (self-shadow by
    shell height), a wrap key, a warm rim/back-scatter and a hemisphere ambient.
  - Follow-through: the fur tips lag head rotation (`uLag`).
- **Eyes**: one sphere per eye.
  - The fragment shader refracts the view ray into the anterior chamber and draws the iris on a recessed plane, so it
    shows parallax and depth. The iris has fibrous noise, a collarette and a dark limbal ring.
  - The pupil is a slit-to-oval shape driven by light and mood.
  - Light focuses as a caustic on the side of the iris away from the key light.
  - The cornea shows a window-shaped reflection, a warm lamp glint and Fresnel.
  - The **eyelids are analytic**: an almond opening in the socket frame, independent of eyeball rotation. The lid
    region is shaded as short dark fur with a black margin and a wet lower rim, and the lid casts a shadow on the
    upper iris. Blinks animate the lid edges, not the eyeball.
- **Whiskers / hairs**: camera-facing tapered ribbons, built in the vertex shader. Each ribbon is at least 1.1 px wide
  and its alpha is scaled by its true pixel width, so it stays thin and anti-aliased. There are 12 whisker-pad
  whiskers per side, 4 brow and 2 cheek whiskers per side, pale inner-ear tufts, and stray guard hairs that catch the
  rim light. They sway, and lag the breathing.
- **Tail**: a joint chain (14 joints on desktop, 10 on tv) is computed on the CPU each frame. A Catmull-Rom tube is
  built from it in the vertex shader, and the same shader drives the shells. The motion layers:
  - a base-to-tip travelling wave (the tip lags);
  - seeded value-noise drift;
  - occasional tip flicks with a decaying envelope.
- **Blanket**: a displaced grid over a rounded sofa-arm profile, using a procedural knit tile (DataTexture: stockinette
  V legs with plied yarn and fibre noise).
  - It has a normal map, a heather tint, slight UV wobble for irregular stitches, and a wool fuzz sheen.
  - Wool fuzz shells: 3 on desktop, 0 on tv.
  - Soft contact occlusion and key-light shadows come from analytic spheres (paw, chin, body).
  - It darkens toward the bottom of the frame.
- **Backdrop**: a pre-blurred canvas room (dim warm-grey wall, sofa cushions to the right, a dark armchair on the left)
  plus a separate lamp layer (warm shade bokeh at far right, below the side panel). Their gains vary with `setHour`.
  The vignette is computed inside each shader from `gl_FragCoord`, so it costs no extra pass and also stays correct
  in `zoom=` views.
- **Tabby (`coat: 'tabby'`)**: the same geometry, rig and animation. A `TABBY` define switches the fur albedo to:
  - agouti ticking (grey root, warm buff band, dark tip, varying per strand);
  - procedural masks in each part's rest-pose space:
    - head: forehead stripes and the "M", a dark line behind each eye, cheek bands, whisker-pad spots, white chin and
      lower muzzle;
    - body: mackerel bands;
    - tail: rings and a dark tip;
    - paw: buff with faint stripes;
    - ears: dark rim and tip.
  - pale-green iris, brick-pink nose with a darker edge, pinkish inner ears with paler hairs, and fur about 22% shorter
    on the head (adult shorthair).

## API (all deterministic: only `dt`, `t` and `seed`)
- `setGaze(x,y)`: unprojects the screen point onto a plane between the cat and the viewer. The eyes snap there
  (τ≈45 ms), the head follows late (τ≈0.5 s, up to about 60% of the angle), and the ears turn toward the gaze.
  `setGaze(null)` returns to idle looking: a new target every 1.5–4 s, 40% of the time at the viewer.
- `setMood('awake'|'sleepy'|'alert')`:
  - sleepy: heavy lids, mostly slow blinks, head lower, slower breathing and tail, ears out, a yawn every 25–55 s;
  - alert: lids wide, pupils dilated, ears forward, livelier tail.
- `setHour(h)`: blends three presets.
  - Day (07:30–16): cool window key, bright wall, lamp off, slit pupils.
  - Evening (18:30–21:30, also the default): neutral key, warm lamp rim and bokeh. This matches the art target.
  - Night (23:30–05:30): blue moonlight, dim lamp, dark wall, round pupils.
- `poke(kind)`:
  - `blink`;
  - `earTwitch` (both ears, staggered);
  - `tailFlick`;
  - `pawTap` (a lift and press, sometimes a double);
  - `yawn`: the head tips back, the eyes squeeze shut and the ears go back. **There is no open mouth**; see the known
    weaknesses below.
- Idle behaviour:
  - blinks every 2.5–7 s, with 20% double blinks and occasional slow blinks;
  - independent ear twitches every 4–12 s;
  - breathing at 0.42–0.58 Hz;
  - small head tilt and nod noise, plus a curious head tilt every 9–23 s;
  - a rare paw tap every 20–50 s.
- `update()` allocates nothing (preallocated vectors, uniform objects updated in place). JS time is about 0.05–0.1 ms
  per frame.
- Dev-only `dbg=` URL flags (`noshell`, `nofuzz`, `noknit`, `nocat`) hide parts for cost measurements. They are read
  once at build time and ignored otherwise.

## Tunables (top of `index.js`)
- `Q.desktop` / `Q.tv`: mesh resolutions, shell counts per part, tail joints, stray-hair and ear-hair counts, texture
  sizes, blanket fuzz shells.
- `EYE`, `ER`: eye position and size. `headSdf` / `headAttr`: proportions, fur length and flow. `EAR`: ear size.
- `FUR` per coat: colours (root, tip, spec, iris, nose, ear skin). `HOURS`: light presets.
- Shader constants: `uDensity` (strands per unit), `uCombK` (how flat the fur lies), `uFurScale`, `uSpecK`.

## Measured (this laptop, GTX 1660 Ti, `bench=120`)
| | tv 1280×720 | desktop 1920×1080 |
|---|---|---|
| bench ms/frame | 2.45–3.94 (5 runs, black); 3.03 (tabby) | 6.18–6.40 (black); 8.30 (tabby, 1 run) |
| draw calls | 20 | 21 |
| triangles/frame | 214,042 | 1,380,678 |
| fur shells on the cat | head 12, tail 10, paw 8, body 6, ears 5 (max 12) | head 32, tail 24, paw 22, body 18, ears 10 (max 32) |
| blanket shells | 0 | 3 |
| init | 1.2–1.9 s | 1.3–2.4 s |
| update JS | ≈0.05 ms | ≈0.07 ms |
| texture memory | ≈4 MB (2 backdrop canvases + 2 × 256² knit maps) | ≈6 MB |

No shadow maps and no render targets on either quality. Bench noise on this laptop is large (±0.7 ms between
identical runs). The tv number stays under 4.0 ms but without much margin. If the TV turns out slower:
- drop head shells from 12 to 10;
- use `headBase` 24;
- cut stray hairs.

## Known weaknesses (honest)
- It reads as a convincing **CG** kitten at 3 m, not as footage. The shell fur makes stippled halos at the silhouettes
  (there are no fins), and the very short muzzle fur dithers with alpha-to-coverage up close.
- **Yawn has no mouth**: the head mesh is closed. A jaw (discarding the stretched band along the lip line plus a
  back-faced mouth cavity) is the next step.
- The paw is a soft mitten: the toes are only weakly separated and the claws are tiny cones. The forearm/leg connection
  is hidden by the blanket rather than modelled.
- The inner ear is flat skin with hair ribbons; there are no cartilage folds. The tabby ears look slightly too pink and
  smooth.
- The knit is still a little too regular next to the hand-knit reference, and its fuzz halo is subtle (none on tv).
- The tabby pattern is mask-based. The stripes are plausible, but they do not follow the real anatomy of a mackerel
  coat on the body, and the tabby tail halo looks a bit frayed.
- The eye shape is fixed apart from blinks: the lids do not squint with the cheeks.

## Files
- `index.js`: meta, scene assembly, rig, animation and API.
- `sdf.js`: SDF primitives, star mesher, `hit()` ray-march, seeded RNG and 1D noise.
- `shaders.js`: fur, eye, strand, knit, backdrop and simple glossy materials, with a shared light rig.
- `textures.js`: backdrop canvases (room + lamp) and the knit normal/height + albedo DataTextures.
- `dev/probe.html`: a one-off GPU fill-rate probe.

## Commands (from the repo root, one at a time)
```
node dev/shot.mjs dev/shots/real/final_clean.png "dev/cat.html?style=real&t=2.2"
node dev/shot.mjs dev/shots/real/final_eyes.png  "dev/cat.html?style=real&t=2.2&zoom=0.40,0.34,0.24,0.24"
node dev/shot.mjs dev/shots/real/x.png "dev/cat.html?style=real&coat=tabby&q=tv&bench=120"
```
Work-in-progress shots are in `dev/shots/real/wip/`.
