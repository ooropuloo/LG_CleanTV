// 耳機女孩(活圖,v2 場景):寫實照片裡的女孩+旁邊的虎斑貓,一張圖 1 個 draw call。
// 引擎 ../live/engine2.js,prep ../live/tools/prep_scene.py,說明 ../live/NOTES.md「v2 scenes」。
// 屋主規則:不眨眼;臉只做整塊小平移/小傾斜;看東西靠眼珠(和貓耳)。
import { createRigScene } from '../live/engine2.js';

export const meta = {
  id: 'heroine-live', name: '耳機女孩(活圖)', coats: ['morning', 'evening'],
  renderer: { antialias: false, toneMapping: 'None', exposure: 1, shadows: false },
};

const MOTION = {
  person: { eyeShift: [0.15, 0.0], breath: 1.5, breathHz: 0.23, hair: 2.0, hairY: 0.5, hairHz: 0.15, roll: 0.003, bob: 0.45, yawShift: 0.8, tilt: 0.005 },
  cat: { eyeShift: [0.2, 0.1], earTwitch: 0.12, earGaze: 0.025, breath: 0.006, breathHz: 0.42, yawShift: 1.2, bob: 0.6, roll: 0.004, tilt: 0.008,
    tailAmp: 0.012, tailHz: 0.18, tailDrift: 0.008, flick: 0.06, flickEvery: [7, 16] },
  fx: { rain: 1, bokeh: 0.16, lamp: 0.03 },
};

export async function createCatScene({ renderer, quality, aspect, seed, coat }) {
  const c = meta.coats.indexOf(coat) >= 0 ? coat : 'morning';
  return createRigScene({ renderer, quality, aspect, seed, base: new URL(`./${c}/assets/`, import.meta.url), motion: MOTION });
}
