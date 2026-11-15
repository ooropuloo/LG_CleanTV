// 幾何:用 SDF 捏頭、耳朵、身體、前掌;尾巴是參數化管子(在 shader 裡沿骨架彎);毯子是參數化的捲毛布。
import * as THREE from 'three';
import { smin, smax, sdSphere, sdEllipsoid, sdCapsule, sdRoundCone, sdTri2, surfaceNets, traceSurface } from './sdf.js';
import { vnoise3, smoothstep, clamp, lerp } from './util.js';

// ---------------- 尺寸與位置(頭的區域座標:原點 = 頭中心,+z 朝鏡頭) ----------------
export const HEAD = { cx: 0, cy: 0.17, cz: 0 };             // 頭中心在 catRoot 裡的位置
export const NECK = { x: 0, y: -0.3, z: -0.3 };            // 頭部轉動的支點(catRoot 座標)
export const EYE = { x: 0.405, y: -0.03, z: 0.57, r: 0.285, yaw: 0.13 };
export const EAR = { x: 0.54, y: 0.52, z: -0.08, rx: -0.12, ry: 0.12, rz: -0.42 };  // 右耳;左耳鏡像

// 毛色(線性色彩)。每個部位一個函式,把毛色寫進 o;底層皮膚 = 毛色 × skinMul。
// black:幾乎全黑。tabby:屋主的貓 — 棕灰虎斑、M 字額紋、眼角黑線、鬍鬚墊黑點、白下巴、環紋尾、淺色前掌。
const BLACK_HAIR = [0.010, 0.011, 0.015];
const mixA = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const put = (o, v) => { o[0] = v[0]; o[1] = v[1]; o[2] = v[2]; return o; };
const blend = (o, v, t) => { o[0] += (v[0] - o[0]) * t; o[1] += (v[1] - o[1]) * t; o[2] += (v[2] - o[2]) * t; return o; };
const band = (d, w) => 1 - smoothstep(w * 0.55, w, Math.abs(d));      // 1 = 在條紋中心
export function coatPalette(coat) {
  if (coat === 'tabby') return tabbyPalette();
  return {
    id: 'black', skinMul: 0.8, tick: 0.06, rimMul: 1, sheenMul: 1, sheenCol: [0.35, 0.5, 1.0],
    head: (x, y, z, muz, o) => put(o, BLACK_HAIR),
    ear: (inner, edge, yy, o, skin) => (skin
      ? put(o, mixA([0.008, 0.009, 0.012], [0.6, 0.15, 0.07], inner * (0.55 + 0.45 * smoothstep(0.9, 0.2, yy))))
      : put(o, mixA(BLACK_HAIR, [0.32, 0.22, 0.22], inner))),
    body: (x, y, z, o) => put(o, BLACK_HAIR), paw: (x, y, z, o) => put(o, BLACK_HAIR), tail: (s, o) => put(o, BLACK_HAIR),
    nose: [0.30, 0.085, 0.10], noseEdge: 0, lid: [0.0096, 0.0108, 0.0144],
    eye: { irisIn: [0.85, 0.46, 0.06], irisMid: [0.66, 0.19, 0.016], irisOut: [0.3, 0.05, 0.006], limbal: [0.03, 0.008, 0.002], glow: [0.95, 0.42, 0.05], ring: [0.95, 0.66, 0.16] },
    earGlow: [0.7, 0.2, 0.07],
  };
}
function tabbyPalette() {
  const BASE = [0.125, 0.082, 0.048], WARM = [0.19, 0.1, 0.045], DARK = [0.012, 0.009, 0.007], CREAM = [0.3, 0.23, 0.15], WHITE = [0.58, 0.55, 0.5], BUFF = [0.26, 0.18, 0.1];
  return {
    id: 'tabby', skinMul: 0.55, tick: 0.32, rimMul: 0.5, sheenMul: 0.45, sheenCol: [1.0, 0.85, 0.65],
    head(x, y, z, muz, o) {
      const ax = Math.abs(x);
      put(o, BASE);
      // 鼻樑、眼睛下方偏暖
      blend(o, WARM, smoothstep(0.3, 0.6, z) * smoothstep(0.25, 0.0, ax) * smoothstep(0.15, -0.2, y));
      // 眼睛周圍淡色眼圈
      const de = Math.hypot(ax - 0.405, y + 0.03, z - 0.57) / 0.285;
      blend(o, CREAM, band(de - 1.18, 0.16) * 0.55);
      let d = 0;
      // 額頭條紋 + M 字(底部往外彎)
      const bend = Math.sign(x) * 0.07 * smoothstep(0.42, 0.22, y);
      const fx = (x - bend) / 0.105, k = Math.round(fx);
      if (Math.abs(k) <= 2 && y > 0.18) {
        const ak = Math.abs(k), bot = 0.2 + ak * 0.04 + (k === 0 ? 0.1 : 0), w = ak === 2 ? 0.34 : 0.42;
        d = Math.max(d, band(fx - k, w) * smoothstep(bot, bot + 0.05, y) * (ak === 2 ? smoothstep(0.95, 0.7, y) : 1));
      }
      // 頭頂往後的條紋
      if (y > 0.5) d = Math.max(d, band(Math.sin(x * 9.5), 0.35) * smoothstep(0.55, 0.75, y) * 0.9);
      // 眼角往後的黑線、臉頰的弧線
      if (ax > 0.58) {
        const u = ax - 0.6;
        d = Math.max(d, band(y - (-0.04 + 0.32 * u), 0.055) * smoothstep(0.58, 0.64, ax) * smoothstep(1.05, 0.85, ax));
        d = Math.max(d, band(y - (-0.24 + 0.22 * u), 0.05) * smoothstep(0.6, 0.68, ax) * smoothstep(1.05, 0.88, ax));
        d = Math.max(d, band(y - (-0.42 + 0.1 * u), 0.045) * smoothstep(0.68, 0.75, ax) * smoothstep(1.0, 0.85, ax) * 0.8);
      }
      // 臉側、後腦的鯖魚紋
      if (z < 0.35 && ax > 0.5) d = Math.max(d, band(Math.sin(y * 9 + ax * 4), 0.38) * smoothstep(0.35, 0.05, z) * 0.9);
      // 鬍鬚墊上的小黑點
      if (z > 0.45 && y < -0.3 && y > -0.45 && ax > 0.07 && ax < 0.27) {
        for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) {
          const sx = 0.11 + q * 0.05 + r * 0.012, sy = -0.335 - r * 0.035;
          d = Math.max(d, 1 - smoothstep(0.008, 0.015, Math.hypot(ax - sx, y - sy)));
        }
      }
      blend(o, DARK, d * 0.92);
      // 白下巴、白色上唇
      const chin = smoothstep(-0.36, -0.42, y) * smoothstep(0.3, 0.45, z) * smoothstep(0.34, 0.2, ax);
      const lip = smoothstep(-0.3, -0.36, y) * smoothstep(0.55, 0.65, z) * smoothstep(0.26, 0.12, ax);
      blend(o, WHITE, Math.max(chin, lip * 0.85));
      return o;
    },
    ear(inner, edge, yy, o, skin) {
      if (skin) return put(o, mixA([0.11, 0.075, 0.05], [0.55, 0.28, 0.24], inner));
      put(o, BASE);
      blend(o, DARK, Math.max(edge, smoothstep(0.55, 0.9, yy)) * (1 - inner));   // 黑色耳緣、耳尖
      blend(o, [0.62, 0.56, 0.52], inner);
      return o;
    },
    body(x, y, z, o) {
      put(o, BASE);
      const a = Math.atan2(x, z + 0.55);
      blend(o, DARK, band(Math.sin(a * 7 + y * 2.5), 0.32) * 0.85);
      return o;
    },
    paw(x, y, z, o) {
      put(o, BUFF);
      // 前臂上的橫紋
      const u = (y + 1.15) * 0.85 + (z + 0.05) * 0.55;
      blend(o, DARK, band(Math.sin(u * 12.0), 0.32) * smoothstep(1.1, 0.9, z) * 0.85);
      blend(o, DARK, band(Math.sin(z * 30.0 + 1.0), 0.3) * smoothstep(0.85, 0.95, z) * smoothstep(1.13, 1.06, z) * 0.75);
      // 腳趾淡一點
      blend(o, [0.42, 0.33, 0.22], smoothstep(1.05, 1.2, z) * 0.6);
      return o;
    },
    tail(s, o) {
      put(o, BASE);
      blend(o, DARK, Math.max(band(Math.sin(s * 31 + 0.6), 0.42) * smoothstep(0.08, 0.2, s), smoothstep(0.86, 0.92, s)) * 0.92);
      return o;
    },
    nose: [0.38, 0.11, 0.085], noseEdge: 0.75, lid: [0.016, 0.012, 0.009],
    eye: { irisIn: [0.6, 0.62, 0.1], irisMid: [0.2, 0.42, 0.05], irisOut: [0.05, 0.13, 0.025], limbal: [0.01, 0.018, 0.006], glow: [0.5, 0.65, 0.12], ring: [0.75, 0.72, 0.18] },
    earGlow: [0.45, 0.17, 0.12],
  };
}

