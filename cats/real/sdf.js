// Signed-distance helpers + "star" mesher: a cube-sphere whose vertices are pushed out along rays from a
// centre until they hit the SDF surface. Gives smooth, well-spread vertices with per-face UVs (for fur strands).
export const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export const smax = (a, b, k) => -smin(-a, -b, k);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mix = (a, b, t) => a + (b - a) * t;

// IQ's ellipsoid bound
export function ell(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = (px - cx) / rx, y = (py - cy) / ry, z = (pz - cz) / rz;
  const k0 = Math.sqrt(x * x + y * y + z * z);
  const x1 = x / rx, y1 = y / ry, z1 = z / rz, k1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}
export function cap(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax, pay = py - ay, paz = pz - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}
// capsule with radius varying from ra to rb
export function capR(px, py, pz, ax, ay, az, bx, by, bz, ra, rb) {
  const pax = px - ax, pay = py - ay, paz = pz - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
}
export const sph = (px, py, pz, cx, cy, cz, r) => Math.hypot(px - cx, py - cy, pz - cz) - r;

const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

// sdf(x,y,z) -> distance. attr(p, n, out) fills per-vertex extras. Returns plain arrays.
export function starMesh(sdf, c, rmax, N, attr, extraSize = 0) {
  const nv = 6 * (N + 1) * (N + 1), pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const ext = extraSize ? new Float32Array(nv * extraSize) : null, ao = new Float32Array(nv);
  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(6 * N * N * 6);
  const p = [0, 0, 0], n = [0, 0, 0], out = new Float32Array(Math.max(1, extraSize));
  let v = 0, k = 0;
  for (let f = 0; f < 6; f++) {
    const [F, U, V] = FACES[f], base = v;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const a = -1 + (2 * i) / N, b = -1 + (2 * j) / N, ta = Math.tan(a * Math.PI / 4), tb = Math.tan(b * Math.PI / 4);
      let dx = F[0] + U[0] * ta + V[0] * tb, dy = F[1] + U[1] * ta + V[1] * tb, dz = F[2] + U[2] * ta + V[2] * tb;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      // sphere-trace inward from rmax: finds the outermost crossing
      let t = rmax;
      for (let it = 0; it < 120; it++) {
        const d = sdf(c[0] + dx * t, c[1] + dy * t, c[2] + dz * t);
        if (d < 2e-4) break;
        t -= Math.max(d * 0.8, 4e-4);
        if (t < 0.01) { t = 0.01; break; }
      }
      // refine by bisection on [t, t + step]
      let lo = t, hi = t + 0.004;
      if (sdf(c[0] + dx * hi, c[1] + dy * hi, c[2] + dz * hi) > 0) for (let it = 0; it < 10; it++) {
        const m = (lo + hi) / 2; if (sdf(c[0] + dx * m, c[1] + dy * m, c[2] + dz * m) > 0) hi = m; else lo = m;
      }
      t = (lo + hi) / 2;
      const px = c[0] + dx * t, py = c[1] + dy * t, pz = c[2] + dz * t, e = 0.0025;
      let nx = sdf(px + e, py, pz) - sdf(px - e, py, pz), ny = sdf(px, py + e, pz) - sdf(px, py - e, pz), nz = sdf(px, py, pz + e) - sdf(px, py, pz - e);
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      // ambient occlusion from the field
      let occ = 0;
      for (let s = 1; s <= 5; s++) { const h = 0.018 * s * s * 0.6 + 0.01; const d = sdf(px + nx * h, py + ny * h, pz + nz * h); occ += Math.max(0, h - d) / h / s; }
      ao[v] = clamp(1 - occ * 0.55, 0, 1);
      pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz; nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
      const R = t * Math.PI / 4; uv[v * 2] = a * R + f * 7.31; uv[v * 2 + 1] = b * R + f * 3.17;
      if (attr) { p[0] = px; p[1] = py; p[2] = pz; n[0] = nx; n[1] = ny; n[2] = nz; attr(p, n, out, ao[v]); ext.set(out.subarray(0, extraSize), v * extraSize); }
      v++;
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = base + j * (N + 1) + i, b = a + 1, cc = a + N + 2, d = a + N + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = cc; idx[k++] = a; idx[k++] = cc; idx[k++] = d;
    }
  }
  return { pos, nrm, uv, idx, ext, ao, count: nv };
}

// march from o along unit dir until the surface; returns t or -1
export function hit(sdf, o, d, tmax = 3) {
  let t = 0;
  for (let i = 0; i < 200 && t < tmax; i++) { const s = sdf(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t); if (s < 1e-4) return t; t += Math.max(s * 0.8, 2e-4); }
  return -1;
}
export function grad(sdf, x, y, z, out) {
  const e = 0.002; out[0] = sdf(x + e, y, z) - sdf(x - e, y, z); out[1] = sdf(x, y + e, z) - sdf(x, y - e, z); out[2] = sdf(x, y, z + e) - sdf(x, y, z - e);
  const l = Math.hypot(out[0], out[1], out[2]) || 1; out[0] /= l; out[1] /= l; out[2] /= l; return out;
}

export function rng(seed) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// smooth 1D value noise with a seeded table (deterministic, allocation-free at runtime)
export function noise1(seed) {
  const r = rng(seed), T = new Float32Array(256); for (let i = 0; i < 256; i++) T[i] = r() * 2 - 1;
  return (x) => { const i = Math.floor(x), f = x - i, a = T[i & 255], b = T[(i + 1) & 255], u = f * f * (3 - 2 * f); return a + (b - a) * u; };
}
