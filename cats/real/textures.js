// Procedural textures: out-of-focus living-room backdrop (two layers: room + lamp light) and a chunky-knit tile.
import * as THREE from 'three';
import { rng } from './sdf.js';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function grain(ctx, w, h, r, amt) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const g = (r() - 0.5) * amt; d[i] += g; d[i + 1] += g; d[i + 2] += g; }
  ctx.putImageData(im, 0, 0);
}
function blob(ctx, x, y, rx, ry, col, a = 1) {
  ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
function rrect(ctx, x, y, w, h, r, col, a = 1) {
  ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.fill(); ctx.restore();
}

// Room layer: a dim warm-grey living room, very defocused. Coordinates are fractions of the frame (the backdrop
// plane is sized to the camera frustum so u,v ~ screen x,y).
export function makeBackdrop(seed, tex = 1024) {
  const W = tex, H = Math.round(tex * 9 / 16), r = rng(seed * 7 + 3);
  const src = canvas(W, H), c = src.getContext('2d');
  // wall: darker at the top-left (clock zone), slightly lifted around the middle/right
  let g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#141210'); g.addColorStop(0.55, '#24201d'); g.addColorStop(1, '#2a2522');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.62, H * 0.55, 10, W * 0.62, H * 0.55, W * 0.55); g.addColorStop(0, 'rgba(70,62,56,0.55)'); g.addColorStop(1, 'rgba(70,62,56,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // window light falling on the left wall (very soft, kept below the clock zone)
  g = c.createRadialGradient(W * 0.05, H * 0.72, 10, W * 0.05, H * 0.72, W * 0.32); g.addColorStop(0, 'rgba(90,100,112,0.35)'); g.addColorStop(1, 'rgba(90,100,112,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // a door/frame edge and a shelf shadow, barely there
  rrect(c, W * 0.30, H * 0.05, W * 0.012, H * 0.8, 4, '#0e0d0c', 0.35);
  // sofa back + cushions to the right of the cat
  rrect(c, W * 0.55, H * 0.55, W * 0.50, H * 0.40, 60, '#2f2b28', 0.9);
  rrect(c, W * 0.64, H * 0.43, W * 0.17, H * 0.30, 50, '#4a4541', 0.95);
  rrect(c, W * 0.66, H * 0.45, W * 0.12, H * 0.10, 40, '#57514c', 0.45);
  rrect(c, W * 0.78, H * 0.47, W * 0.12, H * 0.26, 40, '#3c3733', 0.9);
  // side table under the lamp, far right
  rrect(c, W * 0.88, H * 0.66, W * 0.14, H * 0.30, 10, '#1a1614', 0.9);
  // left: armchair silhouette, dark
  rrect(c, -W * 0.05, H * 0.62, W * 0.22, H * 0.40, 50, '#1b1917', 0.9);
  const out = canvas(W, H), o = out.getContext('2d');
  o.filter = `blur(${Math.round(W * 0.018)}px)`; o.drawImage(src, 0, 0); o.filter = 'none';
  grain(o, W, H, r, 3);
  const room = new THREE.CanvasTexture(out); room.colorSpace = THREE.SRGBColorSpace; room.minFilter = THREE.LinearFilter; room.generateMipmaps = false;

  // lamp layer: warm shade glow + bokeh discs + light pool on the wall (added with a variable gain)
  const ls = canvas(W, H), l = ls.getContext('2d'); l.fillStyle = '#000'; l.fillRect(0, 0, W, H);
  const lx = W * 0.935, ly = H * 0.60;
  g = l.createRadialGradient(lx, ly, 2, lx, ly, W * 0.30); g.addColorStop(0, 'rgba(255,170,90,0.55)'); g.addColorStop(0.35, 'rgba(200,120,60,0.18)'); g.addColorStop(1, 'rgba(120,70,40,0)');
  l.fillStyle = g; l.fillRect(0, 0, W, H);
  blob(l, lx, ly, W * 0.035, W * 0.033, '#ffc27a', 1);       // the lamp shade itself, out of focus
  blob(l, lx, ly - W * 0.004, W * 0.026, W * 0.024, '#ffe2b0', 0.8);
  for (let i = 0; i < 7; i++) blob(l, lx - W * (0.06 + r() * 0.12), ly + H * (r() * 0.2 - 0.05), W * (0.008 + r() * 0.01), W * (0.008 + r() * 0.01), '#ff9b50', 0.15 + r() * 0.2);
  const lo = canvas(W, H), lc = lo.getContext('2d'); lc.filter = `blur(${Math.round(W * 0.006)}px)`; lc.drawImage(ls, 0, 0); lc.filter = 'none';
  const lamp = new THREE.CanvasTexture(lo); lamp.colorSpace = THREE.SRGBColorSpace; lamp.minFilter = THREE.LinearFilter; lamp.generateMipmaps = false;
  return { room, lamp };
}

// Chunky hand-knit tile (stockinette "V" columns). Returns normal+height (RGBA) and albedo (RGB) DataTextures.
// The tile spans `cols` stitch columns and `rows` rows.
export function makeKnit(seed, S = 256, cols = 4, rows = 5) {
  const r = rng(seed * 13 + 5), hgt = new Float32Array(S * S), alb = new Float32Array(S * S), cw = S / cols, rh = S / rows;
  const tone = []; for (let i = 0; i < cols * rows * 2; i++) tone.push(0.88 + r() * 0.24);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let best = 0, bt = 1, bu = 0;
    for (let ry = -1; ry <= rows; ry++) for (let cx = -1; cx <= cols; cx++) {
      const sx = (cx + 0.5) * cw, sy = (ry + 0.5) * rh + ((cx & 1) ? 0 : 0);
      for (let leg = 0; leg < 2; leg++) {
        const sgn = leg ? 1 : -1, lx = sx + sgn * cw * 0.23, ly = sy;
        // axis leans so the pair forms a V (top outward)
        const ang = sgn * 0.52, ca = Math.cos(ang), sa = Math.sin(ang);
        let dx = x - lx, dy = y - ly; // wrap for tiling
        if (dx > S / 2) dx -= S; if (dx < -S / 2) dx += S; if (dy > S / 2) dy -= S; if (dy < -S / 2) dy += S;
        const u = dx * sa + dy * ca, v = dx * ca - dy * sa; // u along leg (vertical-ish), v across
        const a = rh * 0.72, b = cw * 0.25, q = 1 - (v * v) / (b * b);
        if (q <= 0) continue;
        const end = 1 - Math.pow(Math.abs(u) / a, 3); if (end <= 0) continue;
        // yarn plies: twisted stripes across the strand
        const ply = 0.86 + 0.14 * Math.sin((u * 0.9 + v * 1.4) * (6.2832 / (b * 0.9)));
        const h = Math.sqrt(q) * Math.sqrt(end) * ply * (0.9 + 0.1 * ((ry + 9) % 2));
        if (h > best) { best = h; bt = tone[((ry + rows) % rows) * cols * 2 + ((cx + cols) % cols) * 2 + leg] || 1; bu = u / a; }
      }
    }
    // fibre fuzz
    const fz = (r() - 0.5) * 0.06;
    hgt[y * S + x] = Math.max(0, best + fz * best);
    alb[y * S + x] = bt * (0.92 + (r() - 0.5) * 0.16) * (0.97 + 0.03 * bu);
  }
  const nh = new Uint8Array(S * S * 4), al = new Uint8Array(S * S * 4), str = 2.4;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const H = (xx, yy) => hgt[((yy + S) % S) * S + ((xx + S) % S)];
    const dx = (H(x + 1, y) - H(x - 1, y)) * str, dy = (H(x, y + 1) - H(x, y - 1)) * str;
    const l = Math.hypot(dx, dy, 1), i = (y * S + x) * 4;
    nh[i] = (-dx / l * 0.5 + 0.5) * 255; nh[i + 1] = (dy / l * 0.5 + 0.5) * 255; nh[i + 2] = (1 / l * 0.5 + 0.5) * 255; nh[i + 3] = Math.min(1, hgt[y * S + x]) * 255;
    const h = hgt[y * S + x], ao = 0.25 + 0.75 * Math.min(1, Math.pow(h / 0.75, 0.8)), a = alb[y * S + x] * ao;
    al[i] = Math.min(255, a * 200); al[i + 1] = Math.min(255, a * 200); al[i + 2] = Math.min(255, a * 200); al[i + 3] = 255;
  }
  const mk = (data, cs) => { const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.colorSpace = cs; t.needsUpdate = true; return t; };
  return { normal: mk(nh, THREE.NoColorSpace), albedo: mk(al, THREE.NoColorSpace) };
}