// ---------------- 小工具 ----------------
function toGeometry(m, attrs) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  for (const k in attrs) g.setAttribute(k, new THREE.BufferAttribute(attrs[k].array, attrs[k].size));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}
// 把多個 {position, normal, index, attrs} 合成一個
function mergeParts(parts) {
  let nv = 0, ni = 0; for (const p of parts) { nv += p.position.length / 3; ni += p.index.length; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni), out = {};
  const keys = Object.keys(parts[0].attrs);
  for (const k of keys) out[k] = { array: new Float32Array(nv * parts[0].attrs[k].size), size: parts[0].attrs[k].size };
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.position, vo * 3); nor.set(p.normal, vo * 3);
    for (let i = 0; i < p.index.length; i++) idx[io + i] = p.index[i] + vo;
    for (const k of keys) out[k].array.set(p.attrs[k].array, vo * out[k].size);
    vo += p.position.length / 3; io += p.index.length;
  }
  return { position: pos, normal: nor, index: idx, attrs: out };
}
function furAttrs(n) {
  return { aSkin: { array: new Float32Array(n * 3), size: 3 }, aHair: { array: new Float32Array(n * 3), size: 3 }, aFur: { array: new Float32Array(n * 4), size: 4 } };
}
const set3 = (a, i, v) => { a[i * 3] = v[0]; a[i * 3 + 1] = v[1]; a[i * 3 + 2] = v[2]; };
const mix3 = (a, b, t, o) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; };

