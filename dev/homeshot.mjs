// Drive the TV home page in headless Chrome against the bridge in --mock mode (starts and always stops both).
//   node dev/homeshot.mjs [--w 1920] [--h 1080] [--timeout 90000] [--path "/"] [--url <absolute url>] [--no-bridge] [--bridge-port N] step ...
// Steps (in order):
//   wait:<ms>            sleep
//   key:<Name>[*n]       ArrowUp/Down/Left/Right, Enter, Escape, Backspace, Back (keyCode 461)
//   until:<js expr>      poll (≤20 s) until truthy
//   eval:<js expr>       print the JSON value
//   click:<css selector> mouse click at the element centre (Magic Remote pointer)
//   type:<text>          insert text into the focused element (like the LG keyboard / dictation)
//   shot:<out.png>       screenshot
// Prints window.__home at the end, console errors/warnings, and the bridge log tail. Exit 0 ok, 1 error, 2 timeout.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const args = process.argv.slice(2);
const flags = {}, steps = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); if (['no-bridge'].includes(k)) flags[k] = true; else flags[k] = args[++i]; } else steps.push(args[i]);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const W = +(flags.w || 1920), H = +(flags.h || 1080), TIMEOUT = +(flags.timeout || 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let chrome = null, bridge = null, profile = null, done = false, blog = '';
function cleanup() {
  if (done) return; done = true;
  for (const p of [chrome, bridge]) { try { if (p?.pid) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  try { if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
process.on('exit', cleanup);
const killer = setTimeout(() => { console.error(`[homeshot] TIMEOUT after ${TIMEOUT} ms`); cleanup(); process.exit(2); }, TIMEOUT);

const KEYS = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Backspace: 8, Back: 461, Red: 403, Green: 404, Yellow: 405, Blue: 406 };

try {
  let base = '';
  if (!flags['no-bridge']) {
    const bp = +(flags['bridge-port'] || await freePort());
    bridge = spawn('python', [join(ROOT, 'bridge', 'server.py'), '--mock', '--host', '127.0.0.1', '--port', String(bp)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HA_TOKEN: '', PYTHONIOENCODING: 'utf-8' } });
    bridge.stdout.on('data', (d) => { blog += d; }); bridge.stderr.on('data', (d) => { blog += d; });
    base = `http://127.0.0.1:${bp}`;
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(200); try { up = (await fetch(base + '/api/health')).ok; } catch {} }
    if (!up) throw new Error('bridge did not start:\n' + blog);
  }
  const url = flags.url || base + (flags.path || '/');
  const port = 9800 + Math.floor(Math.random() * 1500); profile = mkdtempSync(join(tmpdir(), 'tvh-home-'));
  chrome = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-angle=d3d11', '--ignore-gpu-blocklist', '--hide-scrollbars', '--no-first-run', '--allow-file-access-from-files', '--force-device-scale-factor=1', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 75 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); } catch {} }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('devtools socket failed')); });
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'log'].includes(m.params.type)) logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('[net] ' + m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url || ''));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) { await sleep(250); if (await ev('!!(window.__home && (window.__home.ready || window.__home.err)) || !!window.__boot')) break; }
  for (const s of steps) {
    const c = s.indexOf(':'), op = s.slice(0, c), arg = s.slice(c + 1);
    if (op === 'wait') await sleep(+arg);
    else if (op === 'key') {
      const [name, n] = arg.split('*'); const code = KEYS[name];
      for (let i = 0; i < (+n || 1); i++) {
        for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: name === 'Back' ? 'GoBack' : name, code: name === 'Back' ? '' : name });
        await sleep(120);
      }
    } else if (op === 'until') {
      let okv = false; for (let i = 0; i < 80 && !okv; i++) { okv = !!(await ev(arg)); if (!okv) await sleep(250); }
      console.log(`until ${arg} -> ${okv}`);
    } else if (op === 'eval') console.log(`eval ${arg} -> ${JSON.stringify(await ev(arg))}`);
    else if (op === 'click') {
      const r = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(arg)});if(!e)return null;const b=e.getBoundingClientRect();return [b.left+b.width/2,b.top+b.height/2]})()`);
      if (!r) console.log('click: no element ' + arg);
      else for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 });
    } else if (op === 'type') {
      await send('Input.insertText', { text: arg });
    } else if (op === 'shot') {
      mkdirSync(dirname(resolve(arg)), { recursive: true });
      writeFileSync(arg, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
      console.log('shot ' + arg);
    } else console.log('unknown step ' + s);
  }
  const state = await ev('JSON.stringify(window.__home || window.__boot || null)');
  ws.close(); clearTimeout(killer);
  console.log('__home ' + state);
  if (logs.length) console.log(logs.slice(0, 30).join('\n'));
  if (blog) console.log('--- bridge log (tail)\n' + blog.split('\n').slice(-12).join('\n'));
  let bad = false; try { bad = !!JSON.parse(state)?.err; } catch {}
  cleanup(); process.exit(bad ? 1 : 0);
} catch (e) { clearTimeout(killer); console.error('[homeshot] ' + (e?.stack || e)); if (blog) console.error(blog); cleanup(); process.exit(1); }
