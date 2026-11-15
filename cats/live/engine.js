// Living-image cat engine: one picture brought to life with 2 draw calls.
//   plate quad (picture with the moving parts filled in)  +  cat grid mesh (RGBA cut-out) deformed in the
//   vertex shader by baked weights; eyes (gaze + pupil only; the owner chose no blinking) done in the fragment shader.
// Everything is in SOURCE PIXELS (y down); the meshes are scaled so the picture "cover"-fits the camera.
// Deterministic: all motion comes from (t, seed); update() allocates nothing.
import * as THREE from 'three';

const NJ = 12;
// dev-only: "extremes=1" in the page URL pins every deformer at its maximum (tearing / doubling check)
const EXT = typeof location !== 'undefined' && /[?&]extremes=1/.test(location.search);

const VS = /* glsl */`
#define NJ ${NJ}
uniform vec4 uJ[NJ];      // rest.xy, deformed.xy
uniform float uJA[NJ];    // cumulative rotation of each joint frame
uniform vec4 uHead;       // roll, bob.x, bob.y, -
uniform vec2 uNeck;
uniform vec2 uPar;        // parallax px at depth 1 (head turn)
uniform vec4 uEarL;       // pivot.xy, angle, -
uniform vec4 uEarR;
uniform vec2 uPaw;
uniform vec3 uBreath;     // y0, scaleY, scaleX
attribute vec4 aA;        // tailW, tailS, earL, earR
attribute vec4 aB;        // head, depth, paw, whisker
attribute vec4 aC;        // breath, anchor, -, -
varying vec2 vPx;
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main() {
  vec2 p = position.xy;
  vec2 d = vec2(0.0);
  if (aA.x > 0.002) {
    float s = aA.y * float(NJ - 1);
    int j = int(min(floor(s), float(NJ - 2)));
    float f = s - float(j);
    vec2 pa = uJ[j].zw + rot(p - uJ[j].xy, uJA[j]);
    vec2 pb = uJ[j + 1].zw + rot(p - uJ[j + 1].xy, uJA[j + 1]);
    d += aA.x * (mix(pa, pb, f) - p);
  }
  d += aA.z * (uEarL.xy + rot(p - uEarL.xy, uEarL.z) - p);
  d += aA.w * (uEarR.xy + rot(p - uEarR.xy, uEarR.z) - p);
  d += aB.x * (uNeck + rot(p - uNeck, uHead.x) - p + uHead.yz + aB.y * uPar);
  d += aB.z * uPaw;
  d += aC.x * vec2((p.x - uNeck.x) * uBreath.z, (p.y - uBreath.x) * uBreath.y);
  vPx = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + d, 0.0, 1.0);
}`;

const GRADE = /* glsl */`
uniform vec3 uMul; uniform vec3 uAdd; uniform float uSat;
vec3 grade(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return mix(vec3(l), c, uSat) * uMul + uAdd; }`;