// ---------------- 頭 ----------------
export function headSdf(x, y, z) {
  const ax = Math.abs(x);
  let d = sdEllipsoid(x, y, z, 0, 0.12, -0.08, 0.96, 0.8, 0.82);
  d = smin(d, sdEllipsoid(ax, y, z, 0.5, -0.24, 0.02, 0.62, 0.46, 0.56), 0.3);      // 臉頰
  d = smin(d, sdEllipsoid(ax, y, z, 0.115, -0.36, 0.6, 0.2, 0.155, 0.2), 0.12);     // 鬍鬚墊
  d = smin(d, sdEllipsoid(x, y, z, 0, -0.27, 0.62, 0.15, 0.15, 0.2), 0.12);         // 鼻樑 / 上唇
  d = smin(d, sdEllipsoid(x, y, z, 0, -0.5, 0.5, 0.19, 0.12, 0.18), 0.12);          // 下巴
  d = smin(d, sdEllipsoid(ax, y, z, 0.36, 0.28, 0.5, 0.3, 0.13, 0.22), 0.14);       // 眉骨
  d = smin(d, sdCapsule(x, y, z, 0, -0.35, -0.25, 0, -1.25, -0.45, 0.6), 0.3);     // 脖子
  // 眼窩
  d = smax(d, -sdSphere(ax, y, z, EYE.x, EYE.y, EYE.z, EYE.r * 1.1), 0.07);
  return d;
}
// 右耳(耳朵區域座標:底部中心為原點,尖端朝 +y,內側朝 +z)
const EAR_H = 0.76;
function earSdf(x, y, z) {
  const tri = sdTri2(x, y, -0.48, -0.3, 0.48, -0.3, 0.06, EAR_H) - 0.06;
  const yy = clamp(y / EAR_H, -0.4, 1);
  const cup = 0.17 * (x / 0.4) * (x / 0.4) * (1 - yy * 0.55) - 0.07 * (1 - yy);
  const th = 0.034 * (1 - yy * 0.55) + 0.012;
  return smax(tri, Math.abs(z - cup) - th, 0.03);
}
function earMatrix(side) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(EAR.x * side, EAR.y, EAR.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(EAR.rx, EAR.ry * side, EAR.rz * side, 'YXZ')), new THREE.Vector3(1, 1, 1));
  return m;
}
export const EAR_PIVOT = (side) => new THREE.Vector3(EAR.x * side, EAR.y, EAR.z);

