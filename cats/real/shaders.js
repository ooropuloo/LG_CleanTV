// GLSL for the realistic cat. All materials share one light rig (uniform objects in `L`).
import * as THREE from 'three';

export function makeLights() {
  return {
    uKeyDir: { value: new THREE.Vector3(-0.55, 0.5, 0.67).normalize() }, uKeyCol: { value: new THREE.Color(2.2, 2.15, 2.1) },
    uRimDir: { value: new THREE.Vector3(0.75, 0.35, -0.55).normalize() }, uRimCol: { value: new THREE.Color(1.3, 0.85, 0.55) },
    uSky: { value: new THREE.Color(0.30, 0.31, 0.34) }, uGnd: { value: new THREE.Color(0.13, 0.14, 0.16) },
    uView: { value: new THREE.Vector4(0, 0, 1, 1) }, uVig: { value: 0.55 }, uTime: { value: 0 },
  };
}

const COMMON = /* glsl */`
uniform vec3 uKeyDir, uKeyCol, uRimDir, uRimCol, uSky, uGnd;
uniform vec4 uView; uniform float uVig, uTime;
uniform vec2 uRes;
#ifndef IS_VS
float vignette(){
  vec2 s = uView.xy + (gl_FragCoord.xy / uRes) * uView.zw; // full-frame 0..1 (y up)
  vec2 d = (s - vec2(0.5, 0.52)) * vec2(1.0, 0.75);
  return 1.0 - uVig * smoothstep(0.18, 0.62, dot(d, d) * 2.0);
}
#endif
vec4 hash42(vec2 p){ vec4 p4 = fract(vec4(p.xyxy) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
`;

// ---------------------------------------------------------------- fur (base skin layer + instanced shells)
// defines: SHELLS (instanced shell pass), TAIL (positions from a joint chain), HEAD (skin masks: nose, lips), EAR
const FUR_VS = /* glsl */`
#define IS_VS
${COMMON}
uniform float uFurScale, uCombK;
uniform vec3 uGrav, uLag;
attribute vec4 furA;          // x len, y ao, z skin mask, w spare
#ifdef SHELLS
attribute float shell;
#endif
#ifdef TAIL
uniform vec3 uTP[NJ];
attribute vec2 tailA;         // s 0..1, angle
#else
attribute vec3 comb;
#endif
varying vec3 vW, vN, vT, vLoc; varying vec2 vUv; varying vec4 vF; varying float vH;
void main(){
  vec3 P, N, C; vec4 F = furA;
#ifdef TAIL
  float s = tailA.x, fi = s * float(NJ - 1);
  int i = int(min(floor(fi), float(NJ - 2))); float f = fi - float(i);
  vec3 p0 = uTP[max(i - 1, 0)], p1 = uTP[i], p2 = uTP[i + 1], p3 = uTP[min(i + 2, NJ - 1)];
  float f2 = f * f, f3 = f2 * f;
  vec3 c = 0.5 * ((2.0 * p1) + (-p0 + p2) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * f3);
  vec3 tg = normalize(0.5 * ((-p0 + p2) + 2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f + 3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * f2) + vec3(0.0, 1e-4, 0.0));
  vec3 B = normalize(cross(tg, vec3(0.0, 0.0, 1.0))), Nn = cross(B, tg);
  float r0 = mix(0.072, 0.05, s), capS = 0.86;
  float cs = s > capS ? (s - capS) / (1.0 - capS) : 0.0;
  float r = r0 * sqrt(max(0.0, 1.0 - cs * cs));
  vec3 rad = Nn * cos(tailA.y) + B * sin(tailA.y);
  N = normalize(rad * sqrt(max(0.0, 1.0 - cs * cs)) + tg * cs);
  P = c + rad * r; C = normalize(tg - N * dot(tg, N) * 0.6) * (1.0 - 0.6 * cs);
  F.x = mix(0.05, 0.085, smoothstep(0.3, 1.0, s));
  vUv = vec2(s * 1.6, tailA.y * 0.055) * 1.0;
#else
  P = position; N = normal; C = comb; vUv = uv;
#endif
  float h = 0.0;
#ifdef SHELLS
  h = shell;
#endif
  float len = F.x * uFurScale;
  vec3 g = uGrav + uLag;
  vec3 disp = N * h + C * (h * h * uCombK) + (g - N * dot(g, N)) * h * h;
  vLoc = P;
  P += disp * len;
  vec4 w = modelMatrix * vec4(P, 1.0);
  vW = w.xyz;
  mat3 m = mat3(modelMatrix);
  vN = normalize(m * N);
  vT = normalize(m * normalize(C + N * (0.35 - 0.3 * h)));
  vF = F; vH = h;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FUR_FS = /* glsl */`