const FS = /* glsl */`
uniform sampler2D uTex; uniform vec4 uCrop;
uniform sampler2D uEyeTex; uniform vec4 uEyeCrop;
uniform sampler2D uWhTex; uniform vec4 uWhCrop;
uniform vec4 uWh;         // whisker roots L.xy, R.xy
uniform vec2 uWhA;        // whisker sway angles L, R
uniform float uNoseX, uWhR;
uniform vec4 uEyeC[2];    // c.xy, r.xy
uniform vec4 uEyeP[2];    // cos, sin, -, -
uniform vec4 uEyeL[2];    // -, -, pupil.xy (eye units)
uniform vec4 uGaze;       // shift.xy (eye units), pupil scale x, y
${GRADE}
varying vec2 vPx;
// All texture reads use explicit gradients taken in uniform control flow: implicit derivatives inside the
// per-eye branches are undefined on pixel quads that straddle the eye boundary (that showed as a dotted ring).
vec2 gX, gY;
vec4 T(vec2 p, float k) { return textureGrad(uTex, (p - uCrop.xy) / uCrop.zw, gX * k / uCrop.zw, gY * k / uCrop.zw); }
vec2 toPx(vec4 C, vec4 P, vec2 q) { vec2 w = q * C.zw; return C.xy + vec2(P.x * w.x - P.y * w.y, P.y * w.x + P.x * w.y); }
vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main() {
  vec2 px = vPx;
  gX = dFdx(px); gY = dFdy(px);
  vec4 c = T(px, 1.0);
  for (int e = 0; e < 2; e++) {
    vec4 C = uEyeC[e], P = uEyeP[e], Lp = uEyeL[e];
    vec2 dv = px - C.xy;
    vec2 q = vec2(P.x * dv.x + P.y * dv.y, -P.y * dv.x + P.x * dv.y) / C.zw;
    float rho = length(q);
    if (rho < 1.0) {
      // eyeball: gaze shift + pupil size; identity at the rim (and at rest), highlights stay unwarped
      float fall = 1.0 - smoothstep(0.45, 0.96, rho);
      vec2 qe = q - uGaze.xy * fall;
      vec2 dq = qe - Lp.zw;
      float fp = 1.0 - smoothstep(0.2, 0.72, length(dq));
      qe = Lp.zw + dq / mix(vec2(1.0), uGaze.zw, fp);
      c = T(toPx(C, P, qe), 1.0);
      vec4 h = textureGrad(uEyeTex, (px - uEyeCrop.xy) / uEyeCrop.zw, gX / uEyeCrop.zw, gY / uEyeCrop.zw);
      c.rgb = mix(c.rgb, h.rgb, h.a);
    }
  }
  // whisker overlay: per-pixel rotation about the muzzle roots, growing with distance (tips sway, roots stay)
  bool wl = px.x < uNoseX;
  vec2 wr = wl ? uWh.xy : uWh.zw;
  float th = (wl ? uWhA.x : uWhA.y) * smoothstep(20.0, uWhR, length(px - wr));
  vec2 wu = (wr + rot2(px - wr, -th) - uWhCrop.xy) / uWhCrop.zw;
  vec4 w = textureGrad(uWhTex, wu, gX / uWhCrop.zw, gY / uWhCrop.zw);
  w.a *= step(0.0, wu.x) * step(0.0, wu.y) * step(wu.x, 1.0) * step(wu.y, 1.0);
  float a2 = w.a + c.a * (1.0 - w.a);
  c = vec4((w.rgb * w.a + c.rgb * c.a * (1.0 - w.a)) / max(a2, 1e-4), a2);
  gl_FragColor = vec4(grade(c.rgb), c.a);
}`;

const PLATE_VS = /* glsl */`
varying vec2 vPx;
void main() { vPx = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0); }`;
const PLATE_FS = /* glsl */`
uniform sampler2D uTex; uniform vec2 uSize;
${GRADE}
varying vec2 vPx;
void main() { gl_FragColor = vec4(grade(texture2D(uTex, vPx / uSize).rgb), 1.0); }`;

// ---------------- helpers ----------------
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sst = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, k) => a + (b - a) * k;

export function loadTex(url) {
  return new Promise((res, rej) => {
    new THREE.TextureLoader().load(url, (t) => {
      t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; res(t);
    }, undefined, () => rej(new Error('texture load failed: ' + url)));
  });
}

// event scheduler: fires at random intervals (seeded stream per channel)
export function Sched(rng, lo, hi, first) { this.rng = rng; this.lo = lo; this.hi = hi; this.next = first; this.start = -1e9; this.k = 0; this.flag = false; }
Sched.prototype.tick = function (t, mul) {
  if (t >= this.next) { this.start = this.next; this.next = this.start + (this.lo + (this.hi - this.lo) * this.rng()) * mul; this.k = this.rng(); this.flag = this.rng() < 0.5; return true; }
  return false;
};
Sched.prototype.fire = function (t) { this.start = t; this.k = this.rng(); this.flag = this.rng() < 0.5; if (this.next < t + this.lo) this.next = t + this.lo; };

