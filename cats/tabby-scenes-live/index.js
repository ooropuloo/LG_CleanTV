// 虎斑貓場景(活圖,v2):play = 早上玩毛線球(皮克斯風)、sleep = 深夜捲著睡。一張圖 1 個 draw call。
// 引擎 ../live/engine2.js,prep ../live/tools/prep_scene.py,說明 ../live/NOTES.md「v2 scenes」。
// 屋主規則:不眨眼;臉整塊剛性移動(張開的嘴也不變形);看東西靠眼珠和耳朵;睡覺的貓沒有視線(setGaze 無作用)。
import { createRigScene } from '../live/engine2.js';

export const meta = {
  id: 'tabby-scenes-live', name: '虎斑貓場景(活圖)', coats: ['play', 'sleep'],
  renderer: { antialias: false, toneMapping: 'None', exposure: 1, shadows: false },
};

const MOTION = {
  play: { cat: {
    eyeShift: [0.12, 0.1], eyeTau: 0.035, headHz: 1.0, headZeta: 0.6, roll: 0.006, tilt: 0.014, bob: 1.2, yawShift: 2,
    breath: 0.006, breathHz: 0.5, earTwitch: 0.16, earGaze: 0.04,
    tailAmp: 0.03, tailHz: 0.3, tailLag: 2.2, tailDrift: 0.015, flick: 0.1,
    paw: 0.07, pawEvery: [2.2, 5.5], yarn: 0.05, swatReach: 34,
  } },
  sleep: { cat: {
    eyeShift: [0, 0], headHz: 0.4, roll: 0.0015, tilt: 0, bob: 0.25, yawShift: 0,
    breath: 0.011, breathHz: 0.22, breathY: 1.0, headRide: 0.35,
    earTwitch: 0.09, earGaze: 0, earEvery: [7, 18],
    tailAmp: 0.008, tailHz: 0.08, tailLag: 1.6, tailDrift: 0.012, flick: 0.07, flickEvery: [9, 20],
  } },
};

export async function createCatScene({ renderer, quality, aspect, seed, coat }) {
  const c = meta.coats.indexOf(coat) >= 0 ? coat : 'play';
  return createRigScene({ renderer, quality, aspect, seed, base: new URL(`./${c}/assets/`, import.meta.url), motion: MOTION[c] });
}