export function buildHead(quality, pal) {
  const tv = quality === 'tv';
  const head = surfaceNets(headSdf, [-1.25, -0.9, -0.32, 1.25, 1.05, 1.0], tv ? 0.062 : 0.036);
  const n = head.count, at = furAttrs(n), P = head.position, Nn = head.normal;
  const tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], ax = Math.abs(x);
    // 毛長
    let len = 0.05;
    const de = Math.hypot(ax - EYE.x, y - EYE.y, z - EYE.z) / EYE.r;
    len *= smoothstep(1.08, 1.45, de) * 0.85 + 0.15;                     // 眼睛周圍短
    const muz = smoothstep(0.42, 0.62, z) * smoothstep(-0.05, -0.25, y) * smoothstep(0.38, 0.18, ax);
    len *= 1 - muz * 0.55;                                                 // 嘴鼻短
    const nose = Math.hypot(x / 0.13, (y + 0.25) / 0.1, (z - 0.8) / 0.12);
    len *= 0.12 + 0.88 * smoothstep(0.85, 1.5, nose);
    len *= 1 + 0.55 * smoothstep(0.45, 0.85, ax) * smoothstep(0.1, -0.35, y); // 臉頰蓬
    pal.head(x, y, z, muz, tmp); set3(at.aHair.array, i, tmp);
    tmp[0] *= pal.skinMul; tmp[1] *= pal.skinMul; tmp[2] *= pal.skinMul; set3(at.aSkin.array, i, tmp);
    at.aFur.array[i * 4] = len; at.aFur.array[i * 4 + 1] = 1; at.aFur.array[i * 4 + 2] = 0; at.aFur.array[i * 4 + 3] = 0;
  }
  const parts = [{ position: head.position, normal: head.normal, index: head.index, attrs: at }];
  // 耳朵
  const earM = surfaceNets(earSdf, [-0.6, -0.32, -0.16, 0.6, EAR_H + 0.12, 0.26], tv ? 0.034 : 0.02);
  for (const side of [1, -1]) {
    const M = earMatrix(side), NM = new THREE.Matrix3().getNormalMatrix(M);
    const en = earM.count, pos = new Float32Array(en * 3), nor = new Float32Array(en * 3), ea = furAttrs(en);
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    for (let i = 0; i < en; i++) {
      const x = earM.position[i * 3], y = earM.position[i * 3 + 1], z = earM.position[i * 3 + 2];
      const nx = earM.normal[i * 3], ny = earM.normal[i * 3 + 1], nz = earM.normal[i * 3 + 2];
      const tri = sdTri2(x, y, -0.48, -0.3, 0.48, -0.3, 0.06, EAR_H);
      const front = smoothstep(0.1, 0.5, nz);                               // 內側
      const inner = front * smoothstep(-0.02, -0.11, tri) * smoothstep(-0.05, 0.12, y);
      const yy = y / EAR_H;
      v.set(x * side, y, z).applyMatrix4(M); nv.set(nx * side, ny, nz).applyMatrix3(NM).normalize();
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; nor[i * 3] = nv.x; nor[i * 3 + 1] = nv.y; nor[i * 3 + 2] = nv.z;
      const edge = smoothstep(-0.07, -0.015, tri);
      set3(ea.aSkin.array, i, pal.ear(inner, edge, yy, tmp, true));
      set3(ea.aHair.array, i, pal.ear(inner, edge, yy, tmp, false));
      let len = lerp(0.036, 0.04, inner);
      len *= 1 + 0.4 * smoothstep(0.75, 1.0, yy);                           // 耳尖的小簇毛
      ea.aFur.array[i * 4] = len;
      ea.aFur.array[i * 4 + 1] = lerp(1, 0.42, inner);
      ea.aFur.array[i * 4 + 2] = side * smoothstep(-0.12, 0.28, y);         // 耳朵骨架權重
      ea.aFur.array[i * 4 + 3] = inner;                                      // 透光
    }
    const idx = new Uint32Array(earM.index);
    if (side < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
    parts.push({ position: pos, normal: nor, index: idx, attrs: ea });
  }
  const m = mergeParts(parts);
  return toGeometry(m, m.attrs);
}

