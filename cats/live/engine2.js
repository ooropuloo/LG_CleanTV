// Living-image engine, v2 packs ("scenes"): several subjects (person + cat) in ONE picture, ONE draw call.
// The whole picture is a full-frame grid mesh bent in the vertex shader by baked weights:
//   up to 8 affine channels (head / breath / ears / paw / yarn, each with its own uniform 2x3 transform),
//   a 12-joint tail chain, and a hair wave. Eyes (gaze + pupil, highlights kept unwarped) and the animated
//   texture regions (rain streaks, bokeh twinkle, lamp glow) are done in the fragment shader.
// Nothing is cut out: no plate, no matte, so no tearing / halos / doubled parts; amplitudes stay small.
// Prep: cats/live/tools/prep_scene.py.  Notes: cats/live/NOTES.md ("v2 scenes").
// Deterministic: all motion comes from (t, seed); update() allocates nothing.
import * as THREE from 'three';
import { mulberry32, clamp, sst, lerp, loadTex, Sched, GRADES } from './engine.js';

const NJ = 12, NCH = 8, NE = 4;
const EXT = typeof location !== 'undefined' && /[?&]extremes=1/.test(location.search);

const VS = /* glsl */`
#define NJ ${NJ}
uniform vec4 uM[${NCH}];   // 2x2 linear part (m00, m01, m10, m11)
uniform vec2 uT[${NCH}];   // translation: p' = M p + T
uniform vec4 uJ[NJ];       // tail joints rest.xy, deformed.xy
uniform float uJA[NJ];
uniform vec4 uHair;        // amp x px, phase, wave number (1/px), amp y px
attribute vec4 aA; attribute vec4 aB; attribute vec4 aC;   // channels 0-3, 4-7; tailW, tailS, hairW, hairPhase
varying vec2 vPx;
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
vec2 aff(int i, vec2 p) { vec4 m = uM[i]; return vec2(m.x * p.x + m.y * p.y, m.z * p.x + m.w * p.y) + uT[i] - p; }
void main() {
  vec2 p = position.xy;
  vec2 d = aA.x * aff(0, p) + aA.y * aff(1, p) + aA.z * aff(2, p) + aA.w * aff(3, p)
         + aB.x * aff(4, p) + aB.y * aff(5, p) + aB.z * aff(6, p) + aB.w * aff(7, p);
  if (aC.x > 0.002) {
    float s = aC.y * float(NJ - 1);
    int j = int(min(floor(s), float(NJ - 2)));
    float f = s - float(j);
    vec2 pa = uJ[j].zw + rot(p - uJ[j].xy, uJA[j]);
    vec2 pb = uJ[j + 1].zw + rot(p - uJ[j + 1].xy, uJA[j + 1]);
    d += aC.x * (mix(pa, pb, f) - p);
  }
  if (aC.z > 0.002) {
    float ph = uHair.y + aC.w * 6.2832 - p.y * uHair.z;
    d += aC.z * vec2(uHair.x * sin(ph), uHair.w * sin(ph * 0.7 + 1.3));
  }
  vPx = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + d, 0.0, 1.0);
}`;

