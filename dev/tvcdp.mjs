// Talk to the tv-home page running on the TV via its web inspector (Developer Mode, port 9998).
//   node dev/tvcdp.mjs eval "<js>"         print value
//   node dev/tvcdp.mjs shot <out.png>      screenshot of the page
//   node dev/tvcdp.mjs key <Name> [n]      send a key (ArrowLeft, Enter, ..., Back, Red/Green/Yellow/Blue)
//   node dev/tvcdp.mjs evalp "<js promise>" wait for a promise by polling (old TVs: Chrome 53 inspector has no awaitPromise)
// env TV_IP (the TV's LAN IP, default 192.168.1.50), TV_PAGE (regex for the page url, default tvhome|879\d)
import { writeFileSync } from 'node:fs';
const TV = process.env.TV_IP || '192.168.1.50';
const [cmd, a1, a2] = process.argv.slice(2);
const list = await (await fetch(`http://${TV}:9998/json`)).json();
const pg = list.find((x) => x.type === 'page' && new RegExp(process.env.TV_PAGE || 'tvhome|879[0-9]').test((x.description || '') + x.url));
if (!pg) { console.error('page not found', list.map((x) => x.url)); process.exit(1); }
const ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const t = setTimeout(() => { console.error('timeout'); process.exit(2); }, 60000);
if (cmd === 'eval') { const r = await send('Runtime.evaluate', { expression: a1, returnByValue: true, awaitPromise: true }); console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 1)); }
else if (cmd === 'evalp') {
  await send('Runtime.evaluate', { expression: `window.__cdpR=undefined;Promise.resolve(${a1}).then(function(v){window.__cdpR={v:v}},function(e){window.__cdpR={e:String(e)}});1` });
  let v; for (let i = 0; i < 100 && !v; i++) { await new Promise((r) => setTimeout(r, 300)); v = (await send('Runtime.evaluate', { expression: 'window.__cdpR', returnByValue: true })).result?.result?.value; }
  console.log(JSON.stringify(v, null, 1));
}
else if (cmd === 'shot') { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(a1, Buffer.from(r.result.data, 'base64')); console.log('saved', a1); }
else if (cmd === 'key') { const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Back: 461, Red: 403, Green: 404, Yellow: 405, Blue: 406 }; for (let i = 0; i < (+a2 || 1); i++) { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: a1, code: a1, windowsVirtualKeyCode: codes[a1] || 0 }); await new Promise((r) => setTimeout(r, 250)); } console.log('sent', a1); }
clearTimeout(t); ws.close(); process.exit(0);
