// 擬真風 black kitten peeking over a knitted blanket. Everything procedural (SDF-sculpted meshes, shell fur,
// canvas/DataTexture textures). See NOTES.md.
import * as THREE from 'three';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { ell, cap, capR, sph, smin, smax, sstep, clamp, mix, starMesh, hit, rng, noise1 } from './sdf.js';
import { makeBackdrop, makeKnit } from './textures.js';
import { makeLights, furMaterial, eyeMaterial, strandMaterial, knitMaterial, backdropMaterial, simpleMaterial } from './shaders.js';

export const meta = {
  id: 'real', name: '擬真風', coats: ['black', 'tabby'],
  renderer: () => ({ antialias: true, toneMapping: 'ACESFilmic', exposure: 1.0, shadows: false }),
};

const Q = {
  desktop: { headBase: 40, headShell: 40, headShells: 32, bodyN: 22, bodyShells: 18, pawN: 26, pawShells: 22, earS: 34, earV: 20, earShells: 10,
    tailRings: 56, tailSeg: 14, tailShells: 24, knitX: 420, knitY: 110, strays: 260, earHairs: 80, bgTex: 1024, knitTex: 256, knitFuzz: 3 },
  tv: { headBase: 28, headShell: 28, headShells: 12, bodyN: 14, bodyShells: 6, pawN: 16, pawShells: 8, earS: 22, earV: 12, earShells: 5,
    tailRings: 34, tailSeg: 10, tailShells: 10, knitX: 230, knitY: 56, strays: 110, earHairs: 45, bgTex: 768, knitTex: 256, knitFuzz: 0 },
};

// ------------------------------------------------------------------------------------------------ head sculpt
const EYE = [0.185, 0.0, 0.207], ER = 0.108;
function headSdf(x, y, z) {
  const ax = Math.abs(x);
  let d = ell(x, y, z, 0, 0.06, -0.08, 0.37, 0.34, 0.39);                    // cranium
  d = smin(d, ell(x, y, z, 0, 0.02, 0.09, 0.30, 0.25, 0.26), 0.08);          // face plate / forehead
  d = smin(d, ell(ax, y, z, 0.215, -0.09, 0.04, 0.225, 0.17, 0.215), 0.10);   // cheeks (zygomatic)
  d = smin(d, ell(x, y, z, 0, -0.17, 0.24, 0.15, 0.115, 0.17), 0.07);        // muzzle mass
  d = smin(d, ell(ax, y, z, 0.066, -0.215, 0.345, 0.075, 0.062, 0.072), 0.03); // whisker pads
  d = smin(d, cap(x, y, z, 0, 0.03, 0.27, 0, -0.125, 0.39, 0.058), 0.06);     // nose bridge
  d = smin(d, ell(x, y, z, 0, -0.156, 0.408, 0.047, 0.031, 0.03), 0.03);     // nose leather
  d = smin(d, ell(x, y, z, 0, -0.295, 0.28, 0.06, 0.042, 0.062), 0.045);      // chin
  d = smin(d, ell(x, y, z, 0, -0.25, 0.12, 0.16, 0.09, 0.2), 0.07);           // jaw
  d = smin(d, ell(ax, y, z, 0.165, 0.115, 0.245, 0.11, 0.045, 0.08), 0.05);   // brow
  d = smax(d, -sph(ax, y, z, 0.185, 0.0, 0.21, 0.085), 0.05);                  // gentle socket recess
  d = smax(d, -sph(ax, y, z, 0.021, -0.168, 0.446, 0.011), 0.008);            // nostrils
  d = smax(d, -cap(x, y, z, 0, -0.186, 0.44, 0, -0.226, 0.418, 0.0065), 0.008); // philtrum
  d = smax(d, -cap(ax, y, z, 0, -0.243, 0.408, 0.1, -0.262, 0.33, 0.006), 0.01); // mouth line
  return d;
}
function headAttr(p, n, o, ao) {
  const [x, y, z] = p, ax = Math.abs(x);
  let len = 0.052 + 0.012 * sstep(0.1, 0.4, y) * sstep(0.1, -0.2, z);
  len += 0.05 * sstep(0.16, 0.36, ax) * sstep(0.10, -0.12, y);                 // cheek ruff
  len += 0.04 * sstep(-0.15, -0.35, y) * sstep(0.2, -0.05, z);                    // throat
  const dn = Math.hypot(x, y + 0.12, (z - 0.40) * 0.6);
  len *= mix(0.14, 1, sstep(0.07, 0.26, dn));                                    // short on muzzle / nose bridge
  const de = Math.hypot(ax - EYE[0], y - EYE[1], z - EYE[2]) - ER;
  len *= sstep(-0.018, 0.05, de);                                                 // short at the lid edge
  len *= sstep(0.0, 0.035, Math.hypot(x, (y + 0.157) * 1.2, (z - 0.43)) - 0.04);  // nose leather
  if (y < -0.2 && z > 0.3) len *= mix(0.4, 1, sstep(0.005, 0.03, Math.abs(y + 0.243 + 0.35 * x * x))); // lip
  // comb: radiate back from the nose, down over the cheeks
  let cx = x, cy = y + 0.10, cz = z - 0.46;
  const cl = Math.hypot(cx, cy, cz) || 1; cx /= cl; cy /= cl; cz /= cl;
  cy -= 0.55 * sstep(0.12, 0.35, ax) * sstep(0.08, -0.1, y); cz -= 0.35;
  cx += Math.sign(x) * 0.25 * sstep(0.1, 0.3, ax);
  const dd = cx * n[0] + cy * n[1] + cz * n[2]; cx -= n[0] * dd; cy -= n[1] * dd; cz -= n[2] * dd;
  const tl = Math.hypot(cx, cy, cz) || 1;
  o[0] = len; o[1] = ao; o[2] = 0; o[3] = 0; o[4] = cx / tl; o[5] = cy / tl; o[6] = cz / tl;
}

