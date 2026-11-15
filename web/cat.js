// Animated cat background host (contract: ../cats/README.md).
import * as THREE from 'three';

const TM = { None: THREE.NoToneMapping, Linear: THREE.LinearToneMapping, Reinhard: THREE.ReinhardToneMapping, Cineon: THREE.CineonToneMapping,
  ACESFilmic: THREE.ACESFilmicToneMapping, AgX: THREE.AgXToneMapping, Neutral: THREE.NeutralToneMapping };
const SH = { Basic: THREE.BasicShadowMap, PCF: THREE.PCFShadowMap, PCFSoft: THREE.PCFSoftShadowMap, VSM: THREE.VSMShadowMap };

const modCache = {};
const FADE_MS = 1400;
export function loadStyle(style) {
  if (!/^[\w-]+$/.test(style)) return Promise.reject(new Error('bad style'));
  if (!modCache[style]) modCache[style] = import(`../cats/${style}/index.js`).catch((e) => { delete modCache[style]; throw e; });
  return modCache[style];
}

/** Probe which styles import fine: resolves [{id, name, coats}] in the given order. */
export async function probeStyles(list) {
  const out = await Promise.all(list.map((s) => loadStyle(s).then((m) => ({
    id: s, name: (m.meta && m.meta.name) || s, coats: (m.meta && m.meta.coats) || ['black'],
  })).catch(() => null)));
  return out.filter(Boolean);
}

export class CatHost {
  constructor(container, { quality, fps }) {
    this.container = container; this.quality = quality; this.fpsCap = fps;
    this.W = quality === 'tv' ? 1280 : 1920; this.H = quality === 'tv' ? 720 : 1080;
    this.h = null; this.renderer = null; this.simT = 0; this.running = false; this.pending = {};
    this.seed = 1; this.style = null; this.coat = null; this.gen = 0;
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); else this.start(); });
  }

  /** Load `style` with `coat`; on failure try the same style in black, then each of `fallbacks`.
   *  opts.fade: crossfade from the current scene (old canvas frozen underneath, disposed after the fade).
   *  opts.params: scene params passed to createCatScene (packs may ignore them).
   *  Resolves {style, coat} actually used. */
  async load(style, coat, fallbacks = ['_example'], opts = {}) {
    const gen = ++this.gen;
    const tries = [[style, coat]];
    if (coat !== 'black') tries.push([style, 'black']);
    fallbacks.filter((s) => s !== style).forEach((s) => tries.push([s, coat]));
    let lastErr;
    for (const [s, c] of tries) {
      try {
        const mod = await loadStyle(s);
        if (gen !== this.gen) return null;
        await this._mount(mod, s, c, gen, opts);
        return { style: s, coat: c };
      } catch (e) { lastErr = e; console.warn('[cat] style failed', s, c, String(e)); }
    }
    throw lastErr || new Error('no cat style');
  }

  async _mount(mod, style, coat, gen, opts = {}) {
    const rh = typeof (mod.meta && mod.meta.renderer) === 'function' ? mod.meta.renderer(this.quality) : ((mod.meta && mod.meta.renderer) || {});
    const fade = !!(opts.fade && this.renderer && this.h);
    if (fade) this.stop(); else this._unmount(); // fade: keep the old canvas (frozen last frame) until the new one is in
    const renderer = new THREE.WebGLRenderer({ antialias: rh.antialias != null ? rh.antialias : this.quality !== 'tv', powerPreference: 'high-performance', alpha: false });
    renderer.setPixelRatio(1);
    const aspect = 16 / 9; // 舞台固定 16:9(見 app.js scale)
    renderer.setSize(Math.round(this.H * aspect), this.H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = TM[rh.toneMapping] != null ? TM[rh.toneMapping] : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = rh.exposure != null ? rh.exposure : 1;
    renderer.shadowMap.enabled = !!rh.shadows; renderer.shadowMap.type = SH[rh.shadowType] != null ? SH[rh.shadowType] : THREE.PCFSoftShadowMap;
    let h;
    try {
      h = await mod.createCatScene({ renderer, quality: this.quality, aspect, seed: this.seed, coat, params: opts.params || {} });
    } catch (e) { renderer.dispose(); renderer.forceContextLoss(); if (fade) this.start(); throw e; }
    if (gen !== this.gen) { try { h.dispose && h.dispose(); } catch (e) { /* */ } renderer.dispose(); renderer.forceContextLoss(); if (fade) this.start(); return; }
    const old = fade ? { renderer: this.renderer, h: this.h } : null;
    this.renderer = renderer; this.h = h; this.style = style; this.coat = coat; this.simT = 0;
    const cv = renderer.domElement;
    if (old) { cv.style.opacity = '0'; cv.style.transition = `opacity ${FADE_MS}ms ease-in-out`; }
    this.container.appendChild(cv);
    const p = this.pending;
    if (p.hour != null) this.call('setHour', p.hour);
    if (p.mood) this.call('setMood', p.mood);
    if (p.gaze) this.call('setGaze', p.gaze[0], p.gaze[1]);
    renderer.render(h.scene, h.camera);
    this.start();
    if (old) {
      requestAnimationFrame(() => requestAnimationFrame(() => { cv.style.opacity = '1'; }));
      setTimeout(() => { // only one WebGL scene stays alive after the fade
        try { old.h.dispose && old.h.dispose(); } catch (e) { /* */ }
        old.renderer.domElement.remove(); old.renderer.dispose(); old.renderer.forceContextLoss();
        cv.style.transition = '';
      }, FADE_MS + 150);
    }
  }

  _unmount() {
    this.stop();
    if (this.h) { try { this.h.dispose && this.h.dispose(); } catch (e) { /* */ } this.h = null; }
    if (this.renderer) { this.renderer.domElement.remove(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer = null; }
  }

  call(fn, ...args) {
    if (fn === 'setHour') this.pending.hour = args[0];
    if (fn === 'setMood') this.pending.mood = args[0];
    if (fn === 'setGaze') this.pending.gaze = args[0] == null ? null : args;
    if (this.h && typeof this.h[fn] === 'function') { try { this.h[fn](...args); } catch (e) { console.warn('[cat]', fn, e); } }
  }

  resize() {
    if (!this.renderer) return;
    const aspect = 16 / 9; // 舞台固定 16:9(見 app.js scale)
    this.renderer.setSize(Math.round(this.H * aspect), this.H, false);
    this.call('resize', aspect);
  }

  start() {
    if (this.running || !this.h || document.hidden) return;
    this.running = true;
    let last = performance.now(), acc = 0;
    const minDt = 1 / this.fpsCap - 0.002;
    const loop = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      acc += (now - last) / 1000; last = now;
      if (acc < minDt) return;
      const dt = Math.min(0.1, acc); acc = 0;
      this.simT += dt;
      try { this.h.update(dt, this.simT); this.renderer.render(this.h.scene, this.h.camera); } catch (e) { console.error('[cat] frame', e); this.stop(); }
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** true when the current scene can swipe a paw at a tile (poke('swat', x, y)); heroine/sleep scenes cannot. */
  get canSwat() { return !!(this.h && this.h.canSwat); }

  stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); }
}