${COMMON}
uniform vec3 uRoot, uTip, uSpec, uSkin;
uniform float uDensity, uSpecK, uRimK;
uniform vec3 uOccP; uniform float uOccR;   // a sphere that darkens fur (e.g. chin over chest)
varying vec3 vW, vN, vT, vLoc; varying vec2 vUv; varying vec4 vF; varying float vH;

#ifdef TABBY
uniform float uPart; // 0 head, 1 body, 2 tail, 3 paw, 4 ear
float lineD(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
// x: stripe darkness 0..1, y: white amount 0..1
vec2 tabbyMask(vec3 q, vec2 uv){
  float st = 0.0, wh = 0.0, n = vnoise(q.xy * 23.0 + q.z * 7.0);
  if (uPart < 0.5) {
    float ax = abs(q.x);
    float fo = smoothstep(0.06, 0.12, q.y) * smoothstep(0.02, 0.18, q.z + 0.1) * (1.0 - smoothstep(0.17, 0.24, ax));
    float fl = abs(fract((q.x + 0.006 * sin(q.y * 40.0)) * 16.0) - 0.5);
    st = max(st, fo * smoothstep(0.12, 0.05, fl) * smoothstep(0.42, 0.2, q.y + 0.1 * ax) * smoothstep(0.25, 0.5, vnoise(q.xy * vec2(30.0, 9.0))));
    st = max(st, 0.55 * smoothstep(0.011, 0.003, abs(q.y - 0.115 - 2.2 * (ax - 0.1) * (ax - 0.1) + 0.03 * cos(ax * 40.0))) * step(ax, 0.17) * step(0.2, q.z) * smoothstep(0.3, 0.6, vnoise(q.xy * 40.0)));
    float cr = smoothstep(0.25, 0.33, q.y) * (1.0 - smoothstep(0.2, 0.28, ax));
    st = max(st, cr * smoothstep(0.14, 0.04, abs(fract(q.x * 11.0 + 0.5 * n) - 0.5)) * smoothstep(0.3, 0.55, vnoise(q.xz * 14.0)));
    vec2 p2 = vec2(ax, q.y);
    st = max(st, smoothstep(0.022, 0.008, lineD(p2, vec2(0.27, -0.005), vec2(0.40, -0.06))) * step(0.0, q.z + 0.05));
    st = max(st, smoothstep(0.02, 0.007, lineD(p2, vec2(0.25, -0.10), vec2(0.38, -0.16))) * step(0.0, q.z + 0.05));
    float side = smoothstep(0.28, 0.36, ax) * smoothstep(0.05, -0.15, q.z);
    st = max(st, side * smoothstep(0.12, 0.04, abs(fract(q.y * 9.0 + q.z * 4.0 + 0.4 * n) - 0.5)) * 0.85);
    vec2 sp = vec2(ax - 0.045, q.y + 0.205) * vec2(34.0, 50.0);
    float spot = smoothstep(0.32, 0.18, length(fract(sp) - 0.5)) * step(0.03, ax) * step(ax, 0.12) * step(abs(q.y + 0.205), 0.03) * step(0.33, q.z);
    st = max(st, spot * 0.45);
    wh = smoothstep(-0.215, -0.245, q.y + 0.25 * ax * ax) * smoothstep(0.12, 0.26, q.z) * (1.0 - smoothstep(0.12, 0.2, ax));
    wh = max(wh, smoothstep(-0.20, -0.215, q.y) * smoothstep(0.30, 0.36, q.z) * (1.0 - smoothstep(0.05, 0.13, ax)) * 0.85);
    wh = max(wh, smoothstep(-0.30, -0.38, q.y) * smoothstep(-0.1, 0.1, q.z) * 0.6);
    st *= 1.0 - wh;
  } else if (uPart < 1.5) {
    float b = q.x * 9.0 + sin(q.y * 7.0 + q.z * 3.0) * 0.5 + n * 0.6;
    st = smoothstep(0.17, 0.05, abs(fract(b) - 0.5)) * 0.9;
    wh = smoothstep(-0.32, -0.5, q.y) * smoothstep(-0.25, 0.0, q.z) * (1.0 - smoothstep(0.1, 0.25, abs(q.x))) * 0.55;
  } else if (uPart < 2.5) {
    float s = uv.x / 1.6;
    st = smoothstep(0.2, 0.06, abs(fract(s * 6.5 + 0.2 * n) - 0.5)) * smoothstep(0.1, 0.3, s);
    st = max(st, smoothstep(0.86, 0.92, s));
  } else if (uPart < 3.5) {
    st = smoothstep(0.12, 0.04, abs(fract(q.z * 8.0 + q.y * 3.0 + 0.3 * n) - 0.5)) * smoothstep(-0.05, -0.15, q.z) * 0.8;
    wh = 0.25;
  } else {
    st = smoothstep(0.35, 0.47, q.y) + smoothstep(0.03, 0.0, uv.x) + smoothstep(0.38, 0.44, uv.x) * (1.0 - step(0.46, uv.x));
    st = clamp(st, 0.0, 1.0);
  }
  return vec2(st, wh);
}
#endif
float strands(vec2 g, float h, float minLen, float thick, out float rnd){
  vec2 id = floor(g), f = fract(g) - 0.5;
  vec4 r = hash42(id);
  rnd = r.w;
  float L = mix(minLen, 1.0, r.z);
  float x = h / L;
  if (x >= 1.0) return 0.0;
  vec2 c = (r.xy - 0.5) * 0.45;
  float rad = thick * (1.0 - x) * (1.0 - 0.3 * x);
  float d = length(f - c);
  float aa = max(fwidth(g.x), fwidth(g.y)) * 0.7 + 1e-4;
  return clamp((rad - d) / aa + 0.5, 0.0, 1.0);
}

float coverage(vec2 uv, float h, out float rnd){
  vec2 g = uv * uDensity;
  // clumping: strands lean toward clump centres with height
  vec2 cg = g / 5.0, cid = floor(cg);
  vec4 cr = hash42(cid + 17.0);
  vec2 cc = (cid + 0.5 + (cr.xy - 0.5) * 0.5) * 5.0;
  float k = 0.55 * h * cr.z;
  vec2 gr = (g - cc * k) / (1.0 - k);
  float r1, r2;
  float a = strands(gr, h, 0.45, 0.62, r1);                 // guard hairs
  float b = strands(gr * 1.7 + 31.7, h * 1.45, 0.3, 0.6, r2);   // denser, shorter undercoat
  rnd = a > b ? r1 : r2;
  float base = 1.0 - smoothstep(0.0, 0.12, h);
  return max(max(a, b), base);
}

void main(){
  float h = vH, len = vF.x, rnd = 0.5, alpha = 1.0;
#ifdef SHELLS
  if (len < 0.004) discard;
  alpha = coverage(vUv, h, rnd) * smoothstep(0.006, 0.03, len);
  alpha *= mix(0.55, 1.0, smoothstep(0.0, 0.5, abs(dot(normalize(vN), normalize(cameraPosition - vW)))) ) ;
  if (alpha < 0.03) discard;
#else
  coverage(vUv, 0.02, rnd);
#endif
  vec3 N = normalize(vN), T = normalize(vT), V = normalize(cameraPosition - vW);
  if (dot(N, V) < -0.2) N = -N;
  // albedo: dark roots, slightly warmer/lighter tips, per-strand variation
  vec3 alb = mix(uRoot, uTip, smoothstep(0.1, 1.0, h)) * (0.75 + 0.5 * rnd);
#ifdef TABBY
  {
    vec2 m = tabbyMask(vLoc, vUv);
    float band = smoothstep(0.35, 0.55, h) * (1.0 - smoothstep(0.75 + 0.15 * rnd, 0.95, h));
    float hb = max(h, 0.55 * step(h, 0.001));
    band = max(band, step(h, 0.001) * 0.8);
    vec3 ag = mix(vec3(0.085, 0.07, 0.055), vec3(0.25, 0.17, 0.09), band);
    ag = mix(ag, vec3(0.03, 0.024, 0.018), smoothstep(0.85, 1.0, hb) * step(0.4, rnd));
    ag *= 1.0 + 0.35 * smoothstep(0.25, 0.1, length(vLoc.xy - vec2(0.0, -0.09))) * step(uPart, 0.5) * step(0.3, vLoc.z);
    ag *= 0.8 + 0.4 * rnd;
    vec3 dark = vec3(0.016, 0.012, 0.009) * (0.8 + 0.4 * rnd);
    alb = mix(ag, dark, m.x);
    alb = mix(alb, vec3(0.62, 0.58, 0.53) * (0.85 + 0.25 * rnd), m.y);
  }
#endif
  float skin = vF.z, gloss = 0.0;
#ifdef HEAD
  // nose leather: rounded inverted triangle in head space
  vec3 q = vLoc;
  float nt = (q.y + 0.170) / 0.040;
  float nw = mix(0.010, 0.043, clamp(nt, 0.0, 1.0));
  float nose = smoothstep(0.004, -0.002, abs(q.x) - nw) * smoothstep(-0.02, 0.06, nt) * smoothstep(1.12, 0.94, nt) * step(0.33, q.z);
  float pebble = vnoise(q.xy * 900.0);
  alb = mix(alb, uSkin * (0.75 + 0.5 * pebble) * mix(0.3, 1.0, smoothstep(0.0, 0.006, nw - abs(q.x))), nose);
  gloss = nose * 0.8;
  // lip line / mouth: darker
  float lip = smoothstep(0.012, 0.0, abs(q.y + 0.245 + 0.35 * q.x * q.x) ) * step(0.30, q.z) * step(abs(q.x), 0.12);
  alb *= 1.0 - 0.7 * lip;
#endif
#ifdef EAR
  alb = mix(alb, uSkin * (0.8 + 0.4 * vnoise(vUv * 60.0)) * mix(0.35, 1.0, smoothstep(0.0, 0.25, vLoc.y)), skin);
#endif
  float occ = vF.y;
  float self = mix(0.22, 1.0, pow(h, 0.8));
#ifndef SHELLS
  self = mix(0.25, 1.0, skin);
#endif
  // occluder sphere (soft)
  vec3 od = uOccP - vW; float ol = length(od);
  occ *= 1.0 - 0.6 * smoothstep(0.0, 1.0, (uOccR * uOccR) / (ol * ol)) * max(0.0, dot(N, od / ol) * 0.7 + 0.3);
  vec3 col = vec3(0.0);
  // --- key (soft window light)
  {
    vec3 L = uKeyDir; float nl = dot(N, L);
    float wrap = max(0.0, (nl + 0.4) / 1.4);
    float tl = dot(T, L), kd = sqrt(max(0.0, 1.0 - tl * tl));
    float diff = mix(wrap, kd * clamp(nl * 0.6 + 0.5, 0.0, 1.0), 0.4 * (1.0 - skin));
    vec3 H = normalize(L + V);
    float t1 = dot(normalize(T + N * 0.10), H), s1 = pow(sqrt(max(0.0, 1.0 - t1 * t1)), 70.0);
    float t2 = dot(normalize(T - N * 0.12), H), s2 = pow(sqrt(max(0.0, 1.0 - t2 * t2)), 24.0);
    float vis = smoothstep(-0.25, 0.35, nl);
    vec3 spec = uSpec * (s1 * 1.0 + s2 * 0.12) * mix(0.5, 1.0, h) * uSpecK * (1.0 - skin) * (0.35 + 1.3 * rnd * rnd);
    spec += vec3(pow(max(dot(N, H), 0.0), 60.0) * 1.2) * gloss;
    col += uKeyCol * (alb * diff + spec * vis) * occ * self;
  }
  // --- rim / lamp from behind
  {
    vec3 L = uRimDir; float nl = dot(N, L);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    vec3 H = normalize(L + V);
    float t1 = dot(T, H), s1 = pow(sqrt(max(0.0, 1.0 - t1 * t1)), 40.0);
    float back = max(0.0, nl + 0.25) * fres;
    col += uRimCol * (alb * max(nl, 0.0) + uSpec * (s1 * 0.35 * max(nl + 0.2, 0.0) + back * 0.18 * uRimK)) * occ * mix(0.4, 1.0, h);
  }
#ifdef EAR
  // thin ear: light from behind glows through (warm), strongest near the rim
  col += uRimCol * vec3(0.5, 0.16, 0.10) * max(0.0, dot(-N, uRimDir) + 0.3) * (0.1 + 0.9 * smoothstep(0.06, 0.0, vF.w)) * 0.04;
#endif
  // --- ambient
  vec3 amb = mix(uGnd, uSky, N.y * 0.5 + 0.5);
  col += amb * (alb * 1.1 + uSpec * 0.05) * occ * self;
  col *= vignette();
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function furMaterial(L, opts) {
  const u = {
    ...L,
    uRes: opts.res,
    uFurScale: { value: 1 }, uCombK: { value: opts.combK ?? 0.9 },
    uGrav: { value: new THREE.Vector3(0, -0.15, 0) }, uLag: opts.lag || { value: new THREE.Vector3() },
    uRoot: opts.root, uTip: opts.tip, uSpec: opts.spec, uSkin: { value: new THREE.Color(...(opts.skin || [0.02, 0.018, 0.018])) },
    uDensity: { value: opts.density ?? 160 }, uSpecK: { value: opts.specK ?? 1 }, uRimK: { value: 1 },
    uOccP: { value: opts.occP || new THREE.Vector3(0, -100, 0) }, uOccR: { value: opts.occR ?? 0 },
  };
  if (opts.tail) u.uTP = opts.tail;
  const defines = {};
  if (opts.shells) defines.SHELLS = '';
  if (opts.tail) defines.TAIL = '', defines.NJ = opts.nj;
  if (opts.head) defines.HEAD = '';
  if (opts.ear) defines.EAR = '';
  if (opts.tabby) { defines.TABBY = ''; u.uPart = { value: opts.part ?? 0 }; }
  const m = new THREE.ShaderMaterial({ uniforms: u, defines, vertexShader: FUR_VS, fragmentShader: FUR_FS, side: opts.side ?? THREE.FrontSide });
  if (opts.shells) { m.alphaToCoverage = true; }
  return m;
}

// ---------------------------------------------------------------- eye (cornea + refracted iris on one sphere)
const EYE_VS = /* glsl */`
varying vec3 vP, vV, vK, vR, vWN;
uniform vec3 uKeyDir, uRimDir;
void main(){
  vP = normalize(position);
  vec4 w = modelMatrix * vec4(position, 1.0);
  mat3 m = mat3(modelMatrix), mt = transpose(m);
  vV = mt * (cameraPosition - w.xyz);
  vK = mt * uKeyDir; vR = mt * uRimDir;
  vWN = normalize(m * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const EYE_FS = /* glsl */`
${COMMON}
uniform float uPupil, uOpenU, uOpenL, uNasal;
uniform mat3 uBall;
uniform vec3 uIrisA, uIrisB, uIrisC, uIrisRing, uLidA, uLidB;
varying vec3 vP, vV, vK, vR, vWN;
void main(){
  vec3 N = normalize(vP), V = normalize(vV), K = normalize(vK), R = normalize(vR);
  // ---- eyelid opening (almond) in the socket frame, independent of the eyeball rotation
  vec3 G = uBall * N;
  float xx = clamp(G.x / 0.86, -1.0, 1.0), sh = 1.0 - xx * xx;
  float yU = uOpenU * pow(sh, 0.62) - 0.03 * (1.0 - sh), yL = -uOpenL * pow(sh, 0.75) + 0.02 * (1.0 - sh);
  float e = fwidth(G.y) * 1.2 + 0.004;
  float open = smoothstep(yL - e, yL + e, G.y) * smoothstep(yU + e, yU - e, G.y) * step(0.2, G.z);
  // ---- refract into the anterior chamber and hit the iris plane
  vec3 rd = refract(-V, N, 1.0 / 1.336);
  float zi = 0.58;
  float t = (zi - vP.z) / min(rd.z, -0.05);
  vec3 Q = vP + rd * max(t, 0.0);
  vec2 q = Q.xy / 0.80;
  float r = length(q), a = atan(q.y, q.x);
  float pw = mix(0.06, 0.56, uPupil), ph = mix(0.82, 0.72, uPupil);
  float pe = length(vec2(q.x / pw, q.y / ph));
  float aa = fwidth(pe) * 1.2 + 0.01;
  float pupil = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, pe);
  float fib = 0.0;
  fib += (vnoise(vec2(a * 24.0, r * 3.0)) - 0.5) * 0.55;
  fib += (vnoise(vec2(a * 70.0, r * 7.0 + 3.0)) - 0.5) * 0.45;
  fib += (vnoise(vec2(a * 160.0, r * 2.0 + 9.0)) - 0.5) * 0.3;
  float crypt = smoothstep(0.55, 0.85, vnoise(vec2(a * 11.0, r * 9.0)));
  float ip = clamp((pe - 1.0) / 2.2, 0.0, 1.0);
  vec3 iris = mix(uIrisA, uIrisB, smoothstep(0.0, 0.55, ip));
  iris = mix(iris, uIrisC, smoothstep(0.62, 0.95, r));
  iris = mix(iris, uIrisRing, smoothstep(0.92, 1.0, r));
  iris *= 1.0 + fib * 0.9 - crypt * 0.25;
  iris *= 0.75 + 0.35 * smoothstep(0.0, 0.10, ip);
  float caust = 0.55 + 0.9 * smoothstep(-0.3, 0.7, dot(normalize(q + 1e-4), -normalize(K.xy + 1e-4)) * r);
  // shadow of the upper lid / brow on the iris
  float lidSh = mix(0.28, 1.0, smoothstep(0.02, 0.32, yU - G.y)) * mix(0.6, 1.0, smoothstep(0.0, 0.12, G.y - yL));
  vec3 amb = mix(uGnd, uSky, 0.6);
  vec3 lit = uKeyCol * (0.35 + 0.65 * max(dot(vec3(0, 0, 1), K), 0.0)) * caust * 0.32 + amb * 0.9 + uRimCol * 0.06;
  vec3 col = iris * lit * lidSh;
  col = mix(col, vec3(0.002), pupil);
  float corn = smoothstep(0.60, 0.66, vP.z);
  vec3 scl = vec3(0.035, 0.028, 0.022) * (0.6 + 0.4 * max(dot(N, K), 0.0));
  float nas = smoothstep(0.45, 0.8, G.x * uNasal);
  scl = mix(scl, vec3(0.11, 0.085, 0.08), nas * 0.8);
  col = mix(scl * lidSh, col, corn);
  vec3 rf = reflect(-V, N);
  vec3 kx = normalize(cross(K, vec3(0, 1, 0))), ky = cross(kx, K);
  vec2 wv = vec2(dot(rf, kx), dot(rf, ky)) / max(dot(rf, K), 0.05);
  float win = smoothstep(0.17, 0.12, abs(wv.x)) * smoothstep(0.21, 0.15, abs(wv.y + 0.02)) * step(0.0, dot(rf, K));
  float bars = 1.0 - 0.75 * (smoothstep(0.012, 0.0, abs(wv.x)) + smoothstep(0.012, 0.0, abs(wv.y + 0.03)));
  float glint = smoothstep(0.985, 0.996, dot(rf, R));
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 env = mix(uGnd, uSky, rf.y * 0.5 + 0.5) * 0.5;
  col += (env * fres * 0.6 + uKeyCol * win * bars * 0.32 + uRimCol * glint * 1.2) * mix(0.25, 1.0, lidSh);
  // ---- lid: short dark fur over a dome, black margin, wet lower rim
  float dU = G.y - yU, dL = yL - G.y;
  float ang = atan(G.y, G.x), rr = length(G.xy);
  float fz = vnoise(vec2(ang * 70.0, rr * 9.0)) * 0.65 + vnoise(vec2(ang * 23.0 + 5.0, rr * 30.0)) * 0.35;
  vec3 lalb = mix(uLidA, uLidB, smoothstep(0.02, 0.2, max(dU, dL))) * (0.6 + 0.8 * fz);
  float nl = dot(N, K);
  vec3 H = normalize(K + V);
  vec3 lid = lalb * (uKeyCol * max(0.0, (nl + 0.3) / 1.3) + amb * 1.2) + uKeyCol * 0.035 * fz * pow(max(dot(N, H), 0.0), 10.0) * smoothstep(0.03, 0.12, max(dU, dL));
  lid *= mix(0.25, 1.0, smoothstep(0.0, 0.05, max(dU, dL)));                 // dark lid margin
  lid *= mix(0.35, 1.0, smoothstep(0.45, 0.8, G.z));                          // tucked into the face
  float wet = smoothstep(0.03, 0.0, abs(dL - 0.012)) * step(abs(G.x), 0.8);
  lid += uKeyCol * wet * 0.05 * (0.4 + pow(max(dot(N, H), 0.0), 8.0));
  col = mix(lid, col, open);
  col *= vignette();
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
export function eyeMaterial(L, res, colors, nasal) {
  return new THREE.ShaderMaterial({
    uniforms: { ...L, uRes: res, uPupil: { value: 0.4 }, uOpenU: { value: 0.6 }, uOpenL: { value: 0.5 }, uNasal: { value: nasal }, uBall: { value: new THREE.Matrix3() }, uLidA: { value: new THREE.Color(0.004, 0.0038, 0.0036) }, uLidB: { value: new THREE.Color(0.011, 0.0095, 0.0085) },
      uIrisA: { value: new THREE.Color(...colors[0]) }, uIrisB: { value: new THREE.Color(...colors[1]) }, uIrisC: { value: new THREE.Color(...colors[2]) }, uIrisRing: { value: new THREE.Color(...colors[3]) } },
    vertexShader: EYE_VS, fragmentShader: EYE_FS,
  });
}

// ---------------------------------------------------------------- strands: whiskers, ear hairs, stray guard hairs
const STRAND_VS = /* glsl */`
#define IS_VS
${COMMON}
attribute vec3 root, dir, curl; attribute vec4 sp; attribute vec4 col; // sp: s, side, length, width
uniform float uSway, uSwayAmp;
varying vec4 vCol; varying float vSide, vS, vAl; varying vec3 vT, vW;
void main(){
  float s = sp.x, L = sp.z;
  float ph = col.a * 37.0 + root.x * 13.0;
  vec3 sw = vec3(0.0, sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 0.37 + ph * 2.1), cos(uTime * 0.9 + ph) * 0.5) * uSwayAmp + vec3(0.0, uSway, 0.0);
  vec3 p = root + dir * (s * L) + (curl + sw) * (s * s * L);
  vec3 tg = normalize(dir * L + (curl + sw) * (2.0 * s * L));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 tv = normalize(mat3(modelViewMatrix) * tg);
  vec3 sd = normalize(cross(tv, normalize(-mv.xyz)));
  float w = sp.w * (1.0 - 0.9 * s);
  float pxu = projectionMatrix[1][1] * uRes.y * 0.5 / max(-mv.z, 0.01);
  float wpx = w * pxu;
  vAl = clamp(wpx / 1.1, 0.0, 1.0);
  w = max(w, 1.1 / pxu);
  mv.xyz += sd * sp.y * w * 0.5;
  vCol = col; vSide = sp.y; vS = s;
  vT = normalize(mat3(modelMatrix) * tg);
  vW = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}`;
const STRAND_FS = /* glsl */`
${COMMON}
uniform float uOpacity;
varying vec4 vCol; varying float vSide, vS, vAl; varying vec3 vT, vW;
void main(){
  vec3 T = normalize(vT), V = normalize(cameraPosition - vW);
  float a = vAl * (1.0 - smoothstep(0.75, 1.0, vS)) * (1.0 - abs(vSide) * 0.35) * uOpacity;
  vec3 c = vCol.rgb;
  float tl = dot(T, uKeyDir), kd = sqrt(max(0.0, 1.0 - tl * tl));
  vec3 H = normalize(uKeyDir + V); float th = dot(T, H), sp = pow(sqrt(max(0.0, 1.0 - th * th)), 60.0);
  vec3 Hr = normalize(uRimDir + V); float tr = dot(T, Hr), spr = pow(sqrt(max(0.0, 1.0 - tr * tr)), 30.0);
  vec3 col = c * (uKeyCol * kd * 0.55 + mix(uGnd, uSky, 0.6) * 1.2) + uKeyCol * sp * 0.35 * (0.3 + c.r) + uRimCol * spr * 0.4;
  col *= vignette();
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
export function strandMaterial(L, res) {
  return new THREE.ShaderMaterial({ uniforms: { ...L, uRes: res, uSway: { value: 0 }, uSwayAmp: { value: 0.012 }, uOpacity: { value: 1 } }, vertexShader: STRAND_VS, fragmentShader: STRAND_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
}

// ---------------------------------------------------------------- knitted blanket
const KNIT_VS = /* glsl */`
uniform sampler2D uNrm; uniform vec2 uRep; uniform float uDisp;
attribute vec3 tang;
#ifdef FUZZ
attribute float shell;
#endif
varying vec3 vW, vN, vTg; varying vec2 vUv; varying float vH;
void main(){
  vUv = uv * uRep;
  vUv += vec2(0.035 * sin(vUv.y * 2.1 + 1.3 * sin(vUv.x * 0.7)) + 0.02 * sin(vUv.y * 5.3 + vUv.x), 0.03 * sin(vUv.x * 1.7 + 0.5));
  float h = textureLod(uNrm, vUv, 2.0).a;
  vH = 0.0;
#ifdef FUZZ
  vH = shell;
  h = textureLod(uNrm, vUv, 1.0).a + shell * 0.35;
#endif
  vec3 p = position + normal * (h - 0.5) * uDisp;
  vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal); vTg = normalize(mat3(modelMatrix) * tang);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const KNIT_FS = /* glsl */`
${COMMON}
uniform sampler2D uNrm, uAlb; uniform vec3 uYarn, uYarn2;
uniform vec4 uOcc[4]; uniform vec4 uSh[3];
varying vec3 vW, vN, vTg; varying vec2 vUv; varying float vH;
void main(){
  vec4 nh = texture2D(uNrm, vUv);
  float alpha = 1.0;
#ifdef FUZZ
  // loose wool fibres: thin random arcs over the yarn
  vec2 fg = vUv * vec2(260.0, 230.0);
  float f1 = vnoise(fg + vec2(vnoise(fg * 0.13) * 6.0, 0.0));
  float f2 = vnoise(fg.yx * 1.3 + 17.0);
  alpha = smoothstep(0.66, 0.80, max(f1, f2)) * (1.0 - vH) * smoothstep(0.25, 0.6, nh.a);
  if (alpha < 0.04) discard;
#endif
  vec3 tn = nh.xyz * 2.0 - 1.0;
  vec3 N0 = normalize(vN), Tg = normalize(vTg), Bt = normalize(cross(N0, Tg));
  vec3 N = normalize(Tg * tn.x + Bt * tn.y + N0 * tn.z * 0.8);
  float a = texture2D(uAlb, vUv).r;
  float heather = vnoise(vUv * 38.0) * 0.5 + vnoise(vUv * 97.0) * 0.5;
  vec3 alb = mix(uYarn, uYarn2, heather) * a * 1.15;
  vec3 V = normalize(cameraPosition - vW);
  // soft occlusion from the cat (spheres) + key-light shadow from head/paw
  float occ = 1.0;
  for (int i = 0; i < 4; i++) { vec3 d = uOcc[i].xyz - vW; float l = length(d); float r = uOcc[i].w;
    occ *= 1.0 - clamp((r * r) / (l * l), 0.0, 1.0) * clamp(dot(N0, d / l) * 0.8 + 0.25, 0.0, 1.0) * 0.85; }
  float sh = 1.0;
  for (int i = 0; i < 3; i++) { vec3 d = uSh[i].xyz - vW; float along = dot(d, uKeyDir); vec3 perp = d - uKeyDir * along;
    float pr = length(perp); sh *= 1.0 - step(0.0, along) * 0.75 * smoothstep(uSh[i].w * 1.35, uSh[i].w * 0.55, pr); }
  float nl = dot(N, uKeyDir);
  float diff = max(0.0, (nl + 0.25) / 1.25);
  float hgt = nh.a;
  vec3 col = uKeyCol * alb * diff * sh * (0.55 + 0.45 * hgt);
  vec3 H = normalize(uKeyDir + V);
  col += uKeyCol * 0.035 * pow(max(dot(N, H), 0.0), 8.0) * sh * hgt;
  // wool fuzz: bright at grazing angles
  float fz = pow(1.0 - max(dot(N0, V), 0.0), 3.0);
  col += (uKeyCol * max(dot(N0, uKeyDir), 0.0) * sh + uRimCol * 0.15) * alb * fz * 0.6;
  col += uRimCol * alb * max(dot(N, uRimDir), 0.0) * 0.2;
  col += mix(uGnd, uSky, N.y * 0.5 + 0.5) * alb * (0.5 + 0.5 * hgt);
  col *= occ * vignette() * mix(0.45, 1.0, smoothstep(-1.05, -0.5, vW.y));
#ifdef FUZZ
  col *= 1.15;
#endif
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
export function knitMaterial(L, res, tex, rep, disp, occ, sh, fuzz) {
  return new THREE.ShaderMaterial({ defines: fuzz ? { FUZZ: '' } : {}, alphaToCoverage: !!fuzz,
    uniforms: { ...L, uRes: res, uNrm: { value: tex.normal }, uAlb: { value: tex.albedo }, uRep: { value: rep }, uDisp: { value: disp },
      uYarn: { value: new THREE.Color(0.068, 0.078, 0.092) }, uYarn2: { value: new THREE.Color(0.10, 0.112, 0.13) }, uOcc: { value: occ }, uSh: { value: sh } },
    vertexShader: KNIT_VS, fragmentShader: KNIT_FS,
  });
}

// ---------------------------------------------------------------- backdrop (pre-blurred room, lamp layer with gain)
const BG_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BG_FS = /* glsl */`
${COMMON}
uniform sampler2D uRoom, uLamp; uniform vec3 uWall; uniform float uLampK;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(uRoom, vUv).rgb * uWall + texture2D(uLamp, vUv).rgb * uLampK;
  c *= vignette();
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;
export function backdropMaterial(L, res, tex) {
  return new THREE.ShaderMaterial({ uniforms: { ...L, uRes: res, uRoom: { value: tex.room }, uLamp: { value: tex.lamp }, uWall: { value: new THREE.Color(1, 1, 1) }, uLampK: { value: 1 } }, vertexShader: BG_VS, fragmentShader: BG_FS, depthWrite: false, toneMapped: false });
}

// ---------------------------------------------------------------- claws / small glossy bits
const SIMPLE_VS = /* glsl */`varying vec3 vW, vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const SIMPLE_FS = /* glsl */`
${COMMON}
uniform vec3 uCol; uniform float uGloss;
varying vec3 vW, vN;
void main(){
  vec3 N = normalize(vN), V = normalize(cameraPosition - vW), H = normalize(uKeyDir + V);
  float nl = dot(N, uKeyDir);
  vec3 col = uCol * (uKeyCol * max(0.0, (nl + 0.5) / 1.5) + mix(uGnd, uSky, 0.6)) + uKeyCol * uGloss * pow(max(dot(N, H), 0.0), 40.0);
  col += uCol * uRimCol * pow(1.0 - max(dot(N, V), 0.0), 2.0) * 0.8;
  col *= vignette();
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
export function simpleMaterial(L, res, col, gloss) {
  return new THREE.ShaderMaterial({ uniforms: { ...L, uRes: res, uCol: { value: new THREE.Color(...col) }, uGloss: { value: gloss } }, vertexShader: SIMPLE_VS, fragmentShader: SIMPLE_FS });
}
