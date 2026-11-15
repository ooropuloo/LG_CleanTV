// Render living-image scenes to seamless loop videos for old TVs (no WebGL2): cats/video/<scene>.mp4 + <scene>.jpg
// (poster = exactly the first frame) and register them in cats/video/index.json (read by web/legacy/videocat.js).
// The MP4 is *fragmented* (moof per 2 s GOP): the page loops it endlessly through MediaSource (webOS 4.4 freezes ~1.5 s
// at a native <video loop> restart); fragmented MP4 also plays as a normal progressive file.
//   node dev/record_loop.mjs [sceneId ...] [--w 1920] [--h 1080] [--fps 30] [--crf 24] [--maxrate 3M] [--fade 1.5]
//                            [--lmin 24] [--lmax 36] [--t0 3] [--preset slow] [--timeout 900000]
// No scene ids = every scene in bridge/config.json. One headless Chrome (killed at the end) + ffmpeg (libx264 main 4.0).
// Loop: dev/record.html simulates with a fixed step, picks the loop length L in [lmin, lmax] whose last `fade` seconds
// best match the first ones, and crossfades A[L..L+F) into A[0..F) -> the video wraps without a jump.
// The video has no gaze tracking (the cat looks around by itself), the hour/mood are baked per scene (HOUR below).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readFile, mkdirSync, statSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flags = {}, ids = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i]; else ids.push(args[i]); }
const W = +(flags.w || 1920), H = +(flags.h || 1080), FPS = +(flags.fps || 30), CRF = flags.crf || '24', MAXRATE = flags.maxrate || '3M';
const FADE = Math.round((+flags.fade || 1.5) * FPS), LMIN = +(flags.lmin || 24), LMAX = +(flags.lmax || 36), T0 = +(flags.t0 || 3);
const PRESET = flags.preset || 'slow', TIMEOUT = +(flags.timeout || 900000);
// baked time of day per scene (matches when the schedule shows it); sleeping scenes get mood sleepy
const HOUR = { 'pixar-tabby': 14, 'pixar-black': 14, 'real-tabby': 20, 'real-black': 20, 'tabby-play': 9, 'tabby-sleep': 1, 'heroine-morning': 9, 'heroine-evening': 21 };
const MOOD = { 'tabby-sleep': 'sleepy' };

const CFG = existsSync(join(ROOT, 'bridge', 'config.json')) ? join(ROOT, 'bridge', 'config.json') : join(ROOT, 'bridge', 'config.example.json');
const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const scenes = (cfg.scenes || []).filter((s) => !ids.length || ids.includes(s.id));
if (!scenes.length) { console.error('no scenes match', ids); process.exit(64); }
const OUTDIR = join(ROOT, 'cats', 'video'); mkdirSync(OUTDIR, { recursive: true });
const MAN = join(OUTDIR, 'index.json');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.bin': 'application/octet-stream' };
let chrome = null, profile = null, server = null, done = false;
function cleanup() {
  if (done) return; done = true;
  try { if (chrome?.pid) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { server?.close(); } catch {}
  try { if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
process.on('exit', cleanup);
const killer = setTimeout(() => { console.error(`[rec] TIMEOUT after ${TIMEOUT} ms`); cleanup(); process.exit(2); }, TIMEOUT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffmpegEncode(out) {
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', PRESET, '-profile:v', 'main', '-level', '4.0',
    '-crf', CRF, '-maxrate', MAXRATE, '-bufsize', String(parseFloat(MAXRATE) * 2) + 'M', '-g', String(FPS * 2), '-pix_fmt', 'yuv420p',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-an', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise((r, j) => ff.on('close', (c) => (c === 0 ? r() : j(new Error('ffmpeg exit ' + c)))));
  return { write: (buf) => new Promise((r) => { if (!ff.stdin.write(buf)) ff.stdin.once('drain', r); else r(); }), end: () => { ff.stdin.end(); return finished; } };
}

try {
  server = http.createServer((req, res) => {
    const p = normalize(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    readFile(p, (e, buf) => { if (e) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-type': MIME[extname(p).toLowerCase()] || 'application/octet-stream' }).end(buf); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = 9800 + Math.floor(Math.random() * 1500); profile = mkdtempSync(join(tmpdir(), 'tvh-rec-'));
  chrome = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-angle=d3d11', '--ignore-gpu-blocklist', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=1', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 75 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); } catch {} }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('devtools socket failed')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const open = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 240; i++) { await sleep(250); const s = await ev('window.__rec ? (window.__rec.ready ? "ok" : (window.__rec.err || "")) : ""'); if (s === 'ok') return; if (s) throw new Error(s); }
    throw new Error('record page not ready');
  };

  const man = existsSync(MAN) ? JSON.parse(readFileSync(MAN, 'utf8')) : { scenes: {} };
  for (const sc of scenes) {
    const t1 = Date.now();
    const hour = HOUR[sc.id] != null ? HOUR[sc.id] : 14, mood = MOOD[sc.id] || 'awake';
    const url = `${base}/dev/record.html?style=${sc.style}&coat=${sc.coat || 'black'}&seed=1&hour=${hour}&mood=${mood}&w=${W}&h=${H}&fps=${FPS}`;
    await open(url);
    const plan = await ev(`JSON.stringify(__rec.plan({t0:${T0},F:${FADE},Lmin:${LMIN},Lmax:${LMAX}}))`).then(JSON.parse);
    console.log(`[rec] ${sc.id}: loop ${plan.seconds}s (${plan.L} frames), seam cost ${plan.cost} (motion 1s: ${plan.selfDiff})`);
    await open(url); // fresh simulation (deterministic)
    await ev(`__rec.begin({t0:${T0},F:${FADE},L:${plan.L}})`);
    const mp4 = join(OUTDIR, `${sc.id}.mp4`), tmp = join(OUTDIR, `.${sc.id}.tmp.mp4`), enc = ffmpegEncode(tmp); // a server may be serving the old file
    let n = 0;
    while (await ev('__rec.next()')) {
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94, captureBeyondViewport: false });
      await enc.write(Buffer.from(shot.result.data, 'base64')); n++;
      if (n % 150 === 0) process.stdout.write(`  ${n}/${plan.L}\r`);
    }
    await enc.end();
    renameSync(tmp, mp4);
    const poster = join(OUTDIR, `${sc.id}.jpg`);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-frames:v', '1', '-q:v', '4', poster]);
    const bytes = statSync(mp4).size, secs = n / FPS;
    man.scenes[sc.id] = { style: sc.style, coat: sc.coat || 'black', mp4: `${sc.id}.mp4`, poster: `${sc.id}.jpg`, w: W, h: H, fps: FPS, seconds: +secs.toFixed(2),
      kbps: Math.round(bytes * 8 / secs / 1000), bytes, codec: 'avc1.4d4028', fragmented: true, hour, mood, seam: plan.cost, made: new Date().toISOString().slice(0, 19) };
    writeFileSync(MAN, JSON.stringify(man, null, 1) + '\n');
    console.log(`[rec] ${sc.id}: ${n} frames, ${(bytes / 1048576).toFixed(1)} MB, ${man.scenes[sc.id].kbps} kbps, ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  }
  ws.close(); clearTimeout(killer); cleanup(); process.exit(0);
} catch (e) { clearTimeout(killer); console.error('[rec] ' + (e?.stack || e)); cleanup(); process.exit(1); }
