// 自訂著色器:毛(底層 + 多層殼,一次 instanced draw)、眼睛、鬍鬚、背景。
// 光照自己算(主光、補光、輪廓光、天地環境光),所有材質共用同一組 uniform 物件,setHour 一次改全部。

const LIGHT = /* glsl */`
uniform vec3 uKeyDir; uniform vec3 uKeyCol;
uniform vec3 uFillDir; uniform vec3 uFillCol;
uniform vec3 uRimDir; uniform vec3 uRimCol;
uniform vec3 uSkyCol; uniform vec3 uGndCol;
vec3 shade(vec3 N, vec3 V, vec3 alb, float ao, float sheen, vec3 sheenCol, float rimAmt) {
  float nk = dot(N, uKeyDir), nf = dot(N, uFillDir);
  vec3 diff = uKeyCol * clamp((nk + 0.3) / 1.3, 0.0, 1.0)
            + uFillCol * clamp((nf + 0.5) / 1.5, 0.0, 1.0)
            + mix(uGndCol, uSkyCol, N.y * 0.5 + 0.5);
  vec3 c = alb * diff * ao;
  vec3 H = normalize(uKeyDir + V);
  c += sheenCol * uKeyCol * pow(max(dot(N, H), 0.0), 22.0) * sheen * ao;
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float fr = pow(1.0 - nv, 3.0);
  float rl = clamp(dot(N, uRimDir) * 0.55 + 0.6, 0.0, 1.0);
  c += uRimCol * fr * rl * rimAmt;
  return c;
}
`;

// ---------- 毛 ----------
// 屬性:aSkin(底層顏色)、aHair(毛色)、aFur = (長度, 密度, 耳朵權重[左負右正], 透光)
// 定義:SHELL(殼層,用 gl_InstanceID 決定高度)、EARS(耳朵在 shader 裡轉)、TAIL(沿骨架曲線變形)、BLANKET(毛毯的捲毛)
export const furVS = /* glsl */`
attribute vec3 aSkin; attribute vec3 aHair; attribute vec4 aFur;
uniform float uShells; uniform float uFurScale; uniform vec3 uGrav; uniform vec3 uLag;
#ifdef EARS
uniform mat4 uEarL; uniform mat4 uEarR;
#endif
#ifdef TAIL
uniform vec3 uTP[TAILN]; uniform vec3 uTN[TAILN]; uniform vec3 uTB[TAILN];
uniform float uTailLen;
#endif
varying vec3 vN; varying vec3 vW; varying vec3 vBase; varying vec3 vSkin; varying vec3 vHair; varying vec4 vFur; varying float vH;
void main() {
  vec3 p = position; vec3 n = normal; vec3 base = position;
#ifdef TAIL
  float s = position.x, a = position.y, r = position.z;
  float fi = s * float(TAILN - 1);
  int i0 = int(min(floor(fi), float(TAILN - 2)));
  float f = fi - float(i0);
  int im = max(i0 - 1, 0), i1 = i0 + 1, i2 = min(i0 + 2, TAILN - 1);
  vec3 P0 = uTP[im], P1 = uTP[i0], P2 = uTP[i1], P3 = uTP[i2];
  float f2 = f * f, f3 = f2 * f;
  vec3 P = 0.5 * ((2.0 * P1) + (-P0 + P2) * f + (2.0 * P0 - 5.0 * P1 + 4.0 * P2 - P3) * f2 + (-P0 + 3.0 * P1 - 3.0 * P2 + P3) * f3);
  vec3 Nn = normalize(mix(uTN[i0], uTN[i1], f)), Bn = normalize(mix(uTB[i0], uTB[i1], f));
  vec3 T = normalize(cross(Nn, Bn));
  float cap = normal.x;  // 尾端收口:法線往切線方向偏
  n = normalize((cos(a) * Nn + sin(a) * Bn) * (1.0 - cap) + T * cap);
  p = P + (cos(a) * Nn + sin(a) * Bn) * r;
  base = vec3(s * uTailLen, cos(a) * 0.1, sin(a) * 0.1);
#endif
#ifdef EARS
  float w = abs(aFur.z);
  if (w > 0.001) {
    mat4 M = aFur.z < 0.0 ? uEarL : uEarR;
    p = mix(p, (M * vec4(p, 1.0)).xyz, w);
    n = normalize(mix(n, mat3(M) * n, w));
  }
#endif
  float h = 0.0;
#ifdef SHELL
  h = float(gl_InstanceID + 1) / uShells;
  float L = aFur.x * uFurScale;
  p += n * (L * h) + (uGrav * L + uLag * aFur.x * 12.0) * (h * h);
#endif
  vH = h; vSkin = aSkin; vHair = aHair; vFur = aFur; vBase = base;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const furFS = /* glsl */`
