// 小工具:亂數、雜訊、彈簧。全部不配置物件,可在 update() 裡安心呼叫。

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const DEG = Math.PI / 180;

// 可重現的亂數(mulberry32)
export function makeRng(seed) {
  let a = (seed | 0) ^ 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.sign = () => (next() < 0.5 ? -1 : 1);
  return next;
}

// 整數雜湊 → 0..1
export function ihash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
export function hash3(x, y, z) {
  return ihash((Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) | 0);
}

// 平滑的一維 value noise,回傳 -1..1。ch 是通道(不同通道互不相關)。
export function vnoise(t, ch) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  const k = Math.imul(ch | 0, 668265263);
  const a = ihash((Math.imul(i, 374761393) + k) | 0), b = ihash((Math.imul(i + 1, 374761393) + k) | 0);
  return (a + (b - a) * u) * 2 - 1;
}
// 兩個八度,比較有機
export function fnoise(t, ch) { return vnoise(t, ch) * 0.68 + vnoise(t * 2.17 + 13.7, ch + 17) * 0.32; }

// 三維 value noise(建模用,不在 update 裡用),回傳 0..1
export function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = hash3(xi, yi, zi), b = hash3(xi + 1, yi, zi), c = hash3(xi, yi + 1, zi), d = hash3(xi + 1, yi + 1, zi);
  const e = hash3(xi, yi, zi + 1), f = hash3(xi + 1, yi, zi + 1), g = hash3(xi, yi + 1, zi + 1), h = hash3(xi + 1, yi + 1, zi + 1);
  const l0 = a + (b - a) * fx, l1 = c + (d - c) * fx, l2 = e + (f - e) * fx, l3 = g + (h - g) * fx;
  const m0 = l0 + (l1 - l0) * fy, m1 = l2 + (l3 - l2) * fy;
  return m0 + (m1 - m0) * fz;
}

// 二階彈簧(半隱式),x 追 target。omega = 自然頻率(rad/s),zeta = 阻尼比(<1 會過衝)
export class Spring {
  constructor(x = 0) { this.x = x; this.v = 0; }
  step(target, omega, zeta, dt) {
    // 分小步積分,ω·dt 大時也穩定
    const n = Math.min(16, Math.max(1, Math.ceil(omega * dt / 0.15))), h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = omega * omega * (target - this.x) - 2 * zeta * omega * this.v;
      this.v += a * h; this.x += this.v * h;
    }
    return this.x;
  }
  set(x) { this.x = x; this.v = 0; }
}

// 一階低通
export const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