// ---------------- 身體(肩膀,大部分在毯子後面) ----------------
function bodySdf(x, y, z) {
  let d = sdEllipsoid(x, y, z, 0.0, -1.15, -0.55, 1.08, 0.72, 0.7);
  d = smin(d, sdEllipsoid(x, y, z, 0.55, -0.95, -0.15, 0.42, 0.42, 0.42), 0.25);
  d = smin(d, sdEllipsoid(x, y, z, -0.55, -1.0, -0.25, 0.4, 0.4, 0.4), 0.25);
  return d;
}
export function buildBody(quality, pal) {
  const tv = quality === 'tv';
  const m = surfaceNets(bodySdf, [-1.25, -1.0, -0.9, 1.25, -0.35, 0.4], tv ? 0.08 : 0.05);
  const at = furAttrs(m.count);
  const tmp = [0, 0, 0];
  for (let i = 0; i < m.count; i++) { pal.body(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2], tmp); set3(at.aHair.array, i, tmp); tmp[0] *= pal.skinMul; tmp[1] *= pal.skinMul; tmp[2] *= pal.skinMul; set3(at.aSkin.array, i, tmp); at.aFur.array[i * 4] = 0.06; at.aFur.array[i * 4 + 1] = 1; }
  return toGeometry(m, at);
}

// ---------------- 前掌(catRoot 座標,支點在肩膀) ----------------
export const PAW = { sx: 0.62, sy: -1.15, sz: -0.05, px: 0.74, py: -0.6, pz: 1.06 };
function pawSdf(x, y, z) {
  const P = PAW;
  let d = sdRoundCone(x, y, z, P.sx, P.sy, P.sz, P.px - 0.01, P.py + 0.02, P.pz - 0.18, 0.17, 0.135);
  d = smin(d, sdEllipsoid(x, y, z, P.px, P.py, P.pz, 0.2, 0.12, 0.2), 0.1);
  // 四顆趾頭(前面、往下掛在毯子邊上)
  for (let k = 0; k < 4; k++) {
    const u = (k - 1.5) / 1.5, tx = P.px + u * 0.145, ty = P.py - 0.05 - Math.abs(u) * 0.025, tz = P.pz + 0.16 - u * u * 0.06;
    d = smin(d, sdEllipsoid(x, y, z, tx, ty, tz, 0.075, 0.075, 0.08), 0.018);
  }
  return d;
}
export function buildPaw(quality, pal) {
  const tv = quality === 'tv';
  const m = surfaceNets(pawSdf, [0.3, -1.0, -0.3, 1.05, -0.38, 1.35], tv ? 0.04 : 0.026);
  const at = furAttrs(m.count);
  const tmp = [0, 0, 0];
  for (let i = 0; i < m.count; i++) {
    pal.paw(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2], tmp); set3(at.aHair.array, i, tmp); tmp[0] *= pal.skinMul; tmp[1] *= pal.skinMul; tmp[2] *= pal.skinMul; set3(at.aSkin.array, i, tmp);
    at.aFur.array[i * 4] = 0.035; at.aFur.array[i * 4 + 1] = 1;
  }
  return toGeometry(m, at);
}