precision highp float;
uniform sampler3D uNoise; uniform float uDensity; uniform vec3 uSheenCol; uniform float uSheen; uniform float uRim;
uniform float uShellAlpha; uniform vec3 uGlow; uniform float uAO; uniform float uTick;
#ifdef BLANKET
uniform vec4 uPawC; uniform vec4 uHeadC;
#endif
${LIGHT}
varying vec3 vN; varying vec3 vW; varying vec3 vBase; varying vec3 vSkin; varying vec3 vHair; varying vec4 vFur; varying float vH;
void main() {
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  if (!gl_FrontFacing) N = -N;
  float h = vH, a = 1.0;
  vec3 alb = vSkin;
  float ao = 1.0;
#ifdef BLANKET
  float lump = texture(uNoise, vBase * 0.16).r * 0.6 + texture(uNoise, vBase * 0.41 + 0.5).r * 0.4;
  float curl = texture(uNoise, vBase * 1.3 + 0.31).r;
  float fine = texture(uNoise, vBase * 5.0 + 0.71).r;
  float sh = smoothstep(0.25, 0.75, lump) * 0.62 + curl * 0.26 + fine * 0.12;
#ifdef SHELL
  a = clamp((sh + 0.08 - h * 0.85) * 4.5, 0.0, 1.0) * (1.0 - h * 0.3);
  a *= smoothstep(0.04, 0.32, abs(dot(N, V)));   // 斜看時殼層會變成條紋,淡掉
  if (a < 0.02) discard;
#endif
  float top = clamp(h * 0.9 + (sh - 0.35) * 0.9, 0.0, 1.0);
  alb = mix(vSkin, vHair, top);
  ao = mix(uAO, 1.0, top);
  // 假的接觸陰影:貓掌、下巴附近變暗
  vec3 dp = (vW - uPawC.xyz) / uPawC.w; float sp = exp(-dot(dp, dp) * 1.6);
  vec3 dh = (vW - uHeadC.xyz) * vec3(1.0 / uHeadC.w, 2.2 / uHeadC.w, 1.6 / uHeadC.w); float shd = exp(-dot(dh, dh) * 1.2);
  ao *= 1.0 - 0.6 * sp - 0.45 * shd;
  ao *= 0.55 + 0.45 * smoothstep(-1.5, -0.62, vW.y);   // 往下(App 列那邊)暗一點、靜一點
#else
#ifdef SHELL
  float n1 = texture(uNoise, vBase * uDensity).r;
  float n2 = texture(uNoise, vBase * uDensity * 0.23 + 0.37).r;
  float st = n1 * 0.78 + n2 * 0.22;
  a = clamp((st * (0.55 + 0.45 * vFur.y) - h * 0.92) * 7.0, 0.0, 1.0) * (1.0 - h * h * 0.45) * uShellAlpha;
  if (vFur.x < 0.002 || a < 0.015) discard;
  alb = vHair * mix(1.0 - uTick, 1.0 + uTick * 0.6, n1) * mix(0.92, 1.04, n2);   // 每根毛深淺不同(虎斑的 ticking)
#endif
  ao = mix(uAO, 1.0, h);
#endif
  vec3 c = shade(N, V, alb, ao, uSheen * (0.3 + h), uSheenCol, uRim * (0.12 + 0.88 * h * h) * smoothstep(0.004, 0.03, vFur.x + 0.03 * step(0.5, vFur.w)));
  // 耳朵內側透光(暖色)
  c += uGlow * vFur.w * (0.6 + 0.4 * clamp(dot(N, uRimDir) * -0.5 + 0.7, 0.0, 1.0)) * (1.0 - h * 0.7) * (0.15 + 0.3 * length(uKeyCol));
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------- 一般實體表面(鼻子、眼皮、嘴巴):同一套光照,可調光澤 ----------
export const solidVS = /* glsl */`
varying vec3 vN; varying vec3 vW; varying vec3 vL;
void main() {
  vL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
export const solidFS = /* glsl */`
uniform vec3 uAlb; uniform float uGloss; uniform float uRim; uniform vec3 uSheenCol; uniform float uLidEdge; uniform float uR; uniform float uEdge;
#ifdef LID
uniform sampler3D uNoise;
#endif
${LIGHT}
varying vec3 vN; varying vec3 vW; varying vec3 vL;
void main() {
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  if (!gl_FrontFacing) N = -N;
  vec3 c = shade(N, V, uAlb, 1.0, 0.12, uSheenCol, uRim);
  vec3 H = normalize(uKeyDir + V);
  c += uKeyCol * pow(max(dot(N, H), 0.0), 60.0) * uGloss;
  vec3 R = reflect(-V, N);
  c += uSkyCol * 2.0 * uGloss * smoothstep(0.2, 0.9, R.y) * pow(1.0 - max(dot(N, V), 0.0), 2.0);
  c *= 1.0 - uEdge * smoothstep(0.45, 0.1, max(dot(N, V), 0.0));   // 描邊
#ifdef LID
  // 眼皮:細絨毛的顆粒 + 邊緣一條細的深色眼線
  float fz = texture(uNoise, vL * 9.0).r * 0.6 + texture(uNoise, vL * 2.5 + 0.3).r * 0.4;
  c *= 0.75 + 0.5 * fz;
  // 眼皮邊緣:一條細的深色眼線 + 濕潤的細亮邊
  float e = abs(vL.y) / uR;
  c *= mix(0.35, 1.0, smoothstep(0.0, 0.16, e));
  c += uKeyCol * 0.05 * (1.0 - smoothstep(0.0, 0.05, e));
#endif
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------- 眼睛:折射的虹膜、角膜反光 ----------
export const eyeVS = /* glsl */`
uniform mat3 uEyeRot; uniform float uR;
varying vec3 vL; varying vec3 vS; varying vec3 vCamL; varying vec3 vV; varying vec3 vNV;
varying vec3 vAx; varying vec3 vAy; varying vec3 vAz;
void main() {
  vL = position / uR; vS = uEyeRot * vL;
  vCamL = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz / uR;
  vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz;
  vAx = normalMatrix * vec3(1.0, 0.0, 0.0); vAy = normalMatrix * vec3(0.0, 1.0, 0.0); vAz = normalMatrix * vec3(0.0, 0.0, 1.0);
  vNV = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;
export const eyeFS = /* glsl */`
precision highp float;
uniform float uPupil; uniform vec3 uLidNU; uniform vec3 uLidNL;
uniform vec3 uIrisIn; uniform vec3 uIrisMid; uniform vec3 uIrisOut; uniform vec3 uLimbal; uniform vec3 uGlowC; uniform vec3 uSclera; uniform vec3 uRing;
uniform float uEyeLight; uniform float uCatch; uniform vec3 uEnvTop; uniform vec3 uEnvBot; uniform float uIrisR;
varying vec3 vL; varying vec3 vS; varying vec3 vCamL; varying vec3 vV; varying vec3 vNV;
varying vec3 vAx; varying vec3 vAy; varying vec3 vAz;
float hsh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// x 方向週期為 per 的 value noise(虹膜放射紋繞一圈接得起來)
float pnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, per), x1 = mod(i.x + 1.0, per);
  float a = hsh(vec2(x0, i.y)), b = hsh(vec2(x1, i.y)), c = hsh(vec2(x0, i.y + 1.0)), d = hsh(vec2(x1, i.y + 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec3 p = normalize(vL);
  vec3 V = normalize(vCamL - p);
  const float zL = 0.4;
  float cm = smoothstep(zL - 0.035, zL + 0.01, p.z);   // 角膜區
  // 光線在角膜折射,打到後面的虹膜平面(z = zL)
  vec3 R = refract(-V, p, 1.0 / 1.22);
  float t = (zL - p.z) / min(R.z, -0.08);
  vec2 q = (p + R * max(t, 0.0)).xy;
  float r = length(q) / uIrisR;
  vec2 qn = q / uIrisR;
  float ang = atan(q.y, q.x) / 6.2831853 + 0.5;
  // 虹膜
  float fib = pnoise(vec2(ang * 96.0, r * 3.0), 96.0) * 0.55 + pnoise(vec2(ang * 40.0, r * 7.0 + 3.0), 40.0) * 0.45;
  float fib2 = pnoise(vec2(ang * 160.0, r * 1.5 + 9.0), 160.0);
  vec3 iris = mix(uIrisIn, uIrisMid, smoothstep(uPupil + 0.04, 0.62, r));
  iris = mix(iris, uIrisOut, smoothstep(0.55, 0.9, r));
  iris *= 0.5 + 0.95 * fib * fib2 + 0.2 * fib;
  // 瞳孔旁的亮環、外圈深色角膜緣
  iris = mix(iris, uRing, smoothstep(0.1, 0.0, abs(r - uPupil - 0.09)) * 0.55);
  iris = mix(iris, uLimbal, smoothstep(0.74, 0.95, r));
  // 下半部的光(光從上方進來,在下面聚焦)
  float glow = smoothstep(0.15, -0.75, qn.y) * smoothstep(1.0, 0.55, r) * smoothstep(uPupil, uPupil + 0.2, r);
  iris += uGlowC * glow * (0.6 + 0.6 * fib);
  // 上面被眉骨/眼皮擋到
  iris *= mix(0.42, 1.0, smoothstep(0.85, -0.15, qn.y));
  float pupil = smoothstep(uPupil + 0.012, uPupil - 0.012, r);
  // 瞳孔不是死黑:往下有一點深色的反射層次
  vec3 pup = mix(vec3(0.002, 0.002, 0.003), vec3(0.012, 0.008, 0.01), smoothstep(0.2, -0.6, qn.y));
  vec3 col = mix(iris, pup, pupil);
  // 虹膜外 → 鞏膜
  vec3 scl = uSclera * (0.35 + 0.65 * smoothstep(-0.1, 0.55, p.z)) * (0.75 + 0.25 * smoothstep(-0.6, 0.4, p.y));
  col = mix(scl, col, smoothstep(1.0, 0.985, r) * cm);
  col *= uEyeLight;
  // 眼皮的陰影
  float du = dot(normalize(vS), uLidNU), dl = dot(normalize(vS), uLidNL);
  col *= mix(1.0, 0.18, smoothstep(-0.32, 0.02, du));
  col *= mix(1.0, 0.45, smoothstep(-0.12, 0.02, dl));
  // 角膜:往前鼓的法線,做反光
  vec3 nl = normalize(p + vec3(0.0, 0.0, 0.42) * cm * smoothstep(zL, 1.0, p.z));
  vec3 N = normalize(vAx * nl.x + vAy * nl.y + vAz * nl.z);
  vec3 Vv = normalize(vV);
  vec3 Rr = reflect(-Vv, N);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, Vv), 0.0), 5.0);
  vec3 env = mix(uEnvBot, uEnvTop, smoothstep(-0.3, 0.8, Rr.y));
  col = col * (1.0 - F) + env * F * 1.4;
  float c1 = smoothstep(0.9915, 0.9955, dot(Rr, normalize(vec3(-0.42, 0.52, 0.74))));
  float c2 = smoothstep(0.9982, 0.9992, dot(Rr, normalize(vec3(-0.12, 0.14, 0.98))));
  float c3 = smoothstep(0.93, 0.99, dot(Rr, normalize(vec3(0.42, -0.36, 0.83)))) * 0.05;  // 下方柔和的第二反光
  float lidMask = 1.0 - smoothstep(-0.06, 0.0, du);
  col += vec3(1.0, 0.98, 0.95) * (c1 * 1.7 + c2 * 1.25 + c3 * 0.0) * uCatch * lidMask;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------- 鬍鬚 ----------
