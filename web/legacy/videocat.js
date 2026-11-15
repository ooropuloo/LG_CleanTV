// Legacy background host (old TVs without WebGL2, e.g. webOS 4.4 / Chrome 53): same interface as ../cat.js
// (CatHost + probeStyles) but each scene is a pre-rendered seamless loop video (cats/video/<scene>.mp4, fragmented MP4
// made by dev/record_loop.mjs, registered in cats/video/index.json) or a still JPEG. The bundler
// (dev/build_legacy.mjs) swaps ./cat.js for this file.
//   - one <video> at a time (old TVs have few hardware decoders); a scene switch fades the new scene's poster
//     (= exactly the first frame of its loop) in over the playing video, then replaces the video under it.
//   - endless loop via MediaSource (same fMP4 appended again with a growing timestampOffset): webOS 4.4 freezes
//     ~1.5 s at every native `loop` restart, MSE plays straight through. Native loop is the fallback.
//   - gaze / mood / poke are no-ops (baked into the video); canSwat is false.
// Query: ?bg=still (always still) | ?bg=video (forget the remembered "too slow" flag) | ?mse=0 (native loop).
const BASE = '../cats/video/';
const FADE_MS = 1400;
const qs = new URLSearchParams(location.search);
const V = (window.__video = { mode: null, scene: null, src: null, via: null, checks: [], fallback: null });

