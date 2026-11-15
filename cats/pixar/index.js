// 皮克斯風黑貓(cats/pixar)。介面見 ../README.md。
// 結構:catRoot ─ headPivot(脖子支點)─ headOff ─ 頭(含耳朵)、眼睛、眼皮、鼻子、嘴、鬍鬚
//                ─ body(肩膀)─ pawPivot ─ 前掌
//        tail(世界座標,骨架點在 update 裡算,shader 沿曲線彎)、blanket、背景
import * as THREE from 'three';
import { makeRng, fnoise, clamp, lerp, smoothstep, saturate, Spring, damp } from './util.js';
import { furVS, furFS, solidVS, solidFS, eyeVS, eyeFS, whiskerVS, whiskerFS, bgVS, bgFS } from './shaders.js';
import { HEAD, NECK, EYE, EAR, EAR_PIVOT, PAW, TAIL_N, coatPalette, buildHead, buildBody, buildPaw, buildTail, buildBlanket, buildNose, buildMouth, buildWhiskers, makeNoise3D, onHead, blanketTopY } from './build.js';

export const meta = {
  id: 'pixar', name: '皮克斯風',
  coats: ['black', 'tabby'],
  renderer: (quality) => ({ antialias: true, toneMapping: 'ACESFilmic', exposure: 1.0, shadows: false }),
};

const Q = {
  desktop: { shells: { head: 26, body: 10, paw: 18, tail: 20, blanket: 10 }, furScale: 1.0, density: 3.0, eyeSeg: [64, 48], shellAlpha: 0.8 },
  tv: { shells: { head: 10, body: 4, paw: 7, tail: 8, blanket: 5 }, furScale: 0.92, density: 1.7, eyeSeg: [40, 30], shellAlpha: 1.0 },
};

const CAT_X = 0.11;   // 貓在世界中的 x(頭中心約在螢幕 x 0.52)

// ---------------- 時段光線 ----------------
const V3 = (r, g, b) => new THREE.Vector3(r, g, b);
const LOOKS = {
  day: {
    key: V3(1.0, 0.9, 0.8).multiplyScalar(2.1), fill: V3(0.32, 0.46, 0.95).multiplyScalar(0.55), rim: V3(0.3, 0.55, 1.35).multiplyScalar(2.6),
    sky: V3(0.07, 0.12, 0.28), gnd: V3(0.05, 0.09, 0.2),
    bgDark: V3(0.003, 0.01, 0.04), bgMid: V3(0.016, 0.055, 0.19), bgGlow: V3(0.04, 0.14, 0.42), bgLow: V3(0.02, 0.06, 0.18),
    whisk: V3(0.75, 0.78, 0.86), eyeLight: 1.0, catch: 1.0, envTop: V3(0.18, 0.3, 0.6), envBot: V3(0.02, 0.03, 0.06), blanket: 1.0, pupil: 0,
  },
  dusk: {
    key: V3(1.0, 0.6, 0.36).multiplyScalar(1.8), fill: V3(0.42, 0.32, 0.85).multiplyScalar(0.45), rim: V3(0.62, 0.45, 1.15).multiplyScalar(1.45),
    sky: V3(0.08, 0.07, 0.2), gnd: V3(0.05, 0.05, 0.14),
    bgDark: V3(0.006, 0.006, 0.03), bgMid: V3(0.035, 0.03, 0.14), bgGlow: V3(0.13, 0.07, 0.26), bgLow: V3(0.03, 0.03, 0.12),
    whisk: V3(0.8, 0.7, 0.72), eyeLight: 0.9, catch: 1.0, envTop: V3(0.35, 0.25, 0.5), envBot: V3(0.03, 0.02, 0.04), blanket: 0.85, pupil: 0.06,
  },
  night: {
    key: V3(0.42, 0.55, 0.95).multiplyScalar(0.75), fill: V3(0.1, 0.14, 0.35).multiplyScalar(0.35), rim: V3(0.5, 0.72, 1.3).multiplyScalar(1.25),
    sky: V3(0.015, 0.025, 0.07), gnd: V3(0.01, 0.015, 0.04),
    bgDark: V3(0.001, 0.002, 0.008), bgMid: V3(0.004, 0.01, 0.04), bgGlow: V3(0.012, 0.03, 0.1), bgLow: V3(0.004, 0.01, 0.035),
    whisk: V3(0.38, 0.45, 0.6), eyeLight: 0.55, catch: 1.3, envTop: V3(0.1, 0.16, 0.35), envBot: V3(0.005, 0.008, 0.02), blanket: 0.55, pupil: 0.16,
  },
};
function hourWeights(h) {
  h = ((h % 24) + 24) % 24;
  // 白天 8–16,傍晚 17–19 前後,夜裡 21–5;中間平滑過渡
  const day = smoothstep(5.5, 8, h) * (1 - smoothstep(16, 18, h));
  const night = 1 - smoothstep(4.5, 6.5, h) + smoothstep(19, 21, h);
  const n = clamp(night, 0, 1), d = clamp(day, 0, 1) * (1 - n);
  return [d, Math.max(0, 1 - d - n), n];
}

