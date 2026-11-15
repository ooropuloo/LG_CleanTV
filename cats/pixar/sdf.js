// 有號距離場(SDF)基本形狀 + surface nets 網格化。
// 模型全部用 SDF「捏」出來,再轉成三角網格;法線取 SDF 梯度,所以表面是平滑的。

export const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };

export function sdSphere(x, y, z, cx, cy, cz, r) {
  const dx = x - cx, dy = y - cy, dz = z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}
// iq 的橢球近似距離
export function sdEllipsoid(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = x - cx, py = y - cy, pz = z - cz;
  const ax = px / rx, ay = py / ry, az = pz / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  if (k0 < 1e-5) return -Math.min(rx, ry, rz);
  const bx = ax / rx, by = ay / ry, bz = az / rz;
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return k0 * (k0 - 1) / k1;
}
export function sdCapsule(x, y, z, ax, ay, az, bx, by, bz, r) {
  const pax = x - ax, pay = y - ay, paz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  let h = (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}
// 兩端半徑不同的圓錐膠囊(iq)
export function sdRoundCone(x, y, z, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const yy = pax * bax + pay * bay + paz * baz, zz = yy - l2;
  const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}
// 二維三角形的精確距離(iq)
export function sdTri2(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay, e1x = cx - bx, e1y = cy - by, e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay, v1x = px - bx, v1y = py - by, v2x = px - cx, v2y = py - cy;
  let t0 = (v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y); t0 = t0 < 0 ? 0 : t0 > 1 ? 1 : t0;
  let t1 = (v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y); t1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
  let t2 = (v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y); t2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
  const q0x = v0x - e0x * t0, q0y = v0y - e0y * t0, q1x = v1x - e1x * t1, q1y = v1y - e1y * t1, q2x = v2x - e2x * t2, q2y = v2y - e2y * t2;
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d = Math.min(q0x * q0x + q0y * q0y, q1x * q1x + q1y * q1y, q2x * q2x + q2y * q2y);
  const sg = Math.min(s * (v0x * e0y - v0y * e0x), s * (v1x * e1y - v1y * e1x), s * (v2x * e2y - v2y * e2x));
  return -Math.sqrt(d) * Math.sign(sg);
}

// SDF 梯度(中央差分),寫進 out[0..2](已正規化),回傳梯度長度
export function sdfGrad(f, x, y, z, h, out) {
  const gx = f(x + h, y, z) - f(x - h, y, z), gy = f(x, y + h, z) - f(x, y - h, z), gz = f(x, y, z + h) - f(x, y, z - h);
  const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  out[0] = gx / l; out[1] = gy / l; out[2] = gz / l;
  return l / (2 * h);
}

// 從 (ox,oy,oz) 沿方向 d 走到表面(sphere tracing),回傳走的距離;out 是命中點
export function traceSurface(f, ox, oy, oz, dx, dy, dz, out, maxT = 6) {
  let t = 0;
  for (let i = 0; i < 96; i++) {
    const d = f(ox + dx * t, oy + dy * t, oz + dz * t);
    if (Math.abs(d) < 5e-4 || t > maxT) break;
    t += d * 0.8;
  }
  out[0] = ox + dx * t; out[1] = oy + dy * t; out[2] = oz + dz * t;
  return t;
}

const CORNER = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];
const EDGE = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

/**
 * Naive surface nets。
 * f(x,y,z) → 距離(內部為負);bounds = [x0,y0,z0,x1,y1,z1];cell = 格子邊長。
 * 邊界上的面不會封口(故意的:看不到的背面直接切掉省三角形)。
 * 回傳 { position, normal, index, count }(Float32Array / Uint32Array)。
 */