// ------------------------------------------------------------------------------------------------ body / paw
function bodySdf(x, y, z) {
  let d = capR(x, y, z, 0, -0.16, -0.14, 0.01, -0.58, -0.14, 0.235, 0.27);   // neck
  d = smin(d, ell(x, y, z, 0.0, -0.66, -0.2, 0.38, 0.30, 0.34), 0.12);       // chest
  d = smin(d, ell(x, y, z, -0.42, -0.80, -0.62, 0.50, 0.34, 0.72), 0.15);    // torso, lying back-left
  d = smin(d, capR(x, y, z, 0.20, -0.70, -0.08, 0.30, -0.58, 0.28, 0.095, 0.078), 0.08); // left foreleg to the ledge
  return d;
}
function bodyAttr(p, n, o, ao) {
  const [x, y, z] = p;
  let len = 0.085 + 0.04 * sstep(-0.2, -0.45, y) * sstep(-0.3, 0.0, z);
  if (x > 0.1 && z > 0.0) len = mix(len, 0.05, sstep(0.0, 0.2, z));              // foreleg shorter
  let cx = 0, cy = -1, cz = -0.25;
  if (x > 0.12 && z > -0.1) { cx = 0.15; cy = -0.3; cz = 1; }
  const dd = cx * n[0] + cy * n[1] + cz * n[2]; cx -= n[0] * dd; cy -= n[1] * dd; cz -= n[2] * dd;
  const tl = Math.hypot(cx, cy, cz) || 1;
  o[0] = len; o[1] = ao; o[2] = 0; o[3] = 0; o[4] = cx / tl; o[5] = cy / tl; o[6] = cz / tl;
}
const TOES = [[-0.062, 0.031, 0.068, 0.031], [-0.022, 0.038, 0.092, 0.033], [0.022, 0.038, 0.092, 0.033], [0.062, 0.031, 0.068, 0.031]];
function pawSdf(x, y, z) {
  let d = ell(x, y, z, 0, 0.034, -0.01, 0.088, 0.046, 0.095);
  for (const [tx, ty, tz, r] of TOES) d = smin(d, ell(x, y, z, tx, ty, tz, r, r * 1.02, r * 1.2), 0.009);
  d = smin(d, capR(x, y, z, 0, 0.05, -0.06, 0, -0.13, -0.40, 0.066, 0.08), 0.05);
  return smax(d, -y, 0.012);
}
function pawAttr(p, n, o, ao) {
  const [x, y, z] = p;
  let len = 0.034;
  if (z > 0.04) len = 0.02;
  if (z < -0.08) len = 0.05;
  let cx = 0, cy = -0.35, cz = 1;
  const dd = cx * n[0] + cy * n[1] + cz * n[2]; cx -= n[0] * dd; cy -= n[1] * dd; cz -= n[2] * dd;
  const tl = Math.hypot(cx, cy, cz) || 1;
  o[0] = len; o[1] = ao; o[2] = 0; o[3] = 0; o[4] = cx / tl; o[5] = cy / tl; o[6] = cz / tl;
}

function furGeometry(m) {
  const g = new THREE.BufferGeometry(), n = m.count, furA = new Float32Array(n * 4), comb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { furA.set(m.ext.subarray(i * 7, i * 7 + 4), i * 4); comb.set(m.ext.subarray(i * 7 + 4, i * 7 + 7), i * 3); }
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2)); g.setAttribute('furA', new THREE.BufferAttribute(furA, 4)); g.setAttribute('comb', new THREE.BufferAttribute(comb, 3));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  return g;
}
function shellGeometry(g, count) {
  const s = new THREE.InstancedBufferGeometry();
  for (const k in g.attributes) s.setAttribute(k, g.attributes[k]);
  s.setIndex(g.index);
  const h = new Float32Array(count); for (let i = 0; i < count; i++) h[i] = (i + 1) / count;
  s.setAttribute('shell', new THREE.InstancedBufferAttribute(h, 1));
  s.instanceCount = count;
  return s;
}