export const whiskerVS = /* glsl */`
attribute vec2 aW; uniform vec3 uWLag; uniform vec3 uWGrav;
varying float vS; varying float vSide;
void main() {
  vS = aW.x; vSide = aW.y;
  vec3 p = position + (uWLag + uWGrav) * (aW.x * aW.x);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
export const whiskerFS = /* glsl */`
uniform vec3 uWCol;
varying float vS; varying float vSide;
void main() {
  float a = (1.0 - pow(vS, 1.6)) * (1.0 - vSide * vSide) * 0.95;
  gl_FragColor = vec4(uWCol, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------- 背景 ----------
export const bgVS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
export const bgFS = /* glsl */`
uniform vec3 uBgDark; uniform vec3 uBgMid; uniform vec3 uBgGlow; uniform vec3 uBgLow; uniform vec2 uGlowAt;
varying vec2 vUv;
void main() {
  vec2 u = vUv;
  float d = length((u - uGlowAt) * vec2(1.25, 1.0));
  vec3 c = mix(uBgGlow, uBgMid, smoothstep(0.0, 0.55, d));
  // 左上角更暗(時鐘區)
  c = mix(c, uBgDark, smoothstep(0.35, 1.0, (1.0 - u.x) * 0.75 + u.y * 0.55));
  c = mix(c, uBgLow, smoothstep(0.45, 0.0, u.y) * 0.5);
  // 抖動,避免色階
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