const FS = /* glsl */`
uniform sampler2D uTex; uniform vec2 uSize;
uniform sampler2D uEyeTex; uniform vec4 uEyeCrop;
uniform sampler2D uAux; uniform float uHasAux;
uniform vec4 uEyeC[${NE}];   // c.xy, r.xy
uniform vec4 uEyeP[${NE}];   // cos, sin, fall0, fall1
uniform vec4 uEyeL[${NE}];   // -, -, pupil.xy (eye units)
uniform vec4 uEyeG[${NE}];   // shift.xy (eye units), pupil scale x, y
uniform vec4 uFx;            // time, rain strength, bokeh strength, lamp gain
uniform vec4 uEyeBox; uniform vec4 uFxBox;   // x0,y0,x1,y1 (source px): per-pixel work only inside these (PowerVR is fill-rate bound)
uniform vec3 uMul; uniform vec3 uAdd; uniform float uSat; uniform float uGradeK;
varying vec2 vPx;
vec2 gX, gY;
vec4 T(vec2 p) { return textureGrad(uTex, p / uSize, gX / uSize, gY / uSize); }
vec2 toPx(vec4 C, vec4 P, vec2 q) { vec2 w = q * C.zw; return C.xy + vec2(P.x * w.x - P.y * w.y, P.y * w.x + P.x * w.y); }
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec2 px = vPx;
  gX = dFdx(px); gY = dFdy(px);
  vec4 c = texture2D(uTex, px / uSize);          // uniform control flow: implicit derivatives are fine here
  bool inFx = px.x >= uFxBox.x && px.y >= uFxBox.y && px.x <= uFxBox.z && px.y <= uFxBox.w;
  vec4 ax = vec4(0.0);
  if (inFx) ax = textureGrad(uAux, px / uSize, gX / uSize, gY / uSize);
  // rain on the window: sparse drops sliding down, each a thin streak that slightly refracts what is behind
  float rs = 0.0;
  if (ax.b > 0.004) {
    float col = floor(px.x / 7.0);
    float a = h1(col), b = h1(col + 31.7), on = step(0.62, h1(col + 7.3));
    float per = 260.0 + 340.0 * a, len = 18.0 + 46.0 * b;
    float y = mod(uFx.x * (22.0 + 70.0 * a) - px.y + b * 900.0, per);
    float lat = 1.0 - smoothstep(0.4, 1.6, abs(px.x - col * 7.0 - 1.5 - 4.0 * b));
    rs = on * lat * smoothstep(len, 0.0, y) * smoothstep(-1.5, 2.5, y) * ax.b * uFx.y;
  }
  if (rs > 0.0) c = T(px + vec2(rs * 2.2, rs * 1.0));
  if (px.x >= uEyeBox.x && px.y >= uEyeBox.y && px.x <= uEyeBox.z && px.y <= uEyeBox.w)
  for (int e = 0; e < ${NE}; e++) {
    vec4 C = uEyeC[e], P = uEyeP[e], Lp = uEyeL[e], G = uEyeG[e];
    vec2 dv = px - C.xy;
    vec2 q = vec2(P.x * dv.x + P.y * dv.y, -P.y * dv.x + P.x * dv.y) / C.zw;
    float rho = length(q);
    if (rho < 1.0) {
      float fall = 1.0 - smoothstep(P.z, P.w, rho);
      vec2 qe = q - G.xy * fall;
      vec2 dq = qe - Lp.zw;
      float fp = 1.0 - smoothstep(0.2, 0.72, length(dq));
      qe = Lp.zw + dq / mix(vec2(1.0), G.zw, fp);
      c = T(toPx(C, P, qe));
      vec4 h = textureGrad(uEyeTex, (px - uEyeCrop.xy) / uEyeCrop.zw, gX / uEyeCrop.zw, gY / uEyeCrop.zw);
      c.rgb = mix(c.rgb, h.rgb, h.a);
    }
  }
  if (inFx) {
    c.rgb += rs * (0.10 + 0.35 * c.rgb);
    // bokeh twinkle: each light (blob) has its own phase; lamp glow breathes very slightly
    c.rgb *= 1.0 + ax.r * uFx.z * sin(uFx.x * (0.45 + 0.8 * ax.g) + ax.g * 57.0) + ax.a * uFx.w;
  }
  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  vec3 g = mix(vec3(l), c.rgb, uSat) * uMul + uAdd;
  gl_FragColor = vec4(mix(c.rgb, g, uGradeK), 1.0);
}`;

// ---------------- motion defaults per subject kind (index.js may override any key) ----------------
export const PERSON = {
  eyeShift: [0.16, 0.0], eyeTau: 0.05, sacc: [2, 5], viewer: 0.45, pupilAniso: [0, 0],
  headHz: 0.6, headZeta: 1.0, roll: 0.0035, rollGaze: 0.0, yawShift: 1.0, bob: 0.5, tilt: 0.006,
  breath: 1.6, breathHz: 0.24, hair: 2.2, hairY: 0.6, hairHz: 0.16, hairK: 0.012,
};
export const CAT = {
  eyeShift: [0.2, 0.12], eyeTau: 0.035, sacc: [1.5, 4], viewer: 0.32, pupilAniso: [1, 1],
  headHz: 0.8, headZeta: 0.9, roll: 0.004, rollGaze: 0.002, yawShift: 1.4, bob: 0.7, tilt: 0.01,
  breath: 0.006, breathHz: 0.45, breathY: 1.0,
  earTwitch: 0.14, earGaze: 0.03, earEvery: [4, 12],
  tailAmp: 0.03, tailHz: 0.22, tailLag: 2.0, tailDrift: 0.02, flick: 0.14, flickEvery: [6, 14],
  paw: 0, pawHz: 0.5, pawEvery: [3, 7], yarn: 0, swatReach: 30, headRide: 1,
};
const FX = { rain: 1, bokeh: 0.16, lamp: 0.03 };