// hour grading keyframes [hour, mulR, mulG, mulB, sat, addR, addG, addB, pupil]
export const GRADES = [
  [0, 0.50, 0.56, 0.74, 0.70, 0.000, 0.004, 0.018, 0.22],
  [5, 0.50, 0.56, 0.74, 0.70, 0.000, 0.004, 0.018, 0.22],
  [6.5, 0.92, 0.84, 0.80, 0.90, 0.010, 0.000, 0.000, 0.08],
  [8, 1, 1, 1, 1, 0, 0, 0, 0],
  [16.5, 1, 1, 1, 1, 0, 0, 0, 0],
  [18, 1.04, 0.90, 0.76, 0.95, 0.012, 0.000, 0.000, 0.06],
  [19.5, 0.80, 0.74, 0.78, 0.85, 0.000, 0.000, 0.008, 0.14],
  [21, 0.50, 0.56, 0.74, 0.70, 0.000, 0.004, 0.018, 0.22],
  [24, 0.50, 0.56, 0.74, 0.70, 0.000, 0.004, 0.018, 0.22],
];

export async function createLiveScene({ renderer, quality, aspect, seed = 1, base, motion }) {
  const M = motion;
  const u = (f) => new URL(f, base).href;
  const [pk, bin, catTex, eyeTex, plateTex, whTex] = await Promise.all([
    fetch(u('pack.json')).then((r) => r.json()),
    fetch(u('mesh.bin')).then((r) => r.arrayBuffer()),
    loadTex(u('cat.png')), loadTex(u('eyes.png')), loadTex(u('plate.jpg')), loadTex(u('whisk.png')),
  ]);
  const [W, H] = pk.size;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(30, aspect, 1, 100);
  camera.position.set(0, 0, 10);
  const root = new THREE.Group();
  scene.add(root);
  const VH = 2 * 10 * Math.tan((15 * Math.PI) / 180);
  let k = 1, viewW = W, viewH = H;
  function fit(a) {
    camera.aspect = a; camera.updateProjectionMatrix();
    k = Math.max((VH * a) / W, VH / H);              // world units per source pixel (cover)
    viewW = (VH * a) / k; viewH = VH / k;            // visible source pixels
    root.scale.set(k, -k, 1); root.position.set((-W / 2) * k, (H / 2) * k, 0);
  }
  fit(aspect);

  const gradeU = { uMul: { value: new THREE.Vector3(1, 1, 1) }, uAdd: { value: new THREE.Vector3() }, uSat: { value: 1 } };

  // plate
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, W, 0, 0, 0, H, 0, W, H, 0]), 3));
  pg.setIndex([0, 2, 1, 1, 2, 3]);
  const plateMat = new THREE.ShaderMaterial({
    vertexShader: PLATE_VS, fragmentShader: PLATE_FS, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    uniforms: Object.assign({ uTex: { value: plateTex }, uSize: { value: new THREE.Vector2(W, H) } }, gradeU),
  });
  const plate = new THREE.Mesh(pg, plateMat);
  plate.frustumCulled = false; plate.renderOrder = 0; root.add(plate);

  // cat mesh
  const m = pk.mesh, o = m.offs;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(bin, o.pos, m.nv * 2), 2));
  g.setAttribute('aA', new THREE.BufferAttribute(new Uint8Array(bin, o.A, m.nv * 4), 4, true));
  g.setAttribute('aB', new THREE.BufferAttribute(new Uint8Array(bin, o.B, m.nv * 4), 4, true));
  g.setAttribute('aC', new THREE.BufferAttribute(new Uint8Array(bin, o.C, m.nv * 4), 4, true));
  g.setIndex(new THREE.BufferAttribute(m.idx32 ? new Uint32Array(bin, o.idx, m.ni) : new Uint16Array(bin, o.idx, m.ni), 1));

  const J = pk.tail, eyes = pk.eyes, ears = pk.ears;
  const uJ = new Float32Array(NJ * 4), uJA = new Float32Array(NJ);
  for (let j = 0; j < NJ; j++) { uJ[j * 4] = uJ[j * 4 + 2] = J[j][0]; uJ[j * 4 + 1] = uJ[j * 4 + 3] = J[j][1]; }
  const segX = new Float32Array(NJ), segY = new Float32Array(NJ), delta = new Float32Array(NJ);
  for (let j = 0; j < NJ - 1; j++) { segX[j] = J[j + 1][0] - J[j][0]; segY[j] = J[j + 1][1] - J[j][1]; }
  const eyeC = new Float32Array(8), eyeP = new Float32Array(8), eyeL = new Float32Array(8);
  for (let e = 0; e < 2; e++) {
    const E = eyes[e], a = (E.rot * Math.PI) / 180;
    eyeC.set([E.c[0], E.c[1], E.r[0], E.r[1]], e * 4);
    eyeP.set([Math.cos(a), Math.sin(a), 0, 0], e * 4);
    eyeL.set([0, 0, E.pupil[0], E.pupil[1]], e * 4);
  }
  const U = {
    uJ: { value: uJ }, uJA: { value: uJA },
    uHead: { value: new THREE.Vector4() }, uNeck: { value: new THREE.Vector2(pk.neck[0], pk.neck[1]) },
    uPar: { value: new THREE.Vector2() },
    uEarL: { value: new THREE.Vector4(ears[0].pivot[0], ears[0].pivot[1], 0, 0) },
    uEarR: { value: new THREE.Vector4(ears[1].pivot[0], ears[1].pivot[1], 0, 0) },
    uPaw: { value: new THREE.Vector2() },
    uWh: { value: new THREE.Vector4(pk.whiskerRoots[0][0], pk.whiskerRoots[0][1], pk.whiskerRoots[1][0], pk.whiskerRoots[1][1]) },
    uWhA: { value: new THREE.Vector2() }, uNoseX: { value: pk.nose[0] }, uWhR: { value: pk.whiskRamp },
    uWhTex: { value: whTex }, uWhCrop: { value: new THREE.Vector4(...pk.whiskCrop) },
    uBreath: { value: new THREE.Vector3(pk.contactY, 0, 0) },
    uTex: { value: catTex }, uCrop: { value: new THREE.Vector4(...pk.crop) },
    uEyeTex: { value: eyeTex }, uEyeCrop: { value: new THREE.Vector4(...pk.eyeCrop) },
    uEyeC: { value: eyeC }, uEyeP: { value: eyeP }, uEyeL: { value: eyeL },
    uGaze: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
  const catMat = new THREE.ShaderMaterial({
    vertexShader: VS, fragmentShader: FS, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    uniforms: Object.assign(U, gradeU),
  });
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(W / 2, H / 2, 0), W);
  const cat = new THREE.Mesh(g, catMat);
  cat.frustumCulled = false; cat.renderOrder = 1; root.add(cat);
  // compile now so the first frame does not hitch
  renderer.compile(scene, camera);

  // ---------------- animation state ----------------
  const R = (salt) => mulberry32((seed * 2654435761) ^ (salt * 40503) ^ 0x5bd1e995);
  const rPh = R(1);
  const ph = new Float32Array(16); for (let i = 0; i < 16; i++) ph[i] = rPh() * 6.2832;
  const sSacc = new Sched(R(3), 1.5, 4, 0.6);
  const sEarL = new Sched(R(4), 4, 12, 2 + R(13)() * 4);
  const sEarR = new Sched(R(5), 4, 12, 3.5 + R(14)() * 5);
  const sFlick = new Sched(R(6), 6, 14, 4 + R(15)() * 4);
  const sTilt = new Sched(R(7), 8, 20, 5 + R(16)() * 5);
  const sPaw = new Sched(R(8), 22, 45, 14 + R(17)() * 10);
  const sYawn = new Sched(R(9), 1e9, 1e9, 1e9);
  const rGaze = R(10);

  let gazeFixed = false, gfx = 0.5, gfy = 0.5;
  let tgx = 0, tgy = 0;               // current eye target (normalized -1..1)
  let ex = 0, ey = 0;                 // eye gaze state
  let hx = 0, hy = 0, hvx = 0, hvy = 0; // head follow spring
  let mood = 'awake', mSleepy = 0, mAlert = 0, hour = 12, gHour = -1;
  let tNow = 0;
  let swatT = -1e9, swatX = 0.5, swatY = 0.92;   // poke('swat', x, y): quick paw swipe toward a screen point
  const pawC = [(pk.paw[0] + pk.paw[2]) / 2, (pk.paw[1] + pk.paw[3]) / 2];

  function screenToPx(x, y) { return [W / 2 + (x - 0.5) * viewW, H / 2 + (y - 0.5) * viewH]; }
  function setTargetScreen(x, y) {
    const p = screenToPx(x, y);
    tgx = Math.tanh((p[0] - pk.faceC[0]) / (W * 0.4));
    tgy = Math.tanh((p[1] - pk.faceC[1]) / (H * 0.3));
  }
  function pickFree() {
    const r = rGaze();
    if (r < 0.32) { tgx = (rGaze() - 0.5) * 0.12; tgy = (rGaze() - 0.5) * 0.1; }   // look at the viewer
    else setTargetScreen(0.12 + 0.76 * rGaze(), 0.2 + 0.72 * rGaze());
  }

  function applyHour(h) {
    let i = 0; while (i < GRADES.length - 2 && GRADES[i + 1][0] <= h) i++;
    const a = GRADES[i], b = GRADES[i + 1], f = sst(a[0], b[0], h);
    gradeU.uMul.value.set(lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f));
    gradeU.uSat.value = lerp(a[4], b[4], f);
    gradeU.uAdd.value.set(lerp(a[5], b[5], f), lerp(a[6], b[6], f), lerp(a[7], b[7], f));
    return lerp(a[8], b[8], f);
  }
  let hourPupil = applyHour(12);

  const twitch = (u, A) => (u < 0 || u > 0.9 ? 0 : A * Math.exp(-u * 8) * Math.sin(u * 30));

  function update(dt, t) {
    tNow = t;
    // mood blend
    const kM = 1 - Math.exp(-dt / 0.8);
    mSleepy += ((mood === 'sleepy' ? 1 : 0) - mSleepy) * kM;
    mAlert += ((mood === 'alert' ? 1 : 0) - mAlert) * kM;
    const slow = 1 + mSleepy * 0.8;

    // ---- gaze ----
    if (sSacc.tick(t, (1 + mSleepy) * (1 - 0.4 * mAlert))) {
      if (gazeFixed) { setTargetScreen(gfx + (sSacc.k - 0.5) * 0.04, gfy + (sSacc.flag ? 0.015 : -0.015)); }
      else pickFree();
    }
    const su = t - swatT, swatOn = su >= 0 && su < 0.75;
    if (swatOn) setTargetScreen(swatX, swatY);          // eyes locked on the tile while swatting
    const ke = 1 - Math.exp(-dt / M.eyeTau);
    ex += (tgx - ex) * ke; ey += (tgy - ey) * ke;
    // head: 2nd-order spring toward the eye direction (lags behind)
    const w0 = M.headHz * 6.2832 / slow, z = M.headZeta;
    hvx += (w0 * w0 * (ex - hx) - 2 * z * w0 * hvx) * dt; hx += hvx * dt;
    hvy += (w0 * w0 * (ey - hy) - 2 * z * w0 * hvy) * dt; hy += hvy * dt;

    // ---- yawn (substitute, no eyelids: head lifts back, ears go back, deep breath) ----
    const yu = t - sYawn.start, yawn = yu >= 0 && yu < 2.6 ? sst(0, 0.5, yu) * (1 - sst(1.9, 2.6, yu)) : 0;

    // ---- pupils + eye shift ----
    const ps = 1 + hourPupil + 0.22 * mAlert - 0.1 * mSleepy + 0.03 * Math.sin(t * 0.3 + ph[1]);
    U.uGaze.value.set(ex * M.eyeShift[0], ey * M.eyeShift[1], lerp(1, ps, M.pupilAniso[0]), lerp(1, ps, M.pupilAniso[1]));

    // ---- head ----
    const tu = t - sTilt.start;
    let tilt = 0;
    if (tu >= 0 && tu < 3) {
      const dir = sTilt.flag ? 1 : -1;
      tilt = dir * M.tilt * (sst(0.15, 0.7, tu) * (1 - sst(2.0, 3.0, tu)) - M.antic * sst(0, 0.15, tu) * (1 - sst(0.15, 0.4, tu)));
    }
    const roll = M.roll * (Math.sin(t * 0.37 + ph[2]) + 0.6 * Math.sin(t * 0.23 + ph[3])) / 1.6 + tilt - yawn * M.roll * 1.2 + hx * M.rollGaze;
    const br = Math.sin(t * M.breathHz * 6.2832 + 0.4 * Math.sin(t * 0.11 + ph[4]));
    const bobY = M.bob * (0.6 * Math.sin(t * 0.29 + ph[5]) + 0.4 * br * 0.5);
    U.uHead.value.set(roll, M.bob * 0.3 * Math.sin(t * 0.19 + ph[6]) + hx * M.yawShift, bobY + hy * M.yawShift * 0.5, 0);
    U.uPar.value.set(hx * M.yawPx, hy * M.pitchPx - yawn * M.pitchPx * 0.9);

    // ---- breath ----
    U.uBreath.value.y = -M.breath * (0.5 + 0.5 * br) * (1 - 0.3 * mSleepy) - yawn * M.breath;
    U.uBreath.value.z = M.breath * 0.35 * (0.5 + 0.5 * br);

    // ---- ears ----
    if (sEarL.tick(t, 1 - 0.4 * mAlert + 0.5 * mSleepy)) {}
    if (sEarR.tick(t, 1 - 0.4 * mAlert + 0.5 * mSleepy)) {}
    const tl = twitch(t - sEarL.start, M.earTwitch * (0.6 + 0.4 * sEarL.k)) + (sEarL.flag ? twitch(t - sEarL.start - 0.35, M.earTwitch * 0.5) : 0);
    const tr = twitch(t - sEarR.start, M.earTwitch * (0.6 + 0.4 * sEarR.k)) + (sEarR.flag ? twitch(t - sEarR.start - 0.35, M.earTwitch * 0.5) : 0);
    const earMood = -0.05 * mSleepy + 0.04 * mAlert - 0.12 * yawn;
    const earIdle = 0.012 * Math.sin(t * 0.5 + ph[7]);
    const fwd = swatOn ? 0.07 * sst(0, 0.1, su) * (1 - sst(0.5, 0.75, su)) : 0;   // ears forward (tips inward)
    U.uEarL.value.z = -tl - earMood + hx * M.earGaze + earIdle + fwd;
    U.uEarR.value.z = tr + earMood + hx * M.earGaze - earIdle - fwd;

    // ---- whiskers (follow breath, a bit late) ----
    const wa = M.whisk * (0.6 * Math.sin(t * M.breathHz * 6.2832 - 0.9 + ph[8] * 0.1) + 0.4 * Math.sin(t * 0.7 + ph[9]));
    U.uWhA.value.set(wa, -wa);

    // ---- paw knead ----
    sPaw.tick(t, 1);
    const pu = t - sPaw.start;
    const pw = pu >= 0 && pu < 1.4 ? Math.sin(Math.PI * clamp(pu / 0.45, 0, 1)) + 0.7 * Math.sin(Math.PI * clamp((pu - 0.6) / 0.45, 0, 1)) : 0;
    U.uPaw.value.set(pw * M.pawPx * 0.25, pw * M.pawPx);
    if (swatOn) {
      // anticipation (pull back + lift) -> swipe toward the tile -> recover; the contact line stays anchored
      const tp = screenToPx(swatX, swatY);
      let dx = tp[0] - pawC[0], dy = tp[1] - pawC[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const k = su < 0.16 ? -0.35 * sst(0, 0.16, su) : su < 0.3 ? lerp(-0.35, 1, sst(0.16, 0.3, su)) : 1 - sst(0.3, 0.75, su);
      const lift = su < 0.3 ? sst(0, 0.16, su) : 1 - sst(0.3, 0.6, su);
      const reach = M.swatReach || 22;
      U.uPaw.value.x += dx * reach * k;
      U.uPaw.value.y += Math.max(0, dy) * reach * 0.35 * k - reach * 0.5 * lift;
    }

    // ---- tail: travelling wave base->tip + slow drift + occasional flicks ----
    sFlick.tick(t, 1 - 0.4 * mAlert + 0.6 * mSleepy);
    const amp = M.tailAmp * (0.75 + 0.25 * Math.sin(t * 0.09 + ph[10])) * (1 - 0.5 * mSleepy);
    const phase = t * M.tailHz * 6.2832 / (1 + 0.5 * mSleepy) + 1.4 * Math.sin(t * 0.13 + ph[11]) + 0.9 * Math.sin(t * 0.071 + ph[12]);
    const fu = t - sFlick.start, fdir = sFlick.flag ? 1 : -1;
    let ax = 0, ay = 0, acc = 0;
    for (let j = 0; j < NJ; j++) {
      const s = j / (NJ - 1);
      const env = 0.25 + 0.75 * s;
      let dl = amp * env * Math.sin(phase - M.tailLag * s);
      dl += M.tailDrift * env * (Math.sin(t * 0.17 - s * 1.2 + ph[13]) + 0.5 * Math.sin(t * 0.31 - s * 0.8 + ph[14]));
      const v = fu - 0.09 * j;
      if (v > 0 && v < 1.2) dl += fdir * M.flick * s * s * Math.exp(-v * 5) * Math.sin(v * 13);
      delta[j] = dl * (j === 0 ? 0.3 : 1);
    }
    for (let j = 0; j < NJ; j++) {
      acc += delta[j];
      uJA[j] = acc;
      if (j === 0) { ax = J[0][0]; ay = J[0][1]; }
      uJ[j * 4 + 2] = ax; uJ[j * 4 + 3] = ay;
      if (j < NJ - 1) { const c = Math.cos(acc), sn = Math.sin(acc); ax += c * segX[j] - sn * segY[j]; ay += sn * segX[j] + c * segY[j]; }
    }
    if (EXT) extremeOverride();
  }

  function extremeOverride() {
    const sg = Math.floor(tNow / 2) % 2 ? 1 : -1;     // flips side every 2 s
    let acc = 0, ax = J[0][0], ay = J[0][1];
    for (let j = 0; j < NJ; j++) {
      const s = j / (NJ - 1);
      acc += sg * (j === 0 ? 0.3 : 1) * ((M.tailAmp + 1.5 * M.tailDrift) * (0.25 + 0.75 * s) + M.flick * 0.55 * s * s);
      uJA[j] = acc; uJ[j * 4 + 2] = ax; uJ[j * 4 + 3] = ay;
      if (j < NJ - 1) { const c = Math.cos(acc), sn = Math.sin(acc); ax += c * segX[j] - sn * segY[j]; ay += sn * segX[j] + c * segY[j]; }
    }
    U.uEarL.value.z = -sg * (M.earTwitch * 0.62 + M.earGaze + 0.06);
    U.uEarR.value.z = sg * (M.earTwitch * 0.62 + M.earGaze + 0.06);
    U.uHead.value.set(sg * (M.roll + M.tilt), M.bob * 0.3 + sg * M.yawShift, M.bob + M.yawShift * 0.5, 0);
    U.uPar.value.set(sg * M.yawPx, M.pitchPx);
    U.uPaw.value.set(M.pawPx * 0.4, M.pawPx * 1.7);
    U.uWhA.value.set(M.whisk, -M.whisk);
    U.uBreath.value.y = -M.breath * 1.3; U.uBreath.value.z = M.breath * 0.35;
    U.uGaze.value.set(sg * M.eyeShift[0], M.eyeShift[1], 1.3, 1.3);
  }

  return {
    scene, camera, update,
    resize(a) { fit(a); },
    setGaze(x, y) {
      if (x == null) { gazeFixed = false; pickFree(); return; }
      gazeFixed = true; gfx = x; gfy = y; setTargetScreen(x, y);
    },
    setMood(name) { mood = name === 'sleepy' || name === 'alert' ? name : 'awake'; },
    setHour(h) { hour = ((+h % 24) + 24) % 24; hourPupil = applyHour(hour); },
    poke(kind, x, y) {
      const t = tNow;
      if (kind === 'earTwitch') { sEarL.fire(t); sEarR.fire(t + 0.12); sEarR.start = t + 0.12; }
      else if (kind === 'tailFlick') sFlick.fire(t);
      else if (kind === 'yawn') sYawn.fire(t);
      else if (kind === 'pawTap') sPaw.fire(t);
      else if (kind === 'swat' && mood !== 'sleepy') { swatT = t; swatX = x != null ? +x : 0.5; swatY = y != null ? +y : 0.92; }
    },
    canSwat: true,
    dispose() {
      g.dispose(); pg.dispose(); catMat.dispose(); plateMat.dispose();
      catTex.dispose(); eyeTex.dispose(); plateTex.dispose(); whTex.dispose();
    },
  };
}
