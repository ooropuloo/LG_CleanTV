// 皮克斯風(活圖):生成的靜態圖本身就是畫面,用 2 個 draw call 讓牠活起來。引擎在 ../live/engine.js,說明在 ../live/NOTES.md。
import { createLiveScene } from '../live/engine.js';

export const meta = {
  id: 'pixar-live', name: '皮克斯風(活圖)', coats: ['black', 'tabby'],
  renderer: { antialias: false, toneMapping: 'None', exposure: 1, shadows: false },
};

// Pixar style: bigger, springier motion (anticipation + overshoot).
const MOTION = {
  eyeShift: [0.2, 0.15], eyeTau: 0.035, headHz: 1.1, headZeta: 0.55,
  yawPx: 0, pitchPx: 0, yawShift: 3, roll: 0.008, rollGaze: 0.003, tilt: 0.02, antic: 0.25, bob: 1.6,
  blink: [0.07, 0.04, 0.13], lash: 0.55, pupilAniso: [1, 1],
  breath: 0.006, breathHz: 0.5, whisk: 0.025,
  earTwitch: 0.3, earGaze: 0.05, pawPx: 5, swatReach: 26,
  tailAmp: 0.05, tailHz: 0.33, tailLag: 2.4, tailDrift: 0.025, flick: 0.22,
};

export async function createCatScene({ renderer, quality, aspect, seed, coat }) {
  const c = meta.coats.indexOf(coat) >= 0 ? coat : 'black';
  return createLiveScene({ renderer, quality, aspect, seed, base: new URL(`./${c}/assets/`, import.meta.url), motion: MOTION });
}