export async function createRigScene({ renderer, quality, aspect, seed = 1, base, motion = {} }) {
  const u = (f) => new URL(f, base).href;
  const pk = await fetch(u('pack.json')).then((r) => r.json());
  const [bin, tex, eyeTex, auxTex] = await Promise.all([
    fetch(u('mesh.bin')).then((r) => r.arrayBuffer()),
    loadTex(u('image.jpg')), loadTex(u('eyes.png')), pk.aux ? loadTex(u('aux.png')) : Promise.resolve(null),
  ]);
  const [W, H] = pk.size;
  const fxM = Object.assign({}, FX, motion.fx || {});

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(30, aspect, 1, 100);
  camera.position.set(0, 0, 10);
  const root = new THREE.Group();
  scene.add(root);
  const VH = 2 * 10 * Math.tan((15 * Math.PI) / 180);
  let viewW = W, viewH = H;
  function fit(a) {
    camera.aspect = a; camera.updateProjectionMatrix();
    const k = Math.max((VH * a) / W, VH / H);
    viewW = (VH * a) / k; viewH = VH / k;
    root.scale.set(k, -k, 1); root.position.set((-W / 2) * k, (H / 2) * k, 0);
  }
  fit(aspect);

  const m = pk.mesh, o = m.offs;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(bin, o.pos, m.nv * 2), 2));
  g.setAttribute('aA', new THREE.BufferAttribute(new Uint8Array(bin, o.A, m.nv * 4), 4, true));
  g.setAttribute('aB', new THREE.BufferAttribute(new Uint8Array(bin, o.B, m.nv * 4), 4, true));
  g.setAttribute('aC', new THREE.BufferAttribute(new Uint8Array(bin, o.C, m.nv * 4), 4, true));
  g.setIndex(new THREE.BufferAttribute(m.idx32 ? new Uint32Array(bin, o.idx, m.ni) : new Uint16Array(bin, o.idx, m.ni), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(W / 2, H / 2, 0), W);

  // ---- uniforms ----
  const uM = new Float32Array(NCH * 4), uT = new Float32Array(NCH * 2);
  for (let i = 0; i < NCH; i++) { uM[i * 4] = 1; uM[i * 4 + 3] = 1; }
  const tl = pk.tail, J = tl ? tl.joints : null;
  const uJ = new Float32Array(NJ * 4), uJA = new Float32Array(NJ);
  const segX = new Float32Array(NJ), segY = new Float32Array(NJ), delta = new Float32Array(NJ);
  if (J) {
    for (let j = 0; j < NJ; j++) { uJ[j * 4] = uJ[j * 4 + 2] = J[j][0]; uJ[j * 4 + 1] = uJ[j * 4 + 3] = J[j][1]; }
    for (let j = 0; j < NJ - 1; j++) { segX[j] = J[j + 1][0] - J[j][0]; segY[j] = J[j + 1][1] - J[j][1]; }
  }
  const eyeC = new Float32Array(NE * 4), eyeP = new Float32Array(NE * 4), eyeL = new Float32Array(NE * 4), eyeG = new Float32Array(NE * 4);
  for (let e = 0; e < NE; e++) {
    const E = pk.eyes[e];
    if (!E) { eyeC.set([-1e4, -1e4, 1, 1], e * 4); eyeP.set([1, 0, 0.45, 0.96], e * 4); eyeG.set([0, 0, 1, 1], e * 4); continue; }
    const a = (E.rot * Math.PI) / 180;
    eyeC.set([E.c[0], E.c[1], E.r[0], E.r[1]], e * 4);
    eyeP.set([Math.cos(a), Math.sin(a), E.fall[0], E.fall[1]], e * 4);
    eyeL.set([0, 0, E.pupil[0], E.pupil[1]], e * 4);
    eyeG.set([0, 0, 1, 1], e * 4);
  }
  // bounding box of all eye ellipses (+ a margin for the head motion); empty box when there are no eyes
  function eyeBox() {
    if (!pk.eyes.length) return [-1, -1, -1, -1];
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const E of pk.eyes) { const r = Math.max(E.r[0], E.r[1]) + 2; x0 = Math.min(x0, E.c[0] - r); y0 = Math.min(y0, E.c[1] - r); x1 = Math.max(x1, E.c[0] + r); y1 = Math.max(y1, E.c[1] + r); }
    return [x0, y0, x1, y1];
  }
  const gradeU = { uMul: { value: new THREE.Vector3(1, 1, 1) }, uAdd: { value: new THREE.Vector3() }, uSat: { value: 1 }, uGradeK: { value: pk.grade != null ? pk.grade : 1 } };
  const U = Object.assign({
    uM: { value: uM }, uT: { value: uT }, uJ: { value: uJ }, uJA: { value: uJA },
    uHair: { value: new THREE.Vector4() },
    uTex: { value: tex }, uSize: { value: new THREE.Vector2(W, H) },
    uEyeTex: { value: eyeTex }, uEyeCrop: { value: new THREE.Vector4(...pk.eyeCrop) },
    uAux: { value: auxTex || eyeTex }, uHasAux: { value: auxTex ? 1 : 0 },
    uEyeC: { value: eyeC }, uEyeP: { value: eyeP }, uEyeL: { value: eyeL }, uEyeG: { value: eyeG },
    uFx: { value: new THREE.Vector4(0, pk.fx.rain ? fxM.rain : 0, pk.fx.bokeh ? fxM.bokeh : 0, 0) },
    uEyeBox: { value: new THREE.Vector4(...eyeBox()) },
    uFxBox: { value: new THREE.Vector4(...(pk.fxBox || (auxTex ? [0, 0, W, H] : [-1, -1, -1, -1]))) },
  }, gradeU);
  const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: U, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; root.add(mesh);
  renderer.compile(scene, camera);

  // ---------------- animation state ----------------
  const R = (salt) => mulberry32((seed * 2654435761) ^ (salt * 40503) ^ 0x5bd1e995);
  const rPh = R(1);
  const ph = new Float32Array(32); for (let i = 0; i < 32; i++) ph[i] = rPh() * 6.2832;
  const chans = pk.channels;
  const subs = pk.subjects.map((s, i) => {
    const M = Object.assign({}, s.kind === 'person' ? PERSON : CAT, motion[s.kind] || {}, motion[s.id] || {});
    const ch = s.ch;
    const S = {
      id: s.id, kind: s.kind, M, eyes: s.eyes, faceC: s.faceC, gaze: s.gaze !== false && s.eyes.length > 0, ch,
      sSacc: new Sched(R(20 + i * 10), M.sacc[0], M.sacc[1], 0.4 + i * 0.7),
      sEarL: new Sched(R(21 + i * 10), M.earEvery ? M.earEvery[0] : 4, M.earEvery ? M.earEvery[1] : 12, 2 + R(22 + i * 10)() * 4),
      sEarR: new Sched(R(23 + i * 10), M.earEvery ? M.earEvery[0] : 4, M.earEvery ? M.earEvery[1] : 12, 3.5 + R(24 + i * 10)() * 5),
      sTilt: new Sched(R(25 + i * 10), 8, 20, 5 + R(26 + i * 10)() * 5),
      sPaw: new Sched(R(27 + i * 10), M.pawEvery ? M.pawEvery[0] : 3, M.pawEvery ? M.pawEvery[1] : 7, 1.2 + R(28 + i * 10)()),
      rGaze: R(29 + i * 10),
      tgx: 0, tgy: 0, ex: 0, ey: 0, hx: 0, hvx: 0, hy: 0, hvy: 0,
      ear: [chans[ch.earL], chans[ch.earR]], neck: chans[ch.head].pivot,
    };
    return S;
  });
  const tailSub = tl ? subs.find((s) => s.id === tl.subject) : null;
  const sFlick = new Sched(R(6), tailSub ? tailSub.M.flickEvery[0] : 6, tailSub ? tailSub.M.flickEvery[1] : 14, 4 + R(15)() * 4);
  const swatSub = subs.find((s) => s.kind === 'cat') || null;

  let gazeFixed = false, gfx = 0.5, gfy = 0.5;
  let mood = 'awake', mSleepy = 0, mAlert = 0, tNow = 0;
  let swatT = -1e9, swatX = 0.5, swatY = 0.9, swatGaze = false;

  function screenToPx(x, y) { return [W / 2 + (x - 0.5) * viewW, H / 2 + (y - 0.5) * viewH]; }
  function target(S, x, y) {
    const p = screenToPx(x, y);
    S.tgx = Math.tanh((p[0] - S.faceC[0]) / (W * 0.4));
    S.tgy = Math.tanh((p[1] - S.faceC[1]) / (H * 0.3));
  }
  function pickFree(S) {
    const r = S.rGaze();
    if (r < S.M.viewer) { S.tgx = (S.rGaze() - 0.5) * 0.12; S.tgy = (S.rGaze() - 0.5) * 0.1; }
    else target(S, 0.12 + 0.76 * S.rGaze(), 0.2 + 0.72 * S.rGaze());
  }

  function applyHour(h) {
    let i = 0; while (i < GRADES.length - 2 && GRADES[i + 1][0] <= h) i++;
    const a = GRADES[i], b = GRADES[i + 1], f = sst(a[0], b[0], h);
    gradeU.uMul.value.set(lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f));
    gradeU.uSat.value = lerp(a[4], b[4], f);
    gradeU.uAdd.value.set(lerp(a[5], b[5], f), lerp(a[6], b[6], f), lerp(a[7], b[7], f));
    return lerp(a[8], b[8], f) * (pk.grade != null ? pk.grade : 1);
  }
  let hourPupil = applyHour(12);
  const twitch = (u, A) => (u < 0 || u > 0.9 ? 0 : A * Math.exp(-u * 8) * Math.sin(u * 30));

  // channel transforms: rotation by a about pivot, then translation
  function setRot(i, px, py, a, tx, ty, sx = 1, sy = 1) {
    if (i == null) return;
    const c = Math.cos(a), s = Math.sin(a);
    const m00 = c * sx, m01 = -s * sy, m10 = s * sx, m11 = c * sy;
    uM[i * 4] = m00; uM[i * 4 + 1] = m01; uM[i * 4 + 2] = m10; uM[i * 4 + 3] = m11;
    uT[i * 2] = px - (m00 * px + m01 * py) + tx; uT[i * 2 + 1] = py - (m10 * px + m11 * py) + ty;
  }
  // displacement of point (x, y) under channel i (for riding one part on another rigidly)
  const dispX = (i, x, y) => uM[i * 4] * x + uM[i * 4 + 1] * y + uT[i * 2] - x;
  const dispY = (i, x, y) => uM[i * 4 + 2] * x + uM[i * 4 + 3] * y + uT[i * 2 + 1] - y;

  function update(dt, t) {
    tNow = t;
    const kM = 1 - Math.exp(-dt / 0.8);
    mSleepy += ((mood === 'sleepy' ? 1 : 0) - mSleepy) * kM;
    mAlert += ((mood === 'alert' ? 1 : 0) - mAlert) * kM;
    const slow = 1 + mSleepy * 0.6;
    const su = t - swatT, swatOn = su >= 0 && su < 0.75;

    for (let si = 0; si < subs.length; si++) {
      const S = subs[si], M = S.M, ch = S.ch;
      // ---- gaze ----
      if (S.gaze) {
        if (S.sSacc.tick(t, (1 + 0.6 * mSleepy) * (1 - 0.4 * mAlert))) {
          if (gazeFixed) target(S, gfx + (S.sSacc.k - 0.5) * 0.03, gfy + (S.sSacc.flag ? 0.01 : -0.01));
          else pickFree(S);
        }
        if (swatOn && S.kind === 'cat') target(S, swatX, swatY);
        const ke = 1 - Math.exp(-dt / M.eyeTau);
        S.ex += (S.tgx - S.ex) * ke; S.ey += (S.tgy - S.ey) * ke;
        const ps = 1 + hourPupil * (M.pupilAniso ? 1 : 0.4) + 0.12 * mAlert + 0.02 * Math.sin(t * 0.3 + ph[si]);
        const an = M.pupilAniso || [0.3, 0.3];
        for (let k = 0; k < S.eyes.length; k++) {
          const e = S.eyes[k], sh = pk.eyes[e].shift;
          eyeG[e * 4] = S.ex * M.eyeShift[0] * sh; eyeG[e * 4 + 1] = S.ey * M.eyeShift[1] * sh;
          eyeG[e * 4 + 2] = lerp(1, ps, an[0]); eyeG[e * 4 + 3] = lerp(1, ps, an[1]);
        }
      }
      const w0 = (M.headHz * 6.2832) / slow, z = M.headZeta;
      S.hvx += (w0 * w0 * (S.ex - S.hx) - 2 * z * w0 * S.hvx) * dt; S.hx += S.hvx * dt;
      S.hvy += (w0 * w0 * (S.ey - S.hy) - 2 * z * w0 * S.hvy) * dt; S.hy += S.hvy * dt;

      // ---- breath ----
      const br = Math.sin(t * M.breathHz * 6.2832 / (1 + 0.3 * mSleepy) + 0.4 * Math.sin(t * 0.11 + ph[4 + si]) + ph[8 + si]);
      const b01 = 0.5 + 0.5 * br;
      if (ch.breath != null) {
        const pv = chans[ch.breath].pivot;
        if (S.kind === 'person') setRot(ch.breath, pv[0], pv[1], 0, 0, -M.breath * b01);
        else setRot(ch.breath, pv[0], pv[1], 0, 0, 0, 1 + M.breath * 0.45 * b01, 1 + M.breath * M.breathY * b01);
      }
      // ---- head: rigid (roll about the neck + small shift toward the gaze + bob), rides the breath ----
      const tu = t - S.sTilt.start;
      let tilt = 0;
      if (tu >= 0 && tu < 3) tilt = (S.sTilt.flag ? 1 : -1) * M.tilt * sst(0.2, 0.9, tu) * (1 - sst(2.0, 3.0, tu));
      S.sTilt.tick(t, slow);
      const roll = M.roll * (Math.sin(t * 0.37 + ph[12 + si]) + 0.6 * Math.sin(t * 0.23 + ph[14 + si])) / 1.6 + tilt + S.hx * M.rollGaze;
      let hx = M.bob * 0.4 * Math.sin(t * 0.19 + ph[16 + si]) + S.hx * M.yawShift;
      let hy = M.bob * Math.sin(t * 0.29 + ph[18 + si]) + S.hy * M.yawShift * 0.5;
      if (S.kind !== 'person' && ch.breath != null) { hx += M.headRide * dispX(ch.breath, S.neck[0], S.neck[1]); hy += M.headRide * dispY(ch.breath, S.neck[0], S.neck[1]); }
      setRot(ch.head, S.neck[0], S.neck[1], roll, hx, hy);

      // ---- hair ----
      if (S.kind === 'person' && pk.hair) {
        const hp = t * M.hairHz * 6.2832 + 0.8 * Math.sin(t * 0.07 + ph[20]);
        const amp = M.hair * (0.7 + 0.3 * Math.sin(t * 0.05 + ph[21]));
        U.uHair.value.set(amp, hp, M.hairK, M.hairY * (0.6 + 0.4 * b01));
      }

      // ---- ears ----
      if (ch.earL != null) {
        const mul = 1 - 0.4 * mAlert + 0.5 * mSleepy;
        S.sEarL.tick(t, mul); S.sEarR.tick(t, mul);
        const tlv = twitch(t - S.sEarL.start, M.earTwitch * (0.6 + 0.4 * S.sEarL.k)) + (S.sEarL.flag ? twitch(t - S.sEarL.start - 0.35, M.earTwitch * 0.5) : 0);
        const trv = twitch(t - S.sEarR.start, M.earTwitch * (0.6 + 0.4 * S.sEarR.k)) + (S.sEarR.flag ? twitch(t - S.sEarR.start - 0.35, M.earTwitch * 0.5) : 0);
        const fwd = swatOn ? 0.06 * sst(0, 0.1, su) * (1 - sst(0.5, 0.75, su)) : 0;
        const idle = 0.008 * Math.sin(t * 0.5 + ph[22 + si]);
        const pl = chans[ch.earL].pivot, pr = chans[ch.earR].pivot;
        // ears ride the head rigidly, then rotate about their base
        setRot(ch.earL, pl[0], pl[1], -tlv + S.hx * M.earGaze + idle + fwd, 0, 0);
        setRot(ch.earR, pr[0], pr[1], trv + S.hx * M.earGaze - idle - fwd, 0, 0);
      }

      // ---- paw: gentle bat (small arc about the wrist) + swat toward a tile ----
      if (ch.paw != null) {
        S.sPaw.tick(t, slow);
        const pv = chans[ch.paw].pivot;
        const pu = t - S.sPaw.start;
        const bat = M.paw * (pu >= 0 && pu < 1.1 ? Math.sin(Math.PI * clamp(pu / 0.55, 0, 1)) * (S.sPaw.flag ? 1 : 0.6) + 0.35 * Math.sin(Math.PI * clamp((pu - 0.55) / 0.5, 0, 1)) : 0);
        const idle = M.paw * 0.12 * Math.sin(t * 0.8 + ph[24]);
        let sa = 0, sx = 0, sy = 0;
        if (swatOn) {
          const tp = screenToPx(swatX, swatY), tipP = chans[ch.paw].tip;
          let dx = tp[0] - tipP[0], dy = tp[1] - tipP[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
          // anticipation (pull back + up) -> swipe -> recover
          const k = su < 0.16 ? -0.35 * sst(0, 0.16, su) : su < 0.3 ? lerp(-0.35, 1, sst(0.16, 0.3, su)) : 1 - sst(0.3, 0.75, su);
          sx = dx * M.swatReach * k; sy = dy * M.swatReach * k * 0.8 - (su < 0.3 ? 6 * sst(0, 0.16, su) : 6 * (1 - sst(0.3, 0.6, su)));
          sa = (dx > 0 ? 1 : -1) * 0.12 * k;
        }
        setRot(ch.paw, pv[0], pv[1], -bat + idle + sa, sx, sy);
      }
      if (ch.yarn != null) {
        const Y = chans[ch.yarn];
        const pu = t - S.sPaw.start;
        // the ball rocks about its contact point, kicked a little after each bat
        const kick = pu >= 0.25 && pu < 3 ? Math.exp(-(pu - 0.25) * 1.6) * Math.sin((pu - 0.25) * 7) : 0;
        const ang = M.yarn * (0.25 * Math.sin(t * 0.9 + ph[25]) + kick * (S.sPaw.flag ? 1 : 0.6));
        setRot(ch.yarn, Y.pivot[0], Y.pivot[1], ang, ang * Y.r * 0.3, 0);
      }
    }

    // ---- tail: travelling wave base->tip + drift + flicks ----
    if (J) {
      const M = tailSub.M;
      sFlick.tick(t, 1 - 0.4 * mAlert + 0.6 * mSleepy);
      const amp = M.tailAmp * (0.75 + 0.25 * Math.sin(t * 0.09 + ph[26]));
      const phase = (t * M.tailHz * 6.2832) + 1.4 * Math.sin(t * 0.13 + ph[27]) + 0.9 * Math.sin(t * 0.071 + ph[28]);
      const fu = t - sFlick.start, fdir = sFlick.flag ? 1 : -1;
      let ax = J[0][0], ay = J[0][1], acc = 0;
      for (let j = 0; j < NJ; j++) {
        const s = j / (NJ - 1), env = 0.25 + 0.75 * s;
        let dl = amp * env * Math.sin(phase - M.tailLag * s);
        dl += M.tailDrift * env * (Math.sin(t * 0.17 - s * 1.2 + ph[29]) + 0.5 * Math.sin(t * 0.31 - s * 0.8 + ph[30]));
        const v = fu - 0.09 * j;
        if (v > 0 && v < 1.6) dl += fdir * M.flick * s * s * Math.exp(-v * 4) * Math.sin(v * 9);
        delta[j] = dl * (j === 0 ? 0.3 : 1);
      }
      for (let j = 0; j < NJ; j++) {
        acc += delta[j]; uJA[j] = acc; uJ[j * 4 + 2] = ax; uJ[j * 4 + 3] = ay;
        if (j < NJ - 1) { const c = Math.cos(acc), sn = Math.sin(acc); ax += c * segX[j] - sn * segY[j]; ay += sn * segX[j] + c * segY[j]; }
      }
    }
    U.uFx.value.x = t % 1000;
    U.uFx.value.w = fxM.lamp * (0.6 * Math.sin(t * 0.5 + ph[31]) + 0.4 * Math.sin(t * 0.23 + ph[3]));
    if (EXT) extremes();
  }

  function extremes() {
    const sg = Math.floor(tNow / 2) % 2 ? 1 : -1;
    for (const S of subs) {
      const M = S.M, ch = S.ch;
      for (const e of S.eyes) { eyeG[e * 4] = sg * M.eyeShift[0] * pk.eyes[e].shift; eyeG[e * 4 + 1] = M.eyeShift[1] * pk.eyes[e].shift; eyeG[e * 4 + 2] = eyeG[e * 4 + 3] = 1.25; }
      if (ch.breath != null) {
        const pv = chans[ch.breath].pivot;
        if (S.kind === 'person') setRot(ch.breath, pv[0], pv[1], 0, 0, -M.breath * 1.2);
        else setRot(ch.breath, pv[0], pv[1], 0, 0, 0, 1 + M.breath * 0.5, 1 + M.breath * M.breathY * 1.2);
      }
      let hx = sg * (M.bob * 0.4 + M.yawShift), hy = M.bob + M.yawShift * 0.5;
      if (S.kind !== 'person' && ch.breath != null) { hx += dispX(ch.breath, S.neck[0], S.neck[1]); hy += dispY(ch.breath, S.neck[0], S.neck[1]); }
      setRot(ch.head, S.neck[0], S.neck[1], sg * (M.roll + M.tilt), hx, hy);
      if (S.kind === 'person' && pk.hair) U.uHair.value.set(M.hair * sg, 1.5708, M.hairK, M.hairY);
      if (ch.earL != null) {
        const pl = chans[ch.earL].pivot, pr = chans[ch.earR].pivot, a = M.earTwitch * 0.62 + M.earGaze;
        setRot(ch.earL, pl[0], pl[1], -sg * a, 0, 0); setRot(ch.earR, pr[0], pr[1], sg * a, 0, 0);
      }
      if (ch.paw != null) { const pv = chans[ch.paw].pivot; setRot(ch.paw, pv[0], pv[1], -sg * M.paw * 1.35, 0, 0); }
      if (ch.yarn != null) { const Y = chans[ch.yarn]; const a = sg * M.yarn * 1.25; setRot(ch.yarn, Y.pivot[0], Y.pivot[1], a, a * Y.r * 0.3, 0); }
    }
    if (J) {
      const M = tailSub.M;
      let acc = 0, ax = J[0][0], ay = J[0][1];
      for (let j = 0; j < NJ; j++) {
        const s = j / (NJ - 1);
        acc += sg * (j === 0 ? 0.3 : 1) * ((M.tailAmp + 1.5 * M.tailDrift) * (0.25 + 0.75 * s) + M.flick * 0.55 * s * s);
        uJA[j] = acc; uJ[j * 4 + 2] = ax; uJ[j * 4 + 3] = ay;
        if (j < NJ - 1) { const c = Math.cos(acc), sn = Math.sin(acc); ax += c * segX[j] - sn * segY[j]; ay += sn * segX[j] + c * segY[j]; }
      }
    }
  }

  for (const S of subs) if (S.gaze) pickFree(S);
  const anyGaze = subs.some((s) => s.gaze);
  return {
    scene, camera, update,
    resize(a) { fit(a); },
    setGaze(x, y) {
      if (!anyGaze) return;                      // e.g. the sleeping cat: eyes closed
      if (x == null) { gazeFixed = false; for (const S of subs) if (S.gaze) pickFree(S); return; }
      gazeFixed = true; gfx = x; gfy = y;
      for (const S of subs) if (S.gaze) target(S, x, y);
    },
    setMood(name) { mood = name === 'sleepy' || name === 'alert' ? name : 'awake'; },
    setHour(h) { hourPupil = applyHour(((+h % 24) + 24) % 24); },
    poke(kind, x, y) {
      const t = tNow;
      if (kind === 'earTwitch') { for (const S of subs) { S.sEarL.fire(t); S.sEarR.fire(t + 0.12); S.sEarR.start = t + 0.12; } }
      else if (kind === 'tailFlick') sFlick.fire(t);
      else if (kind === 'pawTap') { for (const S of subs) if (S.ch.paw != null) S.sPaw.fire(t); }
      else if (kind === 'swat' && swatSub && pk.swat !== false && mood !== 'sleepy') {
        swatT = t; swatX = x != null ? +x : 0.5; swatY = y != null ? +y : 0.92;
      }
    },
    canSwat: !!(swatSub && pk.swat !== false && swatSub.ch.paw != null),
    dispose() { g.dispose(); mat.dispose(); tex.dispose(); eyeTex.dispose(); if (auxTex) auxTex.dispose(); },
  };
}