export function surfaceNets(f, bounds, cell, opt = {}) {
  const x0 = bounds[0], y0 = bounds[1], z0 = bounds[2];
  const nx = Math.max(3, Math.ceil((bounds[3] - x0) / cell) + 1), ny = Math.max(3, Math.ceil((bounds[4] - y0) / cell) + 1), nz = Math.max(3, Math.ceil((bounds[5] - z0) / cell) + 1);
  const nxy = nx * ny, fld = new Float32Array(nxy * nz);
  // 1) 取樣。先用 4³ 的區塊中心判斷離表面夠遠就整塊跳過(SDF 是距離的下界,安全)。
  const B = 4, far = Math.sqrt(3) * 0.5 * (B - 1) * cell * 1.7 + cell * 1.5;
  for (let bk = 0; bk < nz; bk += B) for (let bj = 0; bj < ny; bj += B) for (let bi = 0; bi < nx; bi += B) {
    const i1 = Math.min(bi + B, nx), j1 = Math.min(bj + B, ny), k1 = Math.min(bk + B, nz);
    const fc = f(x0 + (bi + i1 - 1) * 0.5 * cell, y0 + (bj + j1 - 1) * 0.5 * cell, z0 + (bk + k1 - 1) * 0.5 * cell);
    if (Math.abs(fc) > far) {
      for (let k = bk; k < k1; k++) for (let j = bj; j < j1; j++) { const o = nxy * k + nx * j; for (let i = bi; i < i1; i++) fld[o + i] = fc; }
    } else {
      for (let k = bk; k < k1; k++) for (let j = bj; j < j1; j++) { const o = nxy * k + nx * j, y = y0 + j * cell, z = z0 + k * cell; for (let i = bi; i < i1; i++) fld[o + i] = f(x0 + i * cell, y, z); }
    }
  }
  // 2) 每個有變號的格子放一個頂點(各邊交點的平均)
  const cnx = nx - 1, cny = ny - 1, cnz = nz - 1, cnxy = cnx * cny;
  const vid = new Int32Array(cnxy * cnz).fill(-1);
  let cap = 8192, pos = new Float32Array(cap * 3), nv = 0;
  const cv = new Float32Array(8);
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++) {
    const o = nxy * k + nx * j + i;
    cv[0] = fld[o]; cv[1] = fld[o + 1]; cv[2] = fld[o + nx]; cv[3] = fld[o + nx + 1];
    cv[4] = fld[o + nxy]; cv[5] = fld[o + nxy + 1]; cv[6] = fld[o + nxy + nx]; cv[7] = fld[o + nxy + nx + 1];
    let neg = 0; for (let c = 0; c < 8; c++) if (cv[c] < 0) neg++;
    if (neg === 0 || neg === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let e = 0; e < 12; e++) {
      const a = EDGE[e * 2], b = EDGE[e * 2 + 1], va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += CORNER[a * 3] + (CORNER[b * 3] - CORNER[a * 3]) * t;
      sy += CORNER[a * 3 + 1] + (CORNER[b * 3 + 1] - CORNER[a * 3 + 1]) * t;
      sz += CORNER[a * 3 + 2] + (CORNER[b * 3 + 2] - CORNER[a * 3 + 2]) * t;
      n++;
    }
    if (nv === cap) { cap *= 2; const np = new Float32Array(cap * 3); np.set(pos); pos = np; }
    pos[nv * 3] = x0 + (i + sx / n) * cell; pos[nv * 3 + 1] = y0 + (j + sy / n) * cell; pos[nv * 3 + 2] = z0 + (k + sz / n) * cell;
    vid[cnxy * k + cnx * j + i] = nv++;
  }
  // 3) 頂點貼回真正的表面(牛頓法)+ 法線
  const g = [0, 0, 0], nor = new Float32Array(nv * 3), refine = opt.refine == null ? 2 : opt.refine, hN = opt.normalEps || cell * 0.5, lim = cell * 0.6;
  for (let v = 0; v < nv; v++) {
    let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    for (let it = 0; it < refine; it++) {
      const d = f(x, y, z), gl = sdfGrad(f, x, y, z, cell * 0.25, g);
      let s = d / Math.max(gl, 0.35); s = s > lim ? lim : s < -lim ? -lim : s;
      x -= g[0] * s; y -= g[1] * s; z -= g[2] * s;
    }
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    sdfGrad(f, x, y, z, hN, g);
    nor[v * 3] = g[0]; nor[v * 3 + 1] = g[1]; nor[v * 3 + 2] = g[2];
  }
  // 4) 每條變號的格線產生一個四邊形(接周圍四個格子的頂點)
  let icap = 16384, idx = new Uint32Array(icap), ni = 0;
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (ni + 6 > icap) { icap *= 2; const n2 = new Uint32Array(icap); n2.set(idx); idx = n2; }
    if (flip) { const t = b; b = d; d = t; }
    // 沿較短的對角線切
    const ax = pos[a * 3] - pos[c * 3], ay = pos[a * 3 + 1] - pos[c * 3 + 1], az = pos[a * 3 + 2] - pos[c * 3 + 2];
    const bx = pos[b * 3] - pos[d * 3], by = pos[b * 3 + 1] - pos[d * 3 + 1], bz = pos[b * 3 + 2] - pos[d * 3 + 2];
    if (ax * ax + ay * ay + az * az <= bx * bx + by * by + bz * bz) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
    else { idx[ni++] = a; idx[ni++] = b; idx[ni++] = d; idx[ni++] = b; idx[ni++] = c; idx[ni++] = d; }
  };
  const V = (i, j, k) => vid[cnxy * k + cnx * j + i];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = nxy * k + nx * j + i, v0 = fld[o], in0 = v0 < 0;
    if (i < nx - 1 && j > 0 && j < ny - 1 && k > 0 && k < nz - 1 && (fld[o + 1] < 0) !== in0) quad(V(i, j - 1, k - 1), V(i, j, k - 1), V(i, j, k), V(i, j - 1, k), !in0);
    if (j < ny - 1 && i > 0 && i < nx - 1 && k > 0 && k < nz - 1 && (fld[o + nx] < 0) !== in0) quad(V(i - 1, j, k - 1), V(i, j, k - 1), V(i, j, k), V(i - 1, j, k), in0);
    if (k < nz - 1 && i > 0 && i < nx - 1 && j > 0 && j < ny - 1 && (fld[o + nxy] < 0) !== in0) quad(V(i - 1, j - 1, k), V(i, j - 1, k), V(i, j, k), V(i - 1, j, k), !in0);
  }
  // 5) 保險:面的繞向和法線不一致就翻面
  for (let t = 0; t < ni; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    if (fx * (nor[a] + nor[b] + nor[c]) + fy * (nor[a + 1] + nor[b + 1] + nor[c + 1]) + fz * (nor[a + 2] + nor[b + 2] + nor[c + 2]) < 0) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  }
  return { position: pos.slice(0, nv * 3), normal: nor, index: idx.slice(0, ni), count: nv };
}
