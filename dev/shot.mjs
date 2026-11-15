// 無頭 Chrome 截圖(自帶靜態伺服器、隨機埠、硬性逾時、結束必清 Chrome)。
//   node dev/shot.mjs <out.png> "<相對 tv-home 的路徑?查詢>" [--timeout 60000] [--wait 0] [--w 1920] [--h 1080] [--ready "<js 運算式>"]
//   例: node dev/shot.mjs dev/shots/pixar/a.png "dev/cat.html?style=pixar&t=3&ui=1"
// 預設等到 window.__cat.ready 或 window.__cat.err;印出 __cat 的 JSON 與 console 錯誤。結束碼 0 成功、1 頁面錯誤、2 逾時。
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFile, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const [out, page] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
if (!out || !page) { console.error('usage: node dev/shot.mjs <out.png> "<path?query>" [--timeout ms] [--wait ms] [--w px] [--h px] [--ready expr]'); process.exit(64); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = +opt('timeout', 60000), WAIT = +opt('wait', 0), W = +opt('w', 1920), H = +opt('h', 1080);
const READY = opt('ready', 'window.__cat && (window.__cat.ready || window.__cat.err) ? JSON.stringify(window.__cat) : ""');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.hdr': 'application/octet-stream', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

let chrome = null, profile = null, server = null, done = false;
function cleanup() {
  if (done) return; done = true;
  try { if (chrome?.pid) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { server?.close(); } catch {}
  try { if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
process.on('exit', cleanup);
const killer = setTimeout(() => { console.error(`[shot] TIMEOUT after ${TIMEOUT} ms: ${page}`); cleanup(); process.exit(2); }, TIMEOUT);
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  server = http.createServer((req, res) => {
    const p = normalize(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    readFile(p, (e, buf) => { if (e) { res.writeHead(404).end('not found'); return; } res.writeHead(200, { 'content-type': MIME[extname(p).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(buf); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/${page.replace(/^\//, '')}`;
  const port = 9800 + Math.floor(Math.random() * 1500); profile = mkdtempSync(join(tmpdir(), 'tvh-'));
  chrome = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-angle=d3d11', '--ignore-gpu-blocklist', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=1', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 75 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x => x.type === 'page'); } catch {} }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('devtools socket failed')); });
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push('[' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 400));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  let state = '';
  for (;;) { await sleep(250); const r = await send('Runtime.evaluate', { expression: READY, returnByValue: true }); state = r.result?.result?.value || ''; if (state) break; }
  if (WAIT) await sleep(WAIT);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  ws.close(); clearTimeout(killer);
  console.log(state); if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  let bad = false; try { bad = !!JSON.parse(state).err; } catch {}
  cleanup(); process.exit(bad ? 1 : 0);
} catch (e) { clearTimeout(killer); console.error('[shot] ' + (e?.stack || e)); cleanup(); process.exit(1); }