// ---------------- 尾巴(管子;頂點存 s、角度、半徑,形狀在 shader 裡算) ----------------
export const TAIL_N = 20;
export function buildTail(quality, pal) {
  const tv = quality === 'tv';
  const R = tv ? 34 : 60, C = tv ? 10 : 16;
  const nv = (R + 1) * (C + 1), pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), at = furAttrs(nv);
  let i = 0; const tcol = [0, 0, 0];
  for (let r = 0; r <= R; r++) {
    const s = r / R;
    let rad = 0.14 - 0.03 * smoothstep(0, 0.55, s) + 0.015 * smoothstep(0.6, 0.9, s);
    let cap = 0;
    if (s > 0.93) { const u = (s - 0.93) / 0.07; rad *= Math.sqrt(Math.max(0, 1 - u * u)); cap = u; }
    for (let c = 0; c <= C; c++, i++) {
      pos[i * 3] = s; pos[i * 3 + 1] = (c / C) * Math.PI * 2; pos[i * 3 + 2] = rad;
      nor[i * 3] = cap;
      pal.tail(s, tcol); set3(at.aHair.array, i, tcol); tcol[0] *= pal.skinMul; tcol[1] *= pal.skinMul; tcol[2] *= pal.skinMul; set3(at.aSkin.array, i, tcol);
      at.aFur.array[i * 4] = 0.085 + 0.035 * smoothstep(0.5, 1, s); at.aFur.array[i * 4 + 1] = 1;
    }
  }
  const idx = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const a = r * (C + 1) + c, b = a + 1, d = a + (C + 1), e = d + 1;
    idx.push(a, b, d, b, e, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  for (const k in at) g.setAttribute(k, new THREE.BufferAttribute(at[k].array, at[k].size));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  return g;
}