// ------------------------------------------------------------------------------------------------ ear
const EAR = { H: 0.47, W: 0.37, D: 0.125, TK: 0.016 };
function earPoint(s, v, out) {
  // s 0..0.5 outer (back) surface, 0.5..1 inner surface; v -0.12..1 base->tip
  const vv = Math.max(v, 0), w = EAR.W / 2 * Math.pow(1 - vv, 0.92) * (1 - 0.1 * vv) + 0.004, d = EAR.D * Math.pow(1 - vv, 1.1) + 0.006;
  const inner = s > 0.5, th = (inner ? (1 - s) * 2 : s * 2) * Math.PI - Math.PI / 2;
  const sw = inner ? w - EAR.TK * (1 - vv * 0.5) : w, sd = inner ? d - EAR.TK : d;
  out[0] = sw * Math.sin(th); out[2] = -sd * Math.cos(th) - 0.06 * vv * vv + (inner ? 0.002 : 0); out[1] = v * EAR.H;
  out[0] *= 1 + 0.12 * Math.sin(vv * Math.PI) * (out[0] < 0 ? 1 : 0.4); // slightly fuller outer edge
  return out;
}
function earGeometry(S, V) {
  const pos = [], uv = [], furA = [], comb = [], idx = [], p = [0, 0, 0];
  for (let j = 0; j <= V; j++) for (let i = 0; i <= S; i++) {
    const s = i / S, v = -0.12 + 1.12 * Math.pow(j / V, 0.9);
    earPoint(s, v, p); pos.push(p[0], p[1], p[2]);
    uv.push(s * 0.9, v * EAR.H * 1.2);
    const inner = s > 0.52 && s < 0.98, edge = Math.min(Math.abs(s - 0.5), Math.min(s, 1 - s));
    const skin = inner ? sstep(0.03, 0.09, Math.min(s - 0.5, 1 - s)) : 0;
    const len = inner ? 0.022 * (1 - skin) : 0.026 * (1 - 0.5 * Math.max(v, 0));
    furA.push(Math.max(len, 0), 1 - 0.35 * skin * (1 - v), skin, edge);
    comb.push(0, 1, 0);
  }
  for (let j = 0; j < V; j++) for (let i = 0; i < S; i++) {
    const a = j * (S + 1) + i, b = a + 1, c = a + S + 2, d = a + S + 1;
    idx.push(a, d, c, a, c, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('furA', new THREE.Float32BufferAttribute(furA, 4)); g.setIndex(idx); g.computeVertexNormals();
  // comb: up along the ear, projected on the surface
  const nr = g.attributes.normal.array;
  for (let i = 0; i < comb.length; i += 3) { const nx = nr[i], ny = nr[i + 1], nz = nr[i + 2]; let cy = 1 - ny * ny, cx = -nx * ny, cz = -nz * ny; const l = Math.hypot(cx, cy, cz) || 1; comb[i] = cx / l; comb[i + 1] = cy / l; comb[i + 2] = cz / l; }
  g.setAttribute('comb', new THREE.Float32BufferAttribute(comb, 3));
  return g;
}

// ------------------------------------------------------------------------------------------------ strands
function strandGeometry(list, M) {
  const n = list.length, nv = n * (M + 1) * 2;
  const root = new Float32Array(nv * 3), dir = new Float32Array(nv * 3), curl = new Float32Array(nv * 3), sp = new Float32Array(nv * 4), col = new Float32Array(nv * 4), idx = [];
  let v = 0;
  for (let k = 0; k < n; k++) {
    const S = list[k];
    for (let i = 0; i <= M; i++) for (let side = -1; side <= 1; side += 2) {
      root.set(S.root, v * 3); dir.set(S.dir, v * 3); curl.set(S.curl, v * 3);
      sp[v * 4] = i / M; sp[v * 4 + 1] = side; sp[v * 4 + 2] = S.len; sp[v * 4 + 3] = S.width;
      col[v * 4] = S.col[0]; col[v * 4 + 1] = S.col[1]; col[v * 4 + 2] = S.col[2]; col[v * 4 + 3] = S.phase;
      v++;
    }
    const b = k * (M + 1) * 2;
    for (let i = 0; i < M; i++) { const a = b + i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(root, 3)); g.setAttribute('root', new THREE.BufferAttribute(root, 3));
  g.setAttribute('dir', new THREE.BufferAttribute(dir, 3)); g.setAttribute('curl', new THREE.BufferAttribute(curl, 3));
  g.setAttribute('sp', new THREE.BufferAttribute(sp, 4)); g.setAttribute('col', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------------------------------------------ hour presets
const HOURS = {
  day: { key: [2.5, 2.48, 2.42], kd: [-0.6, 0.45, 0.66], rim: [0.55, 0.5, 0.45], sky: [0.42, 0.44, 0.48], gnd: [0.19, 0.2, 0.22], wall: [1.55, 1.55, 1.6], lamp: 0.12, pupil: 0.15, vig: 0.4 },
  eve: { key: [1.9, 1.86, 1.84], kd: [-0.55, 0.5, 0.67], rim: [1.5, 0.95, 0.58], sky: [0.22, 0.23, 0.26], gnd: [0.10, 0.11, 0.12], wall: [1.0, 1.0, 1.0], lamp: 1.0, pupil: 0.42, vig: 0.55 },
  night: { key: [0.62, 0.76, 1.15], kd: [-0.5, 0.6, 0.62], rim: [0.75, 0.46, 0.28], sky: [0.07, 0.085, 0.13], gnd: [0.035, 0.04, 0.055], wall: [0.40, 0.45, 0.60], lamp: 0.45, pupil: 0.92, vig: 0.62 },
};
function hourBlend(h) {
  h = ((h % 24) + 24) % 24;
  const seg = [[0, 'night'], [5.5, 'night'], [7.5, 'day'], [16, 'day'], [18.5, 'eve'], [21.5, 'eve'], [23.5, 'night'], [24, 'night']];
  for (let i = 0; i < seg.length - 1; i++) if (h >= seg[i][0] && h <= seg[i + 1][0]) {
    const t = sstep(seg[i][0], seg[i + 1][0], h); return [HOURS[seg[i][1]], HOURS[seg[i + 1][1]], t];
  }
  return [HOURS.eve, HOURS.eve, 0];
}

// ================================================================================================ scene
export function createCatScene({ renderer, quality, aspect, seed = 1, coat = 'black' }) {
  const DBG = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('dbg')) || '';
  const C = Q[quality === 'tv' ? 'tv' : 'desktop'];
  coat = coat === 'tabby' ? 'tabby' : 'black';
  const H = quality === 'tv' ? 720 : 1080, W = Math.round(H * 16 / 9);
  const res = { value: new THREE.Vector2(W, H) };
  const R = rng(seed), L = makeLights();
  const scene = new THREE.Scene();
  const FOV = 20, CAM = new THREE.Vector3(-0.065, -0.09, 5.2);
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.5, 30);
  camera.position.copy(CAM); camera.lookAt(CAM.x, CAM.y, 0);
  const disposables = [];
  const keep = (o) => { disposables.push(o); return o; };

  // ---- coat colours (linear)
  const FUR = coat === 'black'
    ? { root: { value: new THREE.Color(0.006, 0.0055, 0.0055) }, tip: { value: new THREE.Color(0.034, 0.028, 0.024) }, spec: { value: new THREE.Color(0.09, 0.09, 0.095) },
        iris: [[0.46, 0.27, 0.045], [0.42, 0.17, 0.022], [0.26, 0.085, 0.014], [0.05, 0.022, 0.008]], nose: [0.03, 0.026, 0.026], earSkin: [0.032, 0.020, 0.021] }
    : { root: { value: new THREE.Color(0.05, 0.045, 0.04) }, tip: { value: new THREE.Color(0.12, 0.09, 0.06) }, spec: { value: new THREE.Color(0.07, 0.065, 0.06) },
        iris: [[0.36, 0.36, 0.12], [0.26, 0.31, 0.17], [0.25, 0.30, 0.20], [0.035, 0.04, 0.025]], nose: [0.20, 0.068, 0.055], earSkin: [0.13, 0.075, 0.07] };
  const TAB = coat === 'tabby';
  const part = (p) => (TAB ? { tabby: true, part: p } : {});

  // ---- backdrop plane filling the frustum at z = -5
  const bgTex = makeBackdrop(seed, C.bgTex); keep(bgTex.room); keep(bgTex.lamp);
  const bgMat = keep(backdropMaterial(L, res, bgTex));
  const bgDist = CAM.z + 5, bgH = 2 * bgDist * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.04;
  const bg = new THREE.Mesh(keep(new THREE.PlaneGeometry(bgH * 16 / 9, bgH)), bgMat);
  bg.position.set(CAM.x, CAM.y, -5); bg.renderOrder = -10; scene.add(bg);

  // ---- knitted blanket over a rounded sofa arm
  const knitTex = makeKnit(seed, C.knitTex); keep(knitTex.normal); keep(knitTex.albedo);
  const occ = [new THREE.Vector4(0.31, -0.47, 0.74, 0.11), new THREE.Vector4(0.0, -0.44, 0.18, 0.26), new THREE.Vector4(-0.4, -0.75, -0.3, 0.45), new THREE.Vector4(-0.9, -0.55, -0.42, 0.08)];
  const shad = [new THREE.Vector4(0.0, -0.05, 0.05, 0.40), new THREE.Vector4(0.31, -0.45, 0.74, 0.085), new THREE.Vector4(0.0, -0.42, 0.12, 0.25)];
  const knitMat = keep(knitMaterial(L, res, knitTex, new THREE.Vector2(1, 1), 0.045, occ, shad));
  knitMat.side = THREE.DoubleSide;
  const blanketG = keep(blanketGeometry(C, seed));
  const blanket = new THREE.Mesh(blanketG, knitMat); scene.add(blanket);
  const fuzzMat = keep(knitMaterial(L, res, knitTex, new THREE.Vector2(1, 1), 0.045, occ, shad, true));
  const fuzz = new THREE.Mesh(keep(shellGeometry(blanketG, Math.max(1, C.knitFuzz))), fuzzMat); fuzz.frustumCulled = false; if (C.knitFuzz) scene.add(fuzz);

  // ---- cat rig
  const cat = new THREE.Group(); scene.add(cat);
  const neck = new THREE.Group(); neck.position.set(0, -0.32, -0.12); cat.add(neck);
  const head = new THREE.Group(); head.position.set(0, 0.32, 0.12); neck.add(head);
  const lag = { value: new THREE.Vector3() };
  const furOpts = { res, root: FUR.root, tip: FUR.tip, spec: FUR.spec };

  // head
  const hb = starMesh(headSdf, [0, -0.02, 0.0], 0.75, C.headBase, headAttr, 7);
  const hs = C.headShell === C.headBase ? hb : starMesh(headSdf, [0, -0.02, 0.0], 0.75, C.headShell, headAttr, 7);
  const headG = keep(furGeometry(hb)), headSG = keep(shellGeometry(furGeometry(hs), C.headShells));
  const headBaseMat = keep(furMaterial(L, { ...furOpts, ...part(0), head: true, skin: FUR.nose, lag, density: 175 }));
  const headShellMat = keep(furMaterial(L, { ...furOpts, ...part(0), head: true, shells: true, skin: FUR.nose, lag, density: 175 }));
  if (TAB) { headBaseMat.uniforms.uFurScale.value = 0.78; headShellMat.uniforms.uFurScale.value = 0.78; }
  const headMesh = new THREE.Mesh(headG, headBaseMat); head.add(headMesh);
  const headShells = new THREE.Mesh(headSG, headShellMat); headShells.frustumCulled = false; head.add(headShells);

  // eyes + lids
  const eyes = [];
  for (const side of [-1, 1]) {
    const grp = new THREE.Group(); grp.position.set(side * EYE[0], EYE[1], EYE[2]); grp.rotation.set(0, side * 0.2, side * 0.11, 'YXZ'); head.add(grp);
    const mat = keep(eyeMaterial(L, res, FUR.iris, -side));
    const ball = new THREE.Mesh(keep(new THREE.SphereGeometry(ER, 40, 28)), mat); grp.add(ball);
    eyes.push({ side, grp, ball, mat });
  }

  // ears
  const earG = keep(earGeometry(C.earS, C.earV));
  const earSG = keep(shellGeometry(earG, C.earShells));
  const earBaseMat = keep(furMaterial(L, { ...furOpts, ...part(4), ear: true, skin: FUR.earSkin, side: THREE.DoubleSide, density: 190 }));
  const earShellMat = keep(furMaterial(L, { ...furOpts, ...part(4), ear: true, shells: true, skin: FUR.earSkin, density: 190 }));
  const ears = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(side * 0.215, 0.25, -0.07); pivot.rotation.set(-0.14, -side * 0.30, -side * 0.31, 'YXZ'); head.add(pivot);
    const swivel = new THREE.Group(); pivot.add(swivel);
    swivel.add(new THREE.Mesh(earG, earBaseMat));
    const sh = new THREE.Mesh(earSG, earShellMat); sh.frustumCulled = false; swivel.add(sh);
    ears.push({ side, pivot, swivel, twd: 1, tw0: -10, next: 2 + R() * 6 });
  }

  // strands: whiskers, brow whiskers, stray guard hairs (head); inner-ear hairs (per ear)
  const strandMat = keep(strandMaterial(L, res));
  const head2 = [];
  const white = [0.55, 0.54, 0.52];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 4; row++) for (let k = 0; k < 3; k++) {
      const x = side * (0.040 + 0.024 * k + 0.008 * row), y = -0.197 - 0.017 * row + 0.004 * k;
      const t = hit(headSdf, [x, y, 0.8], [0, 0, -1]); if (t < 0) continue;
      const root = [x, y, 0.8 - t - 0.004];
      const el = 0.12 - row * 0.075 + (R() - 0.5) * 0.06, fw = 0.32 + 0.12 * k - row * 0.04;
      const dir = norm3([side * Math.cos(el), Math.sin(el) + 0.02, fw]);
      head2.push({ root, dir, curl: [side * -0.05, -0.10 - 0.05 * R(), 0.10 + row * 0.03], len: 0.42 + 0.22 * (1 - Math.abs(row - 1.2) / 3) * (0.7 + 0.3 * k / 2) + R() * 0.06, width: 0.0034, col: white, phase: R() });
    }
    for (let k = 0; k < 4; k++) {
      const x = side * (0.11 + 0.025 * k), y = 0.115 + 0.012 * k;
      const t = hit(headSdf, [x, y, 0.8], [0, 0, -1]); if (t < 0) continue;
      head2.push({ root: [x, y, 0.8 - t], dir: norm3([side * (0.35 + 0.15 * k), 0.85, 0.45]), curl: [side * 0.12, -0.15, -0.05], len: 0.18 + 0.06 * k + R() * 0.04, width: 0.0034, col: [0.62, 0.61, 0.6], phase: R() });
    }
    for (let k = 0; k < 2; k++) {
      const x = side * 0.35, y = -0.06 - 0.03 * k, t = hit(headSdf, [x, y, 0.8], [0, 0, -1]); if (t < 0) continue;
      head2.push({ root: [x, y, 0.8 - t], dir: norm3([side * 0.9, 0.25, 0.1]), curl: [0, -0.1, -0.1], len: 0.22, width: 0.0028, col: [0.6, 0.6, 0.58], phase: R() });
    }
  }
  // stray guard hairs over the head (catch the rim light)
  for (let i = 0; i < C.strays; i++) {
    const vi = Math.floor(R() * hb.count), len = hb.ext[vi * 7]; if (len < 0.045) continue;
    const p = hb.pos.subarray(vi * 3, vi * 3 + 3), n = hb.nrm.subarray(vi * 3, vi * 3 + 3), c = hb.ext.subarray(vi * 7 + 4, vi * 7 + 7);
    if (n[2] > 0.75) continue;
    head2.push({ root: [p[0], p[1], p[2]], dir: norm3([n[0] * 0.55 + c[0], n[1] * 0.55 + c[1], n[2] * 0.55 + c[2]]), curl: [c[0] * 0.2, -0.05, c[2] * 0.2], len: len * (1.4 + R() * 0.9), width: 0.0022, col: [0.05, 0.045, 0.04], phase: R() });
  }
  const headStrands = new THREE.Mesh(keep(strandGeometry(head2, 10)), strandMat); headStrands.renderOrder = 5; headStrands.frustumCulled = false; head.add(headStrands);
  const earHairMat = keep(strandMaterial(L, res)); earHairMat.uniforms.uSwayAmp.value = 0.02;
  const earHairs = [], ep = [0, 0, 0], eq = [0, 0, 0];
  for (let i = 0; i < C.earHairs; i++) {
    const rim = R() < 0.5, v = 0.03 + R() * (rim ? 0.62 : 0.25), s = rim ? 0.53 + R() * 0.07 : 0.62 + R() * 0.3;
    earPoint(i & 1 ? s : 1.5 - s, v, ep);
    const sx = Math.sign(ep[0]) || 1;
    earHairs.push({ root: [ep[0], ep[1], ep[2] + 0.004], dir: norm3([-sx * (0.25 + R() * 0.5), 0.8, 0.45 + R() * 0.3]), curl: [sx * (0.1 + R() * 0.15), 0.05, 0.12], len: 0.04 + R() * 0.08 * (1 - v), width: 0.0011, col: TAB ? [0.75, 0.72, 0.68] : [0.5, 0.47, 0.45], phase: R() });
  }
  const earHairG = keep(strandGeometry(earHairs, 6));
  for (const e of ears) { const m = new THREE.Mesh(earHairG, earHairMat); m.renderOrder = 5; m.frustumCulled = false; e.swivel.add(m); }

  // body
  const bodyM = starMesh(bodySdf, [0, -0.55, -0.2], 1.4, C.bodyN, bodyAttr, 7);
  const bodyG = keep(furGeometry(bodyM));
  const body = new THREE.Group(); cat.add(body);
  const bodyMat = keep(furMaterial(L, { ...furOpts, ...part(1), density: 150, occP: new THREE.Vector3(0, -0.25, 0.15), occR: 0.3 }));
  const bodyShMat = keep(furMaterial(L, { ...furOpts, ...part(1), shells: true, density: 150, occP: new THREE.Vector3(0, -0.25, 0.15), occR: 0.3 }));
  body.add(new THREE.Mesh(bodyG, bodyMat));
  const bsh = new THREE.Mesh(keep(shellGeometry(bodyG, C.bodyShells)), bodyShMat); bsh.frustumCulled = false; body.add(bsh);

  // paw (+ claws)
  const pawM = starMesh(pawSdf, [0, 0.03, 0], 0.5, C.pawN, pawAttr, 7);
  const pawG = keep(furGeometry(pawM));
  const pawGrp = new THREE.Group(); pawGrp.position.set(0.31, -0.475, 0.735); pawGrp.rotation.set(0.30, -0.08, 0.04); pawGrp.scale.setScalar(1.12); cat.add(pawGrp);
  const pawTap = new THREE.Group(); pawTap.position.set(0, 0.06, -0.16); pawGrp.add(pawTap);
  const pawInner = new THREE.Group(); pawInner.position.set(0, -0.06, 0.16); pawTap.add(pawInner);
  pawInner.add(new THREE.Mesh(pawG, keep(furMaterial(L, { ...furOpts, ...part(3), density: 200, specK: TAB ? 1 : 1.7 }))));
  const psh = new THREE.Mesh(keep(shellGeometry(pawG, C.pawShells)), keep(furMaterial(L, { ...furOpts, ...part(3), shells: true, density: 200, specK: TAB ? 1 : 1.7 }))); psh.frustumCulled = false; pawInner.add(psh);
  const clawParts = TOES.map(([tx, ty, tz, r]) => { const g = new THREE.ConeGeometry(0.0055, 0.03, 6, 1); g.rotateX(Math.PI / 2 + 0.9); g.translate(tx * 1.02, ty - 0.012, tz + r * 1.05); return g; });
  const claws = new THREE.Mesh(keep(mergeGeometries(clawParts)), keep(simpleMaterial(L, res, [0.42, 0.38, 0.33], 0.6))); pawInner.add(claws);
  clawParts.forEach(g => g.dispose());

  // tail: joint chain driving a tube in the vertex shader
  const NJ = C.tailSeg, tailP = []; for (let i = 0; i < NJ; i++) tailP.push(new THREE.Vector3());
  const tailU = { value: tailP };
  const tailG = keep(tailGeometry(C.tailRings, quality === 'tv' ? 10 : 14));
  const tailBase = keep(furMaterial(L, { ...furOpts, ...part(2), tail: tailU, nj: NJ, density: 170, combK: 2.6 }));
  const tailShell = keep(furMaterial(L, { ...furOpts, ...part(2), tail: tailU, nj: NJ, shells: true, density: 170, combK: 2.6 }));
  const tail = new THREE.Mesh(tailG, tailBase); tail.frustumCulled = false; cat.add(tail);
  const tailS = new THREE.Mesh(keep(shellGeometry(tailG, C.tailShells)), tailShell); tailS.frustumCulled = false; cat.add(tailS);
  const TAIL0 = new THREE.Vector3(-0.66, -0.86, -0.30), SEG = 1.30 / (NJ - 1);
  const rest = []; for (let i = 0; i < NJ; i++) { const s = i / (NJ - 1); rest.push(i === 0 ? 0.16 : (s < 0.45 ? 0.03 : -0.34 * (s - 0.4) * 2.2)); }

  // ------------------------------------------------------------------ animation state (no allocations in update)
  const nz = [noise1(seed * 11 + 1), noise1(seed * 11 + 2), noise1(seed * 11 + 3), noise1(seed * 11 + 4), noise1(seed * 11 + 5)];
  const S = {
    mood: 'awake', hour: 20, gaze: null, gx: 0, gy: 0, tgx: 0, tgy: 0, nextLook: 0.5,
    eyeYaw: 0, eyePitch: 0, headYaw: 0, headPitch: 0, headRoll: 0, pyaw: 0, ppitch: 0,
    blinkT: -10, blinkDur: 0.26, nextBlink: 1.5 + R() * 3, doubleBlink: false, lid: 0, slowBlink: false,
    pupil: 0.55, tilt: 0, tiltT: -100, nextTilt: 8 + R() * 10, tiltDir: 1,
    flickT: -100, nextFlick: 3 + R() * 5, flickAmp: 1,
    pawT: -100, nextPaw: 18 + R() * 25, yawnT: -100, nextYawn: 30 + R() * 30,
    lagX: 0, lagY: 0,
  };
  const tmpV = new THREE.Vector3();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  let aspectNow = aspect;

  function screenToAngles(sx, sy) {
    // point on a plane between cat and viewer (where the UI "is"), relative to the head
    const zp = 3.2, d = CAM.z - zp;
    const x = CAM.x + (sx * 2 - 1) * tanHalf * aspectNow * d, y = CAM.y + (1 - sy * 2) * tanHalf * d;
    const dx = x, dy = y - 0.0, dz = zp - 0.25;
    S.tgx = Math.atan2(dx, dz); S.tgy = Math.atan2(dy, Math.hypot(dx, dz));
  }
  function pickIdleTarget() {
    const r = R();
    if (r < 0.4) screenToAngles(0.52 + (R() - 0.5) * 0.04, 0.47 + (R() - 0.5) * 0.04);       // at the viewer
    else if (r < 0.7) screenToAngles(0.2 + R() * 0.65, 0.55 + R() * 0.4);                    // somewhere on the screen/dock
    else screenToAngles(0.1 + R() * 0.8, 0.15 + R() * 0.5);                                   // around the room
  }

  let hourMix = hourBlend(20);
  function applyHour() {
    const [a, b, t] = hourMix, lerp = (k, i) => a[k][i] + (b[k][i] - a[k][i]) * t;
    L.uKeyCol.value.setRGB(lerp('key', 0), lerp('key', 1), lerp('key', 2));
    L.uKeyDir.value.set(lerp('kd', 0), lerp('kd', 1), lerp('kd', 2)).normalize();
    L.uRimCol.value.setRGB(lerp('rim', 0), lerp('rim', 1), lerp('rim', 2));
    L.uSky.value.setRGB(lerp('sky', 0), lerp('sky', 1), lerp('sky', 2));
    L.uGnd.value.setRGB(lerp('gnd', 0), lerp('gnd', 1), lerp('gnd', 2));
    bgMat.uniforms.uWall.value.setRGB(lerp('wall', 0), lerp('wall', 1), lerp('wall', 2));
    bgMat.uniforms.uLampK.value = a.lamp + (b.lamp - a.lamp) * t;
    L.uVig.value = a.vig + (b.vig - a.vig) * t;
  }
  applyHour();
  const pupilBase = () => { const [a, b, t] = hourMix; return a.pupil + (b.pupil - a.pupil) * t; };
  const ease = (x) => x * x * (3 - 2 * x);
  const bell = (t, d) => (t < 0 || t > d ? 0 : Math.sin(Math.PI * t / d) ** 2);

  function update(dt, t) {
    L.uTime.value = t;
    const v = camera.view;
    if (v && v.enabled) L.uView.value.set(v.offsetX / v.fullWidth, 1 - (v.offsetY + v.height) / v.fullHeight, v.width / v.fullWidth, v.height / v.fullHeight);
    else L.uView.value.set(0, 0, 1, 1);
    const mood = S.mood, sleepy = mood === 'sleepy', alert = mood === 'alert';

    // ---- gaze targets: eyes snap, head follows late
    if (S.gaze) screenToAngles(S.gaze[0], S.gaze[1]);
    else if (t >= S.nextLook) { pickIdleTarget(); S.nextLook = t + (sleepy ? 3 : 1.5) + R() * (sleepy ? 4 : 2.5); }
    const ke = 1 - Math.exp(-dt / 0.045), kh = 1 - Math.exp(-dt / (sleepy ? 0.9 : 0.5));
    const hyT = clamp(S.tgx * 0.6, -0.45, 0.45), hpT = clamp(S.tgy * 0.55, -0.3, 0.2);
    const py = S.headYaw, pp = S.headPitch;
    S.headYaw += (hyT - S.headYaw) * kh; S.headPitch += (hpT - S.headPitch) * kh;
    const eyT = clamp(S.tgx - S.headYaw, -0.42, 0.42), epT = clamp(S.tgy - S.headPitch, -0.3, 0.3);
    S.eyeYaw += (eyT - S.eyeYaw) * ke; S.eyePitch += (epT - S.eyePitch) * ke;
    // follow-through for fur (lags behind head rotation)
    const vy = (S.headYaw - py) / Math.max(dt, 1e-3), vp = (S.headPitch - pp) / Math.max(dt, 1e-3);
    S.lagX += (-vy * 0.25 - S.lagX) * (1 - Math.exp(-dt / 0.15)); S.lagY += (vp * 0.25 - S.lagY) * (1 - Math.exp(-dt / 0.15));
    lag.value.set(clamp(S.lagX, -0.4, 0.4), clamp(S.lagY, -0.4, 0.4), 0);

    // ---- idle head motion + curious tilt
    if (t >= S.nextTilt) { S.tiltT = t; S.tiltDir = R() < 0.5 ? -1 : 1; S.nextTilt = t + 9 + R() * 14; }
    const tilt = bell(t - S.tiltT, 2.8) * 0.16 * S.tiltDir;
    const breathRate = sleepy ? 0.42 : alert ? 0.58 : 0.5, bph = t * breathRate * Math.PI * 2 + nz[4](t * 0.1) * 0.6, breath = Math.sin(bph);
    let yawn = 0;
    if (sleepy && t >= S.nextYawn) { S.yawnT = t; S.nextYawn = t + 25 + R() * 30; }
    yawn = bell(t - S.yawnT, 3.0);
    neck.rotation.set(-S.headPitch * 0.8 + nz[0](t * 0.23) * 0.025 + (sleepy ? 0.06 : 0) - yawn * 0.22 + breath * 0.004,
      S.headYaw * 0.85 + nz[1](t * 0.17) * 0.03, -S.headYaw * 0.08 + nz[2](t * 0.19) * 0.035 + tilt, 'YXZ');
    head.rotation.set(-S.headPitch * 0.25, S.headYaw * 0.15, 0, 'YXZ');
    neck.position.y = -0.32 + breath * 0.004 - (sleepy ? 0.02 : 0);
    body.scale.set(1 + breath * 0.008, 1 + breath * 0.012, 1 + breath * 0.008);

    // ---- blinks
    if (t >= S.nextBlink) {
      S.blinkT = t; S.slowBlink = sleepy ? R() < 0.6 : R() < 0.12; S.blinkDur = S.slowBlink ? 0.9 + R() * 0.6 : 0.24 + R() * 0.06;
      S.doubleBlink = !S.slowBlink && R() < 0.2;
      S.nextBlink = t + (S.doubleBlink ? S.blinkDur + 0.12 : (sleepy ? 3 : 2.5) + R() * (sleepy ? 5 : 4.5));
    }
    const bt = (t - S.blinkT) / S.blinkDur;
    let close = 0;
    if (bt >= 0 && bt <= 1) close = bt < 0.35 ? ease(bt / 0.35) : bt < 0.45 ? 1 : 1 - ease((bt - 0.45) / 0.55);
    close = Math.max(close, yawn * 0.95);
    const openU = (sleepy ? 0.08 + 0.05 * Math.sin(t * 0.3) : alert ? 0.80 : 0.62) + S.eyePitch * 0.3;
    const openL = sleepy ? 0.42 : alert ? 0.62 : 0.52;
    const eu = mix(openU, -0.2, close), el = mix(openL, 0.12, close);
    // ---- pupils (light + mood)
    const pT = clamp(pupilBase() + (alert ? 0.3 : 0) - (sleepy ? 0.05 : 0), 0.05, 1);
    S.pupil += (pT - S.pupil) * (1 - Math.exp(-dt / 0.8));
    for (const e of eyes) {
      e.ball.rotation.set(-S.eyePitch, S.eyeYaw - e.side * 0.2 * 0.7, -e.side * 0.11, 'YXZ'); e.ball.updateMatrix();
      e.mat.uniforms.uBall.value.setFromMatrix4(e.ball.matrix);
      e.mat.uniforms.uPupil.value = S.pupil; e.mat.uniforms.uOpenU.value = eu; e.mat.uniforms.uOpenL.value = el;
    }

    // ---- ears: independent twitches, turn toward the gaze
    for (const e of ears) {
      if (t >= e.next) { e.tw0 = t; e.next = t + 4 + R() * 8; e.twd = R() < 0.5 ? 1 : -1; }
      const tw = bell(t - e.tw0, 0.32) * e.twd, back = bell(t - e.tw0 - 0.05, 0.5);
      const toward = clamp(S.tgx * (e.side > 0 ? 0.7 : 0.5) + (S.tgx * e.side > 0 ? 0.15 : -0.05) * Math.abs(S.tgx) * 4, -0.5, 0.5);
      e.swivel.rotation.set(-back * 0.25 - (sleepy ? 0.1 : 0) - yawn * 0.35, toward * 0.6 + tw * 0.35 + e.side * (alert ? -0.18 : sleepy ? 0.22 : 0) + nz[3](t * 0.3 + e.side * 5) * 0.06, e.side * yawn * 0.2, 'YXZ');
    }

    // ---- tail: travelling wave (base->tip delay) + slow drift + occasional tip flick
    if (t >= S.nextFlick) { S.flickT = t; S.flickAmp = 0.6 + R() * 0.6; S.nextFlick = t + (sleepy ? 8 : 3.5) + R() * (sleepy ? 10 : 6); }
    const fl = t - S.flickT, flick = fl >= 0 && fl < 1.2 ? Math.sin(fl * 9) * Math.exp(-fl * 3.2) * S.flickAmp : 0;
    const amp = sleepy ? 0.035 : alert ? 0.09 : 0.06, w = sleepy ? 0.6 : 1.0;
    let ang = 0, bang = 0, px = TAIL0.x, pyy = TAIL0.y, pz = TAIL0.z;
    for (let i = 0; i < NJ; i++) {
      const s = i / (NJ - 1);
      tailP[i].set(px, pyy, pz);
      const a = rest[i] + amp * Math.pow(s, 1.2) * Math.sin(t * w * 1.1 - s * 3.2) + nz[0](t * 0.11 + 3) * 0.08 * s + nz[1](t * 0.31 + 7) * 0.05 * s * s
        + flick * 0.35 * Math.pow(s, 3) * Math.sin(-s * 2.5);
      ang += a; bang += (i === 0 ? 0.18 : -0.012) + nz[2](t * 0.2 + i * 0.3) * 0.02 * s;
      const ca = Math.cos(bang);
      px += -Math.sin(ang) * ca * SEG; pyy += Math.cos(ang) * ca * SEG; pz += Math.sin(bang) * SEG;
    }

    // ---- paw tap (rare)
    if (t >= S.nextPaw) { S.pawT = t; S.nextPaw = t + 20 + R() * 30; }
    const pt = t - S.pawT, tap = bell(pt, 0.7) + bell(pt - 0.9, 0.7) * 0.7;
    pawTap.rotation.x = -tap * 0.22;
    occ[0].y = -0.47 + tap * 0.03; shad[1].y = -0.45 + tap * 0.03;

    // ---- whiskers follow breathing a little later; fur lag
    strandMat.uniforms.uSway.value = Math.sin(bph - 0.8) * 0.012 + S.lagY * 0.05;
    return;
  }

  function blanketGeometry(C, seed) {
    const NX = C.knitX, NY = C.knitY, x0 = -2.4, x1 = 2.4, Rr = 0.42, zc = 0.56, yc = -0.88, nzb = noise1(seed * 5 + 9);
    const pos = new Float32Array((NX + 1) * (NY + 1) * 3), nrm = new Float32Array(pos.length), tang = new Float32Array(pos.length), uv = new Float32Array((NX + 1) * (NY + 1) * 2), idx = [];
    const tile = 0.62;
    const prof = (u, x, out) => { // u 0..1 along the profile, denser near the crest
      const ph = -1.25 + 3.3 * (u < 0.5 ? 0.5 * Math.pow(u * 2, 1.25) : 1 - 0.5 * Math.pow((1 - u) * 2, 1.0));
      const r = Rr + 0.025 * nzb(x * 1.4) + 0.012 * nzb(x * 3.1 + 5) + 0.03 * Math.max(0, Math.sin(ph)) * nzb(x * 2.2 + 11) - 0.03 * Math.exp(-((x - 0.3) ** 2) * 30) * Math.exp(-((ph - 0.5) ** 2) * 4);
      out[0] = zc + r * Math.sin(ph); out[1] = yc + r * Math.cos(ph); out[2] = ph; return out;
    };
    const a = [0, 0, 0], b = [0, 0, 0];
    let v = 0;
    for (let j = 0; j <= NY; j++) {
      let arc = 0;
      for (let i = 0; i <= NX; i++) {
        const x = x0 + (x1 - x0) * i / NX, u = j / NY;
        prof(u, x, a);
        pos[v * 3] = x; pos[v * 3 + 1] = a[1]; pos[v * 3 + 2] = a[0];
        // normal from finite differences
        prof(u + 1e-3, x, b); const tzu = b[0] - a[0], tyu = b[1] - a[1];
        prof(u, x + 1e-3, b); const tzx = (b[0] - a[0]) / 1e-3, tyx = (b[1] - a[1]) / 1e-3;
        // tangent along x: (1, tyx, tzx); along u: (0, tyu, tzu); n = tu x tx (outward)
        let nx = tyu * tzx - tzu * tyx, ny = tzu * 1 - 0 * tzx, nz2 = 0 * tyx - tyu * 1;
        const l = Math.hypot(nx, ny, nz2) || 1; nx /= l; ny /= l; nz2 /= l;
        if (ny * Math.cos(a[2]) + nz2 * Math.sin(a[2]) < 0) { nx = -nx; ny = -ny; nz2 = -nz2; }
        nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz2;
        const tl = Math.hypot(1, tyx, tzx); tang[v * 3] = 1 / tl; tang[v * 3 + 1] = tyx / tl; tang[v * 3 + 2] = tzx / tl;
        uv[v * 2] = x / tile; uv[v * 2 + 1] = (a[2] * Rr) / tile;
        v++;
      }
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const p = j * (NX + 1) + i; idx.push(p, p + 1, p + NX + 2, p, p + NX + 2, p + NX + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('tang', new THREE.BufferAttribute(tang, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    // winding check: make faces point along the normals
    return g;
  }

  function tailGeometry(rings, radial) {
    const nv = (rings + 1) * (radial + 1), ta = new Float32Array(nv * 2), uv = new Float32Array(nv * 2), fa = new Float32Array(nv * 4), pos = new Float32Array(nv * 3), idx = [];
    let v = 0;
    for (let j = 0; j <= rings; j++) for (let i = 0; i <= radial; i++) {
      const s = j / rings, th = (i / radial) * Math.PI * 2;
      ta[v * 2] = s; ta[v * 2 + 1] = th; uv[v * 2] = s; uv[v * 2 + 1] = i / radial;
      fa[v * 4] = 0.08; fa[v * 4 + 1] = 1; pos[v * 3 + 1] = s; v++;
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) { const a = j * (radial + 1) + i; idx.push(a, a + radial + 1, a + radial + 2, a, a + radial + 2, a + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('tailA', new THREE.BufferAttribute(ta, 2));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('furA', new THREE.BufferAttribute(fa, 4)); g.setIndex(idx);
    return g;
  }

  update(0, 0);
  if (DBG) scene.traverse((o) => {
    if (!o.isMesh) return;
    const shell = !!o.geometry.isInstancedBufferGeometry;
    if (DBG.includes('noshell') && shell && o !== fuzz) o.visible = false;
    if (DBG.includes('nofuzz') && o === fuzz) o.visible = false;
    if (DBG.includes('noknit') && (o === fuzz || o === blanket)) o.visible = false;
    if (DBG.includes('nocat') && o !== fuzz && o !== blanket && o !== bg) o.visible = false;
  });
  return {
    scene, camera, update,
    resize(a) { aspectNow = a; camera.aspect = a; camera.updateProjectionMatrix(); },
    setGaze(x, y) { S.gaze = x == null ? null : [clamp(+x, 0, 1), clamp(+y, 0, 1)]; if (!S.gaze) S.nextLook = 0; },
    setMood(m) { S.mood = m === 'sleepy' || m === 'alert' ? m : 'awake'; S.nextBlink = 0; },
    setHour(h) { S.hour = +h || 0; hourMix = hourBlend(S.hour); applyHour(); },
    poke(kind) {
      const t = L.uTime.value;
      if (kind === 'blink') S.nextBlink = t;
      else if (kind === 'earTwitch') { ears[0].next = t; ears[1].next = t + 0.15; }
      else if (kind === 'tailFlick') S.nextFlick = t;
      else if (kind === 'pawTap') S.nextPaw = t;
      else if (kind === 'yawn') { S.yawnT = t; }
    },
    dispose() { for (const d of disposables) d.dispose?.(); },
    _dbg: DBG,
  };
}
