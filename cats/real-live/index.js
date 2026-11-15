// 擬真風(活圖):生成的寫實照片本身就是畫面,用 2 個 draw call 讓牠活起來。引擎在 ../live/engine.js,說明在 ../live/NOTES.md。
import { createLiveScene } from '../live/engine.js';

export const meta = {
  id: 'real-live', name: '擬真風(活圖)', coats: ['black', 'tabby'],
  renderer: { antialias: false, toneMapping: 'None', exposure: 1, shadows: false },
};

// Realistic style: slow, small, damped motion (no overshoot).
const MOTION = {
  eyeShift: [0.2, 0.14], eyeTau: 0.03, headHz: 0.7, headZeta: 1.0,
  yawPx: 0, pitchPx: 0, yawShift: 2, roll: 0.004, rollGaze: 0.002, tilt: 0.012, antic: 0, bob: 0.9,
  blink: [0.08, 0.05, 0.16], lash: 0.5, pupilAniso: [1, 0.35],
  breath: 0.004, breathHz: 0.45, whisk: 0.012,
  earTwitch: 0.22, earGaze: 0.035, pawPx: 3, swatReach: 18,
  tailAmp: 0.035, tailHz: 0.22, tailLag: 2.0, tailDrift: 0.02, flick: 0.16,
};

export async function createCatScene({ renderer, quality, aspect, seed, coat }) {
  const c = meta.coats.indexOf(coat) >= 0 ? coat : 'black';
  return createLiveScene({ renderer, quality, aspect, seed, base: new URL(`./${c}/assets/`, import.meta.url), motion: MOTION });
}