// ---------------- 毯子 ----------------
const PROF = [[-1.4, -0.82], [-0.5, -0.74], [0.25, -0.64], [0.75, -0.565], [1.02, -0.545], [1.24, -0.6], [1.42, -0.78], [1.54, -1.08], [1.6, -1.55], [1.63, -2.4]];
function profile(v, out) {
  const n = PROF.length - 1, f = clamp(v, 0, 1) * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
  const p0 = PROF[Math.max(i - 1, 0)], p1 = PROF[i], p2 = PROF[i + 1], p3 = PROF[Math.min(i + 2, n)];
  const t2 = t * t, t3 = t2 * t;
  for (let k = 0; k < 2; k++) out[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  return out;
}
export const ridgeWave = (x) => 0.028 * Math.sin(1.25 * x + 0.4) + 0.016 * Math.sin(2.7 * x + 2.1);
// 毯子在 (x,z) 的頂面高度(給貓掌找落點)
export function blanketTopY(x, z) {
  const o = [0, 0]; let best = -9;
  for (let k = 0; k <= 200; k++) { profile(k / 200, o); if (Math.abs(o[0] - z) < 0.03 && o[1] > best) best = o[1]; }
  return best + ridgeWave(x) * smoothstep(-0.6, 0.6, z);
}
export function buildBlanket(quality, pawWorld) {
  const tv = quality === 'tv';
  const U = tv ? 96 : 170, Vn = tv ? 30 : 54, x0 = -3.7, x1 = 3.7;
  const nv = (U + 1) * (Vn + 1), pos = new Float32Array(nv * 3);
  const o = [0, 0], o2 = [0, 0];
  let i = 0;
  for (let v = 0; v <= Vn; v++) {
    // 讓頂部(看得到的稜線)取樣密一點
    const vv = v / Vn, vs = vv < 0.5 ? 0.5 * Math.pow(vv * 2, 0.8) : vv;
    profile(vs, o); profile(Math.min(1, vs + 0.002), o2);
    let tz = o2[0] - o[0], ty = o2[1] - o[1]; const tl = Math.hypot(tz, ty) || 1; tz /= tl; ty /= tl;
    const nz = ty, ny = -tz;   // 剖面法線(朝外)
    for (let u = 0; u <= U; u++, i++) {
      const x = x0 + (x1 - x0) * u / U;
      let y = o[1] + ridgeWave(x) * smoothstep(-0.6, 0.6, o[0]), z = o[0];
      // 大的波浪 + 捲毛團
      let d = (vnoise3(x * 1.5, y * 1.5 + 3.1, z * 1.5) - 0.5) * 0.12 * smoothstep(0.9, 1.4, z);
      d += (vnoise3(x * 5.5, y * 5.5, z * 5.5) - 0.5) * 0.055 + (vnoise3(x * 12, y * 12, z * 12) - 0.5) * 0.02;
      let px = x, py = y + ny * d, pz = z + nz * d;
      // 貓掌壓下去的凹陷
      if (pawWorld) {
        const dx = px - pawWorld.x, dz = pz - pawWorld.z, w = Math.exp(-(dx * dx) / 0.05 - (dz * dz) / 0.06);
        py -= 0.05 * w;
      }
      pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
    }
  }
  const idx = [];
  for (let v = 0; v < Vn; v++) for (let u = 0; u < U; u++) {
    const a = v * (U + 1) + u, b = a + 1, c = a + (U + 1), d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  // 繞向檢查:頂部法線要朝上
  const nr = g.getAttribute('normal'); let sy = 0; for (let k = 0; k < nr.count; k += 7) sy += nr.getY(k);
  if (sy < 0) { const ix = g.index.array; for (let t = 0; t < ix.length; t += 3) { const s = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = s; } g.computeVertexNormals(); }
  const at = furAttrs(nv);
  for (let k = 0; k < nv; k++) { set3(at.aSkin.array, k, [0.085, 0.17, 0.38]); set3(at.aHair.array, k, [0.17, 0.3, 0.6]); at.aFur.array[k * 4] = 0.075; at.aFur.array[k * 4 + 1] = 1; }
  for (const k in at) g.setAttribute(k, new THREE.BufferAttribute(at[k].array, at[k].size));
  return g;
}

// ---------------- 鼻子 ----------------
function noseSdf(x, y, z) {
  // 圓角倒三角,微微鼓起
  const tri = sdTri2(x, y, -0.085, 0.035, 0.085, 0.035, 0, -0.055) - 0.028;
  const d = Math.max(tri, Math.abs(z) - 0.035) ;
  return smin(d, sdEllipsoid(x, y, z, 0, 0.0, -0.02, 0.1, 0.06, 0.06), 0.03);
}
export function buildNose(quality) {
  const m = surfaceNets(noseSdf, [-0.16, -0.12, -0.12, 0.16, 0.1, 0.1], quality === 'tv' ? 0.009 : 0.006);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}

// 在頭的表面上找點:從 (x,y) 前方往 -z 射
export function onHead(x, y, out, push = 0) {
  traceSurface(headSdf, x, y, 1.6, 0, 0, -1, out);
  out[2] += push;
  return out;
}

// ---------------- 嘴巴(細管) ----------------
export function buildMouth() {
  const o = [0, 0, 0];
  const pts = (arr) => arr.map(([x, y]) => { onHead(x, y, o, 0.004); return new THREE.Vector3(o[0], o[1], o[2]); });
  const curves = [
    pts([[0, -0.335], [0, -0.37], [0, -0.40]]),
    pts([[0, -0.40], [-0.035, -0.43], [-0.08, -0.432], [-0.12, -0.41]]),
    pts([[0, -0.40], [0.035, -0.43], [0.08, -0.432], [0.12, -0.41]]),
  ];
  const geos = curves.map((c) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(c), 16, 0.0075, 6, false));
  return mergeBuffer(geos);
}
function mergeBuffer(geos) {
  const parts = geos.map((g) => { const ix = g.index ? g.index.array : Array.from({ length: g.attributes.position.count }, (_, k) => k); return { position: g.attributes.position.array, normal: g.attributes.normal.array, index: ix, attrs: {} }; });
  let nv = 0, ni = 0; for (const p of parts) { nv += p.position.length / 3; ni += p.index.length; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni); let vo = 0, io = 0;
  for (const p of parts) { pos.set(p.position, vo * 3); nor.set(p.normal, vo * 3); for (let k = 0; k < p.index.length; k++) idx[io + k] = p.index[k] + vo; vo += p.position.length / 3; io += p.index.length; }
  geos.forEach((g) => g.dispose());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// ---------------- 鬍鬚(朝鏡頭的細帶) ----------------
export function buildWhiskers(rng) {
  const SEG = 14, list = [];
  const o = [0, 0, 0];
  for (const side of [1, -1]) {
    // 嘴邊 6 根
    for (let k = 0; k < 6; k++) {
      const rx = 0.13 + 0.045 * (k % 3), ry = -0.33 - 0.035 * Math.floor(k / 2) - 0.012 * k;
      onHead(rx * side, ry, o, -0.01);
      const ang = 0.28 - k * 0.11 + (rng() - 0.5) * 0.06;
      list.push({ root: [o[0], o[1], o[2]], dir: [Math.cos(ang) * side, Math.sin(ang), 0.22], len: 0.95 + rng() * 0.35, droop: 0.1 + rng() * 0.08, w: 0.0055, side });
    }
    // 眉毛 3 根
    for (let k = 0; k < 3; k++) {
      onHead((0.36 + k * 0.06) * side, 0.3 - k * 0.012, o, -0.01);
      const ang = 0.78 - k * 0.16;
      list.push({ root: [o[0], o[1], o[2]], dir: [Math.cos(ang) * side, Math.sin(ang), 0.5], len: 0.22 + rng() * 0.07, droop: 0.05, w: 0.004, side });
    }
  }
  const nv = list.length * (SEG + 1) * 2, pos = new Float32Array(nv * 3), aw = new Float32Array(nv * 2), idx = [];
  let i = 0;
  for (const w of list) {
    const dl = Math.hypot(...w.dir), dx = w.dir[0] / dl, dy = w.dir[1] / dl, dz = w.dir[2] / dl;
    const base = i;
    for (let s = 0; s <= SEG; s++) {
      const u = s / SEG, L = w.len * u;
      // 往外伸、稍微往下垂、往前彎
      const x = w.root[0] + dx * L, y = w.root[1] + dy * L - w.droop * u * u * w.len, z = w.root[2] + dz * L - 0.12 * u * u * w.len;
      // 切線在 xy 平面的垂直方向
      const tx = dx, ty = dy - 2 * w.droop * u; const tl = Math.hypot(tx, ty) || 1;
      const px = -ty / tl, py = tx / tl, wd = w.w * (1 - 0.75 * u);
      for (const sd of [-1, 1]) {
        pos[i * 3] = x + px * wd * sd; pos[i * 3 + 1] = y + py * wd * sd; pos[i * 3 + 2] = z;
        aw[i * 2] = u; aw[i * 2 + 1] = sd; i++;
      }
    }
    for (let s = 0; s < SEG; s++) { const a = base + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aW', new THREE.BufferAttribute(aw, 2));
  g.setIndex(idx);
  return g;
}

// ---------------- 3D 雜訊貼圖(毛的「一根一根」) ----------------
export function makeNoise3D(size = 64, seed = 1) {
  const data = new Uint8Array(size * size * size);
  let a = seed * 2654435761 >>> 0;
  for (let k = 0; k < data.length; k++) { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; a >>>= 0; data[k] = a & 255; }
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}