export function createCatScene({ renderer, quality, aspect, seed = 1, coat }) {
  const qs = Q[quality === 'tv' ? 'tv' : 'desktop'];
  const tv = quality === 'tv';
  const pal = coatPalette(coat === 'tabby' ? 'tabby' : 'black');
  const rng = makeRng(seed * 7919 + 13);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, aspect, 0.1, 40);
  camera.position.set(0, 0, 6); camera.lookAt(0, 0, 0);

  // ---------- 共用 uniform ----------
  const S = {
    uKeyDir: { value: new THREE.Vector3(-0.55, 0.75, 0.62).normalize() }, uKeyCol: { value: new THREE.Vector3() },
    uFillDir: { value: new THREE.Vector3(0.85, 0.05, 0.55).normalize() }, uFillCol: { value: new THREE.Vector3() },
    uRimDir: { value: new THREE.Vector3(0.35, 0.55, -0.75).normalize() }, uRimCol: { value: new THREE.Vector3() },
    uSkyCol: { value: new THREE.Vector3() }, uGndCol: { value: new THREE.Vector3() },
  };
  const noise = makeNoise3D(64, seed);
  const disposables = [noise];

  const furMat = ({ shells = 0, defines = {}, extra = {}, sheen = 0.22, rim = 1, sheenCol = pal.sheenCol, glow = [0, 0, 0], ao = 0.4, alpha = qs.shellAlpha }) => {
    const d = Object.assign({}, defines); if (shells) d.SHELL = 1;
    const m = new THREE.ShaderMaterial({
      vertexShader: furVS, fragmentShader: furFS, defines: d,
      uniforms: Object.assign({}, S, {
        uNoise: { value: noise }, uDensity: { value: qs.density }, uShells: { value: shells || 1 }, uFurScale: { value: qs.furScale },
        uGrav: { value: new THREE.Vector3(0, -0.3, -0.25) }, uLag: { value: new THREE.Vector3() },
        uSheenCol: { value: new THREE.Vector3(...sheenCol) }, uSheen: { value: sheen * (defines.BLANKET ? 1 : pal.sheenMul) }, uRim: { value: rim * (defines.BLANKET ? 1 : pal.rimMul) }, uShellAlpha: { value: alpha },
        uGlow: { value: new THREE.Vector3(...glow) }, uAO: { value: ao }, uTick: { value: pal.tick },
      }, extra),
      transparent: !!shells, depthWrite: !shells,
    });
    disposables.push(m);
    return m;
  };
  const shellsOf = (geo, mat, n, order) => {
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = geo.index; for (const k in geo.attributes) ig.setAttribute(k, geo.attributes[k]);
    ig.instanceCount = n; ig.boundingSphere = geo.boundingSphere || (geo.computeBoundingSphere(), geo.boundingSphere);
    const m = new THREE.Mesh(ig, mat); m.renderOrder = order; m.frustumCulled = false;
    disposables.push(ig);
    return m;
  };

  // ---------- 背景 ----------
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: bgVS, fragmentShader: bgFS, depthWrite: false,
    uniforms: { uBgDark: { value: new THREE.Vector3() }, uBgMid: { value: new THREE.Vector3() }, uBgGlow: { value: new THREE.Vector3() }, uBgLow: { value: new THREE.Vector3() }, uGlowAt: { value: new THREE.Vector2(0.6, 0.55) } },
  });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), bgMat);
  bg.position.set(0, 0, -6); bg.renderOrder = -100; scene.add(bg);
  disposables.push(bgMat, bg.geometry);

  // ---------- 貓 ----------
  const catRoot = new THREE.Group(); catRoot.position.set(CAT_X, 0, 0); scene.add(catRoot);
  const headPivot = new THREE.Group(); headPivot.position.set(NECK.x, NECK.y, NECK.z); catRoot.add(headPivot);
  const headOff = new THREE.Group(); headOff.position.set(HEAD.cx - NECK.x, HEAD.cy - NECK.y, HEAD.cz - NECK.z); headPivot.add(headOff);

  // 頭(含耳朵)
  const headGeo = buildHead(quality, pal); disposables.push(headGeo);
  const earL = new THREE.Matrix4(), earR = new THREE.Matrix4();
  const headBaseMat = furMat({ defines: { EARS: 1 }, extra: { uEarL: { value: earL }, uEarR: { value: earR } }, glow: pal.earGlow });
  const headShellMat = furMat({ shells: qs.shells.head, defines: { EARS: 1 }, extra: { uEarL: { value: earL }, uEarR: { value: earR } }, glow: pal.earGlow });
  const headMesh = new THREE.Mesh(headGeo, headBaseMat); headMesh.frustumCulled = false; headOff.add(headMesh);
  headOff.add(shellsOf(headGeo, headShellMat, qs.shells.head, 3));

  // 眼睛
  const eyes = [];
  const eyeGeo = new THREE.SphereGeometry(EYE.r, qs.eyeSeg[0], qs.eyeSeg[1]); eyeGeo.rotateX(Math.PI / 2); disposables.push(eyeGeo);
  const lidUGeo = new THREE.SphereGeometry(EYE.r * 1.045, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  const lidLGeo = new THREE.SphereGeometry(EYE.r * 1.035, 40, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  disposables.push(lidUGeo, lidLGeo);
  const lidMat = new THREE.ShaderMaterial({ vertexShader: solidVS, fragmentShader: solidFS, defines: { LID: 1 }, uniforms: Object.assign({}, S, { uAlb: { value: new THREE.Vector3(...pal.lid) }, uGloss: { value: 0.0 }, uRim: { value: 0.06 }, uSheenCol: { value: new THREE.Vector3(0.08, 0.1, 0.18) }, uLidEdge: { value: 0 }, uEdge: { value: 0 }, uR: { value: EYE.r * 1.04 }, uNoise: { value: noise } }) });
  disposables.push(lidMat);
  for (const side of [-1, 1]) {
    const socket = new THREE.Group(); socket.position.set(EYE.x * side, EYE.y, EYE.z); socket.rotation.y = EYE.yaw * side; headOff.add(socket);
    const mat = new THREE.ShaderMaterial({
      vertexShader: eyeVS, fragmentShader: eyeFS,
      uniforms: {
        uR: { value: EYE.r }, uEyeRot: { value: new THREE.Matrix3() }, uPupil: { value: 0.5 },
        uLidNU: { value: new THREE.Vector3(0, 1, 0) }, uLidNL: { value: new THREE.Vector3(0, -1, 0) },
        uIrisIn: { value: V3(...pal.eye.irisIn) }, uIrisMid: { value: V3(...pal.eye.irisMid) }, uIrisOut: { value: V3(...pal.eye.irisOut) },
        uLimbal: { value: V3(...pal.eye.limbal) }, uGlowC: { value: V3(...pal.eye.glow) }, uSclera: { value: V3(0.42, 0.34, 0.26) }, uRing: { value: V3(...pal.eye.ring) },
        uEyeLight: { value: 1 }, uCatch: { value: 1 }, uEnvTop: { value: new THREE.Vector3() }, uEnvBot: { value: new THREE.Vector3() }, uIrisR: { value: 0.9 },
      },
    });
    disposables.push(mat);
    const ball = new THREE.Mesh(eyeGeo, mat); socket.add(ball);
    const lidU = new THREE.Mesh(lidUGeo, lidMat), lidL = new THREE.Mesh(lidLGeo, lidMat);
    socket.add(lidU, lidL);
    eyes.push({ side, socket, ball, mat, lidU, lidL, rot: new THREE.Matrix3() });
  }

  // 鼻子、嘴、張嘴(打哈欠用)
  const o3 = [0, 0, 0];
  const noseGeo = buildNose(quality); disposables.push(noseGeo);
  const noseMat = new THREE.ShaderMaterial({ vertexShader: solidVS, fragmentShader: solidFS, uniforms: Object.assign({}, S, { uAlb: { value: new THREE.Vector3(...pal.nose) }, uGloss: { value: 0.3 }, uRim: { value: 0.2 }, uSheenCol: { value: new THREE.Vector3(1, 0.6, 0.6) }, uLidEdge: { value: 0 }, uEdge: { value: pal.noseEdge }, uR: { value: 1 } }) });
  disposables.push(noseMat);
  const nose = new THREE.Mesh(noseGeo, noseMat); onHead(0, -0.255, o3); nose.position.set(o3[0], o3[1], o3[2] - 0.012); nose.rotation.x = -0.25; nose.scale.setScalar(0.8); headOff.add(nose);
  // 小小的舌尖(參考圖嘴巴下面那一點粉紅)
  const tongueGeo = new THREE.SphereGeometry(1, 16, 10); disposables.push(tongueGeo);
  const tongue = new THREE.Mesh(tongueGeo, noseMat); onHead(0, -0.445, o3); tongue.position.set(o3[0], o3[1], o3[2] - 0.012); tongue.scale.set(0.034, 0.02, 0.02); headOff.add(tongue);
  const mouthGeo = buildMouth(); disposables.push(mouthGeo);
  const mouthMat = new THREE.ShaderMaterial({ vertexShader: solidVS, fragmentShader: solidFS, uniforms: Object.assign({}, S, { uAlb: { value: new THREE.Vector3(0.006, 0.004, 0.005) }, uGloss: { value: 0.0 }, uRim: { value: 0.0 }, uSheenCol: { value: new THREE.Vector3() }, uLidEdge: { value: 0 }, uEdge: { value: 0 }, uR: { value: 1 } }) });
  disposables.push(mouthMat);
  headOff.add(new THREE.Mesh(mouthGeo, mouthMat));
  const mouthOpenGeo = new THREE.CircleGeometry(0.1, 24); disposables.push(mouthOpenGeo);
  const mouthOpenMat = new THREE.ShaderMaterial({ vertexShader: solidVS, fragmentShader: solidFS, uniforms: Object.assign({}, S, { uAlb: { value: new THREE.Vector3(0.22, 0.03, 0.05) }, uGloss: { value: 0.1 }, uRim: { value: 0 }, uSheenCol: { value: new THREE.Vector3() }, uLidEdge: { value: 0 }, uEdge: { value: 0 }, uR: { value: 1 } }) });
  disposables.push(mouthOpenMat);
  const mouthOpen = new THREE.Mesh(mouthOpenGeo, mouthOpenMat); onHead(0, -0.47, o3); mouthOpen.position.set(o3[0], o3[1], o3[2] + 0.005); mouthOpen.scale.set(1, 0.001, 1); mouthOpen.visible = false; headOff.add(mouthOpen);

  // 鬍鬚
  const whiskGeo = buildWhiskers(makeRng(seed + 101)); disposables.push(whiskGeo);
  const whiskMat = new THREE.ShaderMaterial({ vertexShader: whiskerVS, fragmentShader: whiskerFS, transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { uWLag: { value: new THREE.Vector3() }, uWGrav: { value: new THREE.Vector3() }, uWCol: { value: new THREE.Vector3(1, 1, 1) } } });
  disposables.push(whiskMat);
  const whiskers = new THREE.Mesh(whiskGeo, whiskMat); whiskers.renderOrder = 8; whiskers.frustumCulled = false; headOff.add(whiskers);

  // 身體
  const body = new THREE.Group(); catRoot.add(body);
  const bodyGeo = buildBody(quality, pal); disposables.push(bodyGeo);
  body.add(new THREE.Mesh(bodyGeo, furMat({})));
  body.add(shellsOf(bodyGeo, furMat({ shells: qs.shells.body }), qs.shells.body, 2));

  // 前掌:先找毯子上的落點
  const pawWorldZ = PAW.pz, pawTopY = blanketTopY(PAW.px + CAT_X, pawWorldZ - 0.02);
  const pawDy = pawTopY + 0.085 - PAW.py;     // 讓掌底陷進毯子一點
  const pawPivot = new THREE.Group(); pawPivot.position.set(PAW.sx, PAW.sy + pawDy, PAW.sz); catRoot.add(pawPivot);
  const pawGeo = buildPaw(quality, pal); pawGeo.translate(-PAW.sx, -PAW.sy, -PAW.sz); disposables.push(pawGeo);
  pawPivot.add(new THREE.Mesh(pawGeo, furMat({})));
  pawPivot.add(shellsOf(pawGeo, furMat({ shells: qs.shells.paw }), qs.shells.paw, 6));
  const pawWorld = new THREE.Vector3(PAW.px + CAT_X, pawTopY, PAW.pz);

  // 尾巴
  const tailGeo = buildTail(quality, pal); disposables.push(tailGeo);
  const TP = [], TN = [], TB = [];
  for (let i = 0; i < TAIL_N; i++) { TP.push(new THREE.Vector3()); TN.push(new THREE.Vector3(1, 0, 0)); TB.push(new THREE.Vector3(0, 0, 1)); }
  const tailU = { uTP: { value: TP }, uTN: { value: TN }, uTB: { value: TB }, uTailLen: { value: 2.2 } };
  const tailBase = new THREE.Mesh(tailGeo, furMat({ defines: { TAIL: 1, TAILN: TAIL_N }, extra: tailU })); tailBase.frustumCulled = false; scene.add(tailBase);
  const tailShellMat = furMat({ shells: qs.shells.tail, defines: { TAIL: 1, TAILN: TAIL_N }, extra: tailU });
  scene.add(shellsOf(tailGeo, tailShellMat, qs.shells.tail, 1));

  // 毯子
  const blGeo = buildBlanket(quality, pawWorld); disposables.push(blGeo);
  const blU = { uPawC: { value: new THREE.Vector4(pawWorld.x, pawWorld.y, pawWorld.z, 0.28) }, uHeadC: { value: new THREE.Vector4(CAT_X, -0.6, 0.55, 1.0) } };
  const blBaseMat = furMat({ defines: { BLANKET: 1 }, extra: blU, sheen: 0.05, rim: 0.3, sheenCol: [0.6, 0.75, 1], ao: 0.62 });
  const blShellMat = furMat({ shells: qs.shells.blanket, defines: { BLANKET: 1 }, extra: blU, sheen: 0.05, rim: 0.3, sheenCol: [0.6, 0.75, 1], ao: 0.62, alpha: 1 });
  blShellMat.uniforms.uGrav.value.set(0, 0, 0); blShellMat.uniforms.uFurScale.value = 1;
  scene.add(new THREE.Mesh(blGeo, blBaseMat));
  scene.add(shellsOf(blGeo, blShellMat, qs.shells.blanket, 5));

  const headShellU = headShellMat.uniforms, headBaseU = headBaseMat.uniforms;

  // ---------- 光線(setHour) ----------
  const tmpV = new THREE.Vector3();
  function applyHour(h) {
    const [wd, wk, wn] = hourWeights(h);
    const mixv = (k, out) => out.copy(LOOKS.day[k]).multiplyScalar(wd).addScaledVector(LOOKS.dusk[k], wk).addScaledVector(LOOKS.night[k], wn);
    const mixs = (k) => LOOKS.day[k] * wd + LOOKS.dusk[k] * wk + LOOKS.night[k] * wn;
    mixv('key', S.uKeyCol.value); mixv('fill', S.uFillCol.value); mixv('rim', S.uRimCol.value); mixv('sky', S.uSkyCol.value); mixv('gnd', S.uGndCol.value);
    mixv('bgDark', bgMat.uniforms.uBgDark.value); mixv('bgMid', bgMat.uniforms.uBgMid.value); mixv('bgGlow', bgMat.uniforms.uBgGlow.value); mixv('bgLow', bgMat.uniforms.uBgLow.value);
    mixv('whisk', whiskMat.uniforms.uWCol.value);
    for (const e of eyes) { e.mat.uniforms.uEyeLight.value = mixs('eyeLight'); e.mat.uniforms.uCatch.value = mixs('catch'); mixv('envTop', e.mat.uniforms.uEnvTop.value); mixv('envBot', e.mat.uniforms.uEnvBot.value); }
    const bl = mixs('blanket');
    blBaseMat.uniforms.uAO.value = 0.35; for (const m of [blBaseMat, blShellMat]) m.uniforms.uShellAlpha.value = m === blShellMat ? 1 : 1;
    st.hourPupil = mixs('pupil'); st.blanketLight = bl;
    // 夜裡月光從右上(窗)進來
    tmpV.set(lerp(-0.55, 0.5, wn), lerp(0.75, 0.7, wn), lerp(0.62, 0.3, wn)).normalize(); S.uKeyDir.value.copy(tmpV);
  }

  // ---------- 動畫狀態 ----------
  const st = {
    gaze: null, mood: 'awake', mA: 0, mS: 0, hourPupil: 0, blanketLight: 1,
    lookX: 0.5, lookY: 0.45, nextLook: 0.8,
    eyeYaw: new Spring(0), eyePitch: new Spring(0), headYaw: new Spring(0), headPitch: new Spring(0), headRoll: new Spring(0),
    prevYaw: 0, prevPitch: 0, lagX: new Spring(0), lagY: new Spring(0),
    blinkT: -10, blinkDur: 0.24, nextBlink: 1.2, blinkQueue: -1,
    tiltT: -10, tiltDir: 1, nextTilt: 5,
    earTw: [new Spring(0), new Spring(0)], earTwY: [new Spring(0), new Spring(0)], nextEar: [3, 6],
    earBaseYaw: [new Spring(0), new Spring(0)],
    flickT: -10, flickDir: 1, nextFlick: 7,
    yawnT: -10, nextYawn: 40,
    pawT: -10, nextPaw: 22,
    pupil: 0.5,
  };
  st.nextLook = rng.range(1.0, 2.5); st.nextBlink = rng.range(1.5, 4); st.nextEar = [rng.range(3, 8), rng.range(4, 11)]; st.nextTilt = rng.range(4, 9); st.nextFlick = rng.range(5, 10); st.nextPaw = rng.range(18, 32); st.nextYawn = rng.range(45, 80);

  // 螢幕座標 → 世界中的注視點(不用 projectionMatrixInverse,免得被 zoom 的 view offset 影響)
  const target = new THREE.Vector3();
  const headWorld = new THREE.Vector3(CAT_X + HEAD.cx, HEAD.cy, HEAD.cz);
  let tanY = Math.tan(15 * Math.PI / 180), asp = aspect;
  function screenToTarget(x, y, out) {
    const nx = 2 * x - 1, ny = 1 - 2 * y, zp = 2.4, d = camera.position.z - zp;
    return out.set(nx * d * tanY * asp, ny * d * tanY, zp);
  }
  function anglesTo(p) {
    const dx = p.x - headWorld.x, dy = p.y - headWorld.y, dz = p.z - headWorld.z;
    st._ty = Math.atan2(dx, dz); st._tp = Math.atan2(dy, Math.hypot(dx, dz));
  }

  // ---------- 耳朵矩陣 ----------
  const qBase = [new THREE.Quaternion(), new THREE.Quaternion()], qBaseInv = [new THREE.Quaternion(), new THREE.Quaternion()];
  const eul = new THREE.Euler(), qTw = new THREE.Quaternion(), qTmp = new THREE.Quaternion(), mTmp = new THREE.Matrix4(), mT1 = new THREE.Matrix4(), mT2 = new THREE.Matrix4();
  const pivots = [EAR_PIVOT(-1), EAR_PIVOT(1)];
  for (let k = 0; k < 2; k++) { const side = k === 0 ? -1 : 1; qBase[k].setFromEuler(new THREE.Euler(EAR.rx, EAR.ry * side, EAR.rz * side, 'YXZ')); qBaseInv[k].copy(qBase[k]).invert(); }
  function earMatrix(k, rx, ry, rz, out) {
    // 在耳朵自己的座標系裡轉:M = T(p) · Qb · R · Qb⁻¹ · T(-p)
    eul.set(rx, ry, rz, 'YXZ'); qTw.setFromEuler(eul);
    qTmp.copy(qBase[k]).multiply(qTw).multiply(qBaseInv[k]);
    mTmp.makeRotationFromQuaternion(qTmp);
    const p = pivots[k];
    mT1.makeTranslation(p.x, p.y, p.z); mT2.makeTranslation(-p.x, -p.y, -p.z);
    out.multiplyMatrices(mT1, mTmp).multiply(mT2);
  }

  // ---------- 尾巴 ----------
  const TAIL_BASE = new THREE.Vector3(-0.86, -1.0, -0.15), TAIL_LEN = 2.1;
  const tailAng = new Float32Array(TAIL_N), tailPhi = new Float32Array(TAIL_N);
  function tailDrive(t, ch) { return fnoise(t * 0.45, ch) * 0.85 + Math.sin(t * 1.7 + ch) * 0.5 + Math.sin(t * 0.61 + ch * 2.0) * 0.35; }
  function updateTail(t) {
    const ds = TAIL_LEN / (TAIL_N - 1);
    const sleepy = st.mS, alert = st.mA;
    const ts = t * (1 - 0.45 * sleepy) * (1 + 0.35 * alert);
    const amp = (1 - 0.6 * sleepy) * (1 + 0.2 * alert);
    const curl = (1 + 0.12 * fnoise(t * 0.17, 31)) * (1 - 0.3 * alert);
    let th = Math.PI / 2 + 0.04 + 0.2 * amp * tailDrive(ts, 3);
    let x = TAIL_BASE.x, y = TAIL_BASE.y, z = TAIL_BASE.z;
    TP[0].set(x, y, z);
    for (let i = 1; i < TAIL_N; i++) {
      const s = i / (TAIL_N - 1);
      // 靜止形狀:下半直、上半捲成「?」
      const k0 = 0.08 + 3.4 * smoothstep(0.42, 0.78, s) * (1 - 0.35 * smoothstep(0.9, 1.0, s));
      // 從根部往尾端傳的波(尾端慢一拍)
      const lagT = ts - s * 1.5;
      const wave = 1.25 * amp * (0.3 + s) * tailDrive(lagT, 7);
      // 偶發的尾尖甩動
      const ft = t - st.flickT - s * 0.22;
      const flick = ft > -0.05 && ft < 0.9 ? st.flickDir * 6.0 * s * s * Math.exp(-((ft - 0.12) * (ft - 0.12)) / 0.012) : 0;
      th += (k0 * curl + wave + flick) * ds;
      const phi = 0.35 * amp * s * fnoise(lagT * 0.8, 13);
      const c = Math.cos(phi);
      x += Math.cos(th) * ds * c; y += Math.sin(th) * ds * c; z += Math.sin(phi) * ds;
      TP[i].set(x, y, z);
      tailAng[i] = th; tailPhi[i] = phi;
    }
    // 框架:T = 切線、N 在畫面平面上垂直、B = T × N
    for (let i = 0; i < TAIL_N; i++) {
      const a = TP[Math.max(i - 1, 0)], b = TP[Math.min(i + 1, TAIL_N - 1)];
      let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z; const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // N = normalize(T × Z)
      let nx = ty, ny = -tx, nz = 0; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      TN[i].set(nx, ny, nz);
      TB[i].set(ty * nz - tz * ny, tz * nx - tx * nz, tx * ny - ty * nx);
    }
  }

  // ---------- 事件 ----------
  function startBlink(t, slow) { st.blinkT = t; st.blinkDur = slow ? 0.6 : 0.24; }
  function blinkAmount(t) {
    const u = (t - st.blinkT) / st.blinkDur;
    if (u < 0 || u > 1) return 0;
    return u < 0.3 ? smoothstep(0, 0.3, u) : u < 0.42 ? 1 : 1 - smoothstep(0.42, 1, u);
  }
  function startTwitch(k, strength) { st.earTw[k].v += (k === 0 ? 1 : -1) * 22 * strength; st.earTwY[k].v += 14 * strength * (k === 0 ? -1 : 1); }

  function update(dt, t) {
    dt = Math.min(dt, 0.1);
    // 情緒平滑切換
    st.mA = damp(st.mA, st.mood === 'alert' ? 1 : 0, 2.5, dt);
    st.mS = damp(st.mS, st.mood === 'sleepy' ? 1 : 0, 1.5, dt);
    const sleepy = st.mS, alert = st.mA;

    // --- 注視目標 ---
    if (t >= st.nextLook) {
      const r = rng();
      const prevX = st.lookX, prevY = st.lookY;
      if (st.gaze) { st.lookX = st.gaze[0] + (rng() - 0.5) * 0.03; st.lookY = st.gaze[1] + (rng() - 0.5) * 0.03; }
      else if (r < 0.4) { st.lookX = 0.5 + (rng() - 0.5) * 0.08; st.lookY = 0.42 + (rng() - 0.5) * 0.06; }   // 看觀眾
      else { st.lookX = rng.range(0.08, 0.92); st.lookY = rng.range(0.15, 0.95); }
      st.nextLook = t + rng.range(1.5, 4) * (1 + sleepy * 0.8);
      // 大幅轉眼常伴隨眨眼
      if (Math.hypot(st.lookX - prevX, st.lookY - prevY) > 0.35 && rng() < 0.45 && t - st.blinkT > 0.6) startBlink(t + 0.02, sleepy > 0.5);
    }
    if (st.gaze && Math.abs(st.lookX - st.gaze[0]) > 0.05 + 0.0 || st.gaze && Math.abs(st.lookY - st.gaze[1]) > 0.05) { st.lookX = st.gaze[0]; st.lookY = st.gaze[1]; }
    screenToTarget(st.lookX, st.lookY, target); anglesTo(target);
    const ty = st._ty, tp = st._tp;

    // 眼睛快、頭慢(而且有一點過衝)
    const eyeW = 34 * (1 - 0.5 * sleepy);
    st.eyeYaw.step(ty, eyeW, 0.72, dt); st.eyePitch.step(tp, eyeW, 0.72, dt);
    const headW = 5.2 * (1 - 0.45 * sleepy) * (1 + 0.3 * alert);
    st.headYaw.step(clamp(ty * 0.72, -0.55, 0.55), headW, 0.5, dt);
    st.headPitch.step(clamp(tp * 0.6, -0.24, 0.22), headW, 0.55, dt);

    // 歪頭(好奇)
    if (t >= st.nextTilt) { st.tiltT = t; st.tiltDir = rng.sign(); st.nextTilt = t + rng.range(6, 13); }
    const tu = (t - st.tiltT) / 2.4;
    const tiltAmt = tu > 0 && tu < 1 ? smoothstep(0, 0.18, tu) * (1 - smoothstep(0.7, 1, tu)) : 0;
    const rollT = clamp(0.05 * fnoise(t * 0.16, 41) + 0.15 * st.tiltDir * tiltAmt * (1 - sleepy * 0.5) + 0.08 * sleepy - 0.25 * st.headYaw.x, -0.16, 0.16);
    st.headRoll.step(rollT, 4.2, 0.42, dt);

    // 呼吸
    const breathHz = lerp(0.5, 0.4, sleepy) + 0.05 * alert;
    const br = Math.sin(t * Math.PI * 2 * breathHz + 0.4 * fnoise(t * 0.1, 51));

    // 打哈欠
    if (t >= st.nextYawn) { st.yawnT = t; st.nextYawn = t + (sleepy > 0.5 ? rng.range(16, 30) : rng.range(60, 120)); }
    const yu = (t - st.yawnT) / 2.8;
    const yawn = yu > 0 && yu < 1 ? smoothstep(0.08, 0.35, yu) * (1 - smoothstep(0.68, 0.95, yu)) : 0;

    const nod = 0.035 * fnoise(t * 0.21, 61) + 0.012 * br - 0.06 * sleepy;
    headPivot.rotation.set(-(st.headPitch.x + nod + 0.22 * yawn), st.headYaw.x, st.headRoll.x, 'YXZ');
    headPivot.position.y = NECK.y + 0.006 * br;
    body.scale.set(1 + 0.008 * br, 1 + 0.012 * br, 1 + 0.008 * br);

    // 毛跟不上頭的動作(慣性)
    const yawVel = (st.headYaw.x - st.prevYaw) / Math.max(dt, 1e-3), pitchVel = (st.headPitch.x - st.prevPitch) / Math.max(dt, 1e-3);
    st.prevYaw = st.headYaw.x; st.prevPitch = st.headPitch.x;
    st.lagX.step(clamp(-yawVel * 0.016, -0.04, 0.04), 9, 0.5, dt); st.lagY.step(clamp(pitchVel * 0.016, -0.04, 0.04) - 0.004 * br, 9, 0.5, dt);
    headShellU.uLag.value.set(st.lagX.x, st.lagY.x, 0);
    whiskMat.uniforms.uWLag.value.set(st.lagX.x * 3, st.lagY.x * 3 + 0.006 * br, 0);

    // 眼睛相對頭的角度
    const relYaw = clamp(st.eyeYaw.x - st.headYaw.x, -0.36, 0.36), relPitch = clamp(st.eyePitch.x - st.headPitch.x - nod * 0.5, -0.3, 0.26);
    // 眨眼
    if (t >= st.nextBlink) {
      startBlink(t, sleepy > 0.5);
      st.blinkQueue = rng() < 0.2 ? t + st.blinkDur + 0.08 : -1;
      st.nextBlink = t + (sleepy > 0.5 ? rng.range(2.5, 5) : rng.range(2.5, 7));
    }
    if (st.blinkQueue > 0 && t >= st.blinkQueue) { startBlink(t, sleepy > 0.5); st.blinkQueue = -1; }
    const blink = blinkAmount(t);
    // 想睡時眼皮慢慢往下掉、又撐開
    const droop = sleepy * (0.55 + 0.25 * fnoise(t * 0.25, 71));
    const closeAmt = clamp(Math.max(blink, droop, yawn * 0.9), 0, 1);
    const upOpen = lerp(0.66, 0.8, alert) + relPitch * 0.2, loOpen = lerp(-0.74, -0.8, alert) + relPitch * 0.2;
    const upEdge = lerp(upOpen, -0.2, closeAmt), loEdge = lerp(loOpen, -0.24, closeAmt * 0.9 + yawn * 0.1);
    const thU = -Math.asin(clamp(upEdge, -0.99, 0.99)), thL = -Math.asin(clamp(loEdge, -0.99, 0.99));
    // 瞳孔
    const pupT = clamp(0.48 + 0.18 * alert - 0.06 * sleepy + st.hourPupil + 0.03 * fnoise(t * 0.3, 81), 0.3, 0.74);
    st.pupil = damp(st.pupil, pupT, 2.2, dt);
    for (const e of eyes) {
      const yawL = relYaw - EYE.yaw * e.side + 0.03 * -e.side;   // 一點點鬥雞(看近處)
      e.ball.rotation.set(-relPitch, yawL, 0, 'YXZ');
      e.ball.updateMatrix(); e.rot.setFromMatrix4(e.ball.matrix);
      e.mat.uniforms.uEyeRot.value.copy(e.rot);
      e.lidU.rotation.x = thU; e.lidL.rotation.x = thL;
      e.mat.uniforms.uLidNU.value.set(0, Math.cos(thU), Math.sin(thU));
      e.mat.uniforms.uLidNL.value.set(0, -Math.cos(thL), -Math.sin(thL));
      e.mat.uniforms.uPupil.value = st.pupil;
    }

    // 耳朵:轉向注視方向 + 隨機抖動
    for (let k = 0; k < 2; k++) {
      if (t >= st.nextEar[k]) { startTwitch(k, 1); st.nextEar[k] = t + rng.range(4, 12); }
      st.earTw[k].step(0, 26, 0.22, dt); st.earTwY[k].step(0, 20, 0.3, dt);
      const side = k === 0 ? -1 : 1;
      st.earBaseYaw[k].step(relYaw * 0.0 + st.eyeYaw.x * 0.35 * (side * st.eyeYaw.x > 0 ? 1.0 : 0.4), 6, 0.6, dt);
      const rx = -0.12 * alert + 0.22 * sleepy * 0.5 + 0.35 * yawn + st.earTw[k].x * 0.02;
      const ry = st.earBaseYaw[k].x - side * 0.3 * alert * 0 + st.earTwY[k].x * 0.02 + side * 0.25 * sleepy;
      const rz = side * (0.18 * sleepy - 0.06 * alert + 0.2 * yawn) + st.earTw[k].x * 0.012;
      earMatrix(k, rx, ry, rz, k === 0 ? earL : earR);
    }

    // 尾巴
    if (t >= st.nextFlick) { st.flickT = t; st.flickDir = rng.sign(); st.nextFlick = t + rng.range(5, 12) * (1 + sleepy); }
    updateTail(t);

    // 前掌:偶爾踩一下
    if (t >= st.nextPaw) { st.pawT = t; st.nextPaw = t + rng.range(20, 40); }
    const pu = (t - st.pawT) / 1.1;
    const tap = pu > 0 && pu < 1 ? Math.sin(Math.PI * smoothstep(0, 0.55, pu)) * (pu < 0.55 ? 1 : 0) : 0;
    const press = pu > 0.5 && pu < 1 ? Math.sin(Math.PI * (pu - 0.5) / 0.5) : 0;
    pawPivot.rotation.set(-0.11 * tap + 0.025 * press + 0.006 * br, 0, 0);

    // 張嘴
    mouthOpen.visible = yawn > 0.01;
    mouthOpen.scale.set(0.9 + 0.55 * yawn, Math.max(0.001, 1.25 * yawn), 1);
  }

  applyHour(12);
  if (typeof location !== 'undefined' && /[?&]dbg=1/.test(location.search)) { const out = []; scene.traverse((o) => { if (o.isMesh) { const g = o.geometry, tri = (g.index ? g.index.count : g.attributes.position.count) / 3; out.push((o.material.defines && o.material.defines.SHELL ? 'shell' : 'mesh') + ':' + Math.round(tri) + 'x' + (g.instanceCount || 1)); } }); console.warn('[pixar] ' + out.join(' ')); }
  updateTail(0);
  update(0, 0);

  return {
    scene, camera, update,
    resize(a) { camera.aspect = a; asp = a; camera.updateProjectionMatrix(); },
    setGaze(x, y) {
      if (x == null || y == null || !isFinite(x) || !isFinite(y)) { st.gaze = null; return; }
      st.gaze = [clamp(+x, 0, 1), clamp(+y, 0, 1)]; st.lookX = st.gaze[0]; st.lookY = st.gaze[1]; st.nextLook = -1;
    },
    setMood(name) { st.mood = name === 'sleepy' || name === 'alert' ? name : 'awake'; },
    setHour(h) { if (isFinite(h)) applyHour(+h); },
    poke(kind) {
      const t = st._t || 0;
      if (kind === 'blink') st.nextBlink = 0;
      else if (kind === 'earTwitch') { st.nextEar[0] = 0; st.nextEar[1] = 0.0; }
      else if (kind === 'tailFlick') st.nextFlick = 0;
      else if (kind === 'yawn') st.nextYawn = 0;
      else if (kind === 'pawTap') st.nextPaw = 0;
    },
    dispose() {
      for (const d of disposables) d.dispose?.();
      scene.clear();
    },
  };
}