let manifest = null;
function loadManifest() {
  if (!manifest) {
    manifest = fetch(BASE + 'index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : { scenes: {} }))
      .catch(() => ({ scenes: {} }));
  }
  return manifest;
}
let cfgP = null;
const config = () => (cfgP = cfgP || fetch('api/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ scenes: [] })));

function findEntry(m, style, coat) {
  const sc = m.scenes || {};
  for (const id in sc) if (sc[id].style === style && (sc[id].coat || 'black') === coat) return Object.assign({ id }, sc[id]);
  return null;
}

const store = {
  get(k) { try { return localStorage.getItem('tvhome.' + k); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('tvhome.' + k); else localStorage.setItem('tvhome.' + k, v); } catch (e) { /* */ } },
};
if (qs.get('bg') === 'video') store.set('bgStill', null);
const stillOnly = () => qs.get('bg') === 'still' || store.get('bgStill') === '1';

/** Styles that can be shown: every style with a video or (v2 packs) a full still image. */
export async function probeStyles(list) {
  const m = await loadManifest(), c = await config();
  const out = [];
  for (const s of list) {
    const coats = [];
    for (const id in m.scenes || {}) if (m.scenes[id].style === s) coats.push(m.scenes[id].coat || 'black');
    for (const x of c.scenes || []) if (x.style === s && x.gen && coats.indexOf(x.coat) < 0) coats.push(x.coat); // generated v2 packs: still image.jpg
    if (coats.length) out.push({ id: s, name: s, coats });
  }
  return out;
}

function stillFor(style, coat, entry) {
  if (entry && entry.poster) return BASE + entry.poster;
  return `../cats/${style}/${coat}/assets/image.jpg`; // v2 pack (heroine / tabby-scenes / gen-live) without a video
}
function probeImage(url) {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(url); im.onerror = () => reject(new Error('no image ' + url)); im.src = url; });
}

export class CatHost {
  constructor(container, { quality }) {
    this.container = container; this.quality = 'video'; this.W = 1920; this.H = 1080; this.wanted = quality;
    this.style = null; this.coat = null; this.gen = 0; this.video = null; this.still = null; this.pending = {};
    this.watch = null; this.feedTimer = null; this.mseUrl = null;
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); else this.start(); });
  }

  get canSwat() { return false; }
  call(fn, a) { if (fn === 'setMood') this.pending.mood = a; } // video: nothing to steer
  resize() { /* CSS sizes the elements */ }

  async load(style, coat, fallbacks = [], opts = {}) {
    const gen = ++this.gen;
    const m = await loadManifest();
    const tries = [[style, coat]];
    if (coat !== 'black') tries.push([style, 'black']);
    fallbacks.filter((s) => s !== style && s !== '_example').forEach((s) => tries.push([s, coat]));
    let lastErr = null;
    for (const [s, c] of tries) {
      const e = findEntry(m, s, c);
      const still = stillFor(s, c, e);
      try {
        await probeImage(still);
        if (gen !== this.gen) return null;
        this._show(s, c, e && !stillOnly() ? e : null, still, !!opts.fade);
        return { style: s, coat: c };
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('no background');
  }

  _show(style, coat, entry, still, fade) {
    this.style = style; this.coat = coat;
    const mp4 = entry ? BASE + entry.mp4 : null;
    Object.assign(V, { scene: style + '/' + coat, src: mp4, mode: mp4 ? 'video' : 'still', fallback: null, checks: [], via: null });
    // the still of the new scene goes on top (fading in if something is already showing); it is exactly the first
    // frame of the loop, so hiding it once the video plays is invisible
    const img = document.createElement('img');
    img.className = 'bgstill'; img.alt = ''; img.src = still;
    const had = !!(this.video || this.still);
    if (fade && had) { img.style.opacity = '0'; img.style.transition = `opacity ${FADE_MS}ms ease-in-out`; }
    this.container.appendChild(img);
    const oldStill = this.still; this.still = img;
    const gen = this.gen;
    const swap = () => {
      if (gen !== this.gen) return;
      if (oldStill && oldStill.parentNode) oldStill.parentNode.removeChild(oldStill);
      this._dropVideo(); // one decoder at a time: the old video goes before the new one starts
      if (!mp4) return;
      const v = this._videoEl();
      const reveal = () => { if (gen === this.gen && this.still === img) { img.style.transition = ''; img.style.visibility = 'hidden'; } };
      v.addEventListener('playing', function once() { v.removeEventListener('playing', once); setTimeout(reveal, 150); });
      const codec = entry.codec || 'avc1.4d4028';
      const mse = qs.get('mse') !== '0' && window.MediaSource && MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`);
      if (mse) this._mse(v, mp4, codec, gen); else this._native(v, mp4);
      this._watch(v);
    };
    if (fade && had) {
      requestAnimationFrame(() => requestAnimationFrame(() => { img.style.opacity = '1'; }));
      setTimeout(swap, FADE_MS + 50);
    } else swap();
  }

  // plain <video loop>: works everywhere, but webOS 4.4 freezes ~1.5 s at every loop point (pipeline restart)
  _native(v, mp4) {
    V.via = 'loop';
    v.loop = true; v.src = mp4;
    const p = v.play(); if (p && p.catch) p.catch((e) => { V.playErr = String(e); });
  }

  // MediaSource: append the same fragmented MP4 again and again with a growing timestampOffset -> one endless
  // timeline, no seek / pipeline restart at the loop point. Data more than one loop behind is removed.
  _mse(v, mp4, codec, gen) {
    V.via = 'mse';
    const ms = new MediaSource();
    let sb = null, buf = null, n = 0, D = 0;
    const fail = (why) => {
      if (gen !== this.gen || v !== this.video) return;
      V.mseErr = why; this._dropVideo();
      const nv = this._videoEl(); this._native(nv, mp4); this._watch(nv);
    };
    const feed = () => {
      if (!sb || !buf || sb.updating || ms.readyState !== 'open') return;
      try {
        const b = v.buffered, end = b.length ? b.end(b.length - 1) : 0;
        if (D && b.length && b.start(0) < v.currentTime - D) { sb.remove(0, v.currentTime - D / 2); return; }
        if (!n || (D && end - v.currentTime < 12)) { sb.timestampOffset = n * D; sb.appendBuffer(buf); n++; V.appends = n; }
      } catch (e) { fail(String(e)); }
    };
    ms.addEventListener('sourceopen', () => {
      try { sb = ms.addSourceBuffer(`video/mp4; codecs="${codec}"`); } catch (e) { fail(String(e)); return; }
      sb.addEventListener('updateend', () => {
        if (!D && sb.buffered.length) { D = sb.buffered.end(0); V.loopS = Math.round(D * 100) / 100; } // exact loop length
        if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      });
      sb.addEventListener('error', () => fail('sourcebuffer error'));
      fetch(mp4).then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
        .then((ab) => { buf = new Uint8Array(ab); feed(); }) // Chrome 53: appendBuffer(ArrayBuffer from fetch) throws, a view works
        .catch((e) => fail(String(e)));
    });
    this.feedTimer = setInterval(feed, 1000);
    this.mseUrl = URL.createObjectURL(ms);
    v.src = this.mseUrl;
  }

  _videoEl() {
    if (this.video) return this.video;
    const v = document.createElement('video');
    v.className = 'bgvideo'; v.muted = true; v.autoplay = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.addEventListener('error', () => { if (v === this.video) { V.err = (v.error && v.error.code) || 'error'; this._fallback('error'); } });
    this.container.insertBefore(v, this.container.firstChild);
    this.video = v;
    return v;
  }

  _dropVideo() {
    clearInterval(this.watch); this.watch = null;
    clearInterval(this.feedTimer); this.feedTimer = null;
    const v = this.video; this.video = null;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* */ }
      if (v.parentNode) v.parentNode.removeChild(v);
    }
    if (this.mseUrl) { try { URL.revokeObjectURL(this.mseUrl); } catch (e) { /* */ } this.mseUrl = null; }
  }

  _fallback(why) {
    V.fallback = why; V.mode = 'still';
    if (this.still) { this.still.style.transition = ''; this.still.style.opacity = '1'; this.still.style.visibility = 'visible'; }
    this._dropVideo();
  }

  // Watchdog. The webOS hardware pipeline reports no decoded/dropped counts (webkitDecodedFrameCount stays 0, no
  // getVideoPlaybackQuality), so there it is judged from currentTime: frozen for 3 checks -> still image.
  // Where the counters exist (desktop) > 25 % dropped frames -> still image, remembered (localStorage bgStill).
  _watch(v) {
    clearInterval(this.watch);
    let base = null, stalls = 0, lastT = -1;
    const q = () => {
      if (v.getVideoPlaybackQuality) { const x = v.getVideoPlaybackQuality(); return { d: x.droppedVideoFrames, t: x.totalVideoFrames }; }
      return { d: v.webkitDroppedFrameCount || 0, t: v.webkitDecodedFrameCount || 0 };
    };
    this.watch = setInterval(() => {
      if (v !== this.video) { clearInterval(this.watch); return; }
      if (document.hidden || v.paused) return;
      const s = q();
      V.dropped = s.d; V.decoded = s.t; V.t = Math.round(v.currentTime * 10) / 10;
      if (v.currentTime === lastT) stalls++; else stalls = 0;
      lastT = v.currentTime;
      if (stalls >= 3) { this._fallback('stalled'); return; }
      if (!base) { base = s; return; }
      const dd = s.d - base.d, dt = s.t - base.t;
      V.checks.push({ at: V.t, dropped: dd, frames: dt });
      if (V.checks.length > 20) V.checks.shift();
      if (dt >= 150 && dd / (dt + dd) > 0.25) { store.set('bgStill', '1'); this._fallback('dropped ' + dd + '/' + dt); return; }
      base = s;
    }, 10000);
  }

  stop() { if (this.video) this.video.pause(); }
  start() { if (this.video) { const p = this.video.play(); if (p && p.catch) p.catch(() => {}); } }
}
