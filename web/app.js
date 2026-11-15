// tv-home: the TV home page. Talks only to the bridge (same origin): /api/config, /api/events (SSE),
// /api/call, /api/snapshot/<cam>, /api/launch. The HA token never reaches this page.
import { Nav } from './nav.js';
import { icon, appIcon } from './icons.js';
import { launch, isTV } from './launch.js';
import { createAssist } from './assist.js';
import { sceneList, scheduled, randomActive, randomPlan, genPick, fmt as fmtHM } from './wallpaper.js';

const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const H = (window.__home = { ready: false, err: null, launches: [], toasts: [], calls: [] });
const ui = $('#ui');

// ---------------------------------------------------------------- scale 1920x1080 to the viewport
function scale() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  const x = (innerWidth - 1920 * s) / 2, y = (innerHeight - 1080 * s) / 2;
  ui.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  // 貓畫面跟 UI 用同一個 16:9 框(手機直拿、非 16:9 螢幕時上下或左右留黑邊,不會被放大裁切)
  const st = document.getElementById('stage');
  if (st) Object.assign(st.style, { left: x + 'px', top: y + 'px', width: 1920 * s + 'px', height: 1080 * s + 'px', right: 'auto', bottom: 'auto' });
}
scale();
addEventListener('resize', () => { scale(); if (cat) cat.resize(); });

// ---------------------------------------------------------------- storage (may throw on TV / private)
const store = {
  get(k, d) { try { const v = localStorage.getItem('tvhome.' + k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tvhome.' + k, v); } catch (e) { /* ignore */ } },
};

// ---------------------------------------------------------------- helpers
const DASH = '—';
const BAD = new Set(['unavailable', 'unknown', '', null, undefined]);
let states = {}, cfg = null, connected = false, haConnected = false;
const st = (id) => (id && states[id]) || null;
const ok = (s) => s && !BAD.has(s.s);
const num = (v, d = 1) => { const n = parseFloat(v); return isFinite(n) ? n.toFixed(d).replace(/\.0$/, '') : DASH; };
const name = (id, fallback) => (cfg && cfg.names && cfg.names[id]) || fallback || id;
const can = (id, svc) => !!(cfg && cfg.services && (cfg.services[id] || []).indexOf(svc) >= 0);
function setText(el, text, cls) {
  if (el.textContent !== text) el.textContent = text;
  if (cls !== undefined && el.dataset.cls !== cls) { if (el.dataset.cls) el.classList.remove(el.dataset.cls); if (cls) el.classList.add(cls); el.dataset.cls = cls; }
}

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false; H.toasts.push(msg); H.lastToast = msg;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- clock (once a minute)
const WD = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
// ?time=2026-11-15T21:30 freezes the clock; tests can move it with __home.setTime(iso) (schedule switching).
let fakeTime = qs.has('time') ? new Date(qs.get('time')) : null;
const now = () => (fakeTime ? new Date(fakeTime) : new Date());
H.setTime = (iso) => { fakeTime = new Date(iso); tick(); return fmtHM(fakeTime); };
let tickTimer;
function tick() {
  clearTimeout(tickTimer);
  const d = now();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  setText($('#clock'), `${hh}:${mm}`);
  setText($('#date'), `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WD[d.getDay()]}`);
  const h = d.getHours() + d.getMinutes() / 60;
  catCall('setHour', h);
  updateMood(h);
  wallTick();
  if (!fakeTime) tickTimer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
}

// ---------------------------------------------------------------- rendering of states
const WX = {
  'clear-night': ['moon', '晴朗'], cloudy: ['cloud', '多雲'], fog: ['fog', '有霧'], hail: ['storm', '冰雹'], lightning: ['storm', '打雷'],
  'lightning-rainy': ['storm', '雷雨'], partlycloudy: ['cloud', '晴時多雲'], pouring: ['rain', '大雨'], rainy: ['rain', '下雨'],
  snowy: ['snow', '下雪'], 'snowy-rainy': ['snow', '雨夾雪'], sunny: ['sun', '晴天'], windy: ['cloud', '風大'], 'windy-variant': ['cloud', '風大'], exceptional: ['cloud', '天氣異常'],
};
const VAC = { docked: '充電座', cleaning: '清掃中', returning: '回充中', idle: '待機', paused: '暫停', error: '錯誤' };
const GARAGE = { open: '開著', closed: '關著', opening: '開啟中…', closing: '關閉中…' };

function renderWeather() {
  const u = cfg.ui || {}, w = st(u.weather), t = st(u.indoor_temp), h = st(u.indoor_hum);
  const parts = [];
  let ico = '';
  if (ok(w)) {
    const m = WX[w.s] || ['cloud', w.s];
    ico = icon(m[0]); parts.push(`${num(w.a.temperature)}°`, m[1]);
    if (w.a.humidity != null) parts.push(`濕度 ${num(w.a.humidity, 0)}%`);
  }
  else if (ok(t)) parts.push(`室內 ${num(t.s)}°`);
  const ie = $('#weather .wx-ico'); if (ie.dataset.k !== ico) { ie.innerHTML = ico; ie.dataset.k = ico; }
  setText($('#weather .wx-txt'), parts.length ? parts.join(' · ') : DASH);
  setText($('#st-indoor'), ok(t) ? `${num(t.s)}°C${ok(h) ? ' · ' + num(h.s, 0) + '%' : ''}` : DASH);
}

function renderStatus() {
  const u = cfg.ui || {};
  const p = st(u.person); setText($('#st-person'), ok(p) ? (p.s === 'on' ? '有人' : '沒人') : DASH, ok(p) && p.s === 'on' ? 'on' : '');
  const v = st(u.vacuum); setText($('#st-vacuum'), ok(v) ? (VAC[v.s] || v.s) : DASH, ok(v) && v.s === 'error' ? 'bad' : (ok(v) && v.s === 'cleaning' ? 'on' : ''));
  const g = st(u.garage); const gs = ok(g) ? (GARAGE[g.s] || g.s) : DASH;
  setText($('#st-garage'), gs, ok(g) && g.s !== 'closed' ? 'warn' : '');
  setText($('#garage-val'), gs, ok(g) && g.s !== 'closed' ? 'warn' : '');
  setText($('#garage-hint'), !ok(g) ? '' : g.s === 'closed' ? '按 OK 打開(會再確認)' : g.s === 'open' ? '按 OK 關上(會再確認)' : '');
  const sm = st(u.smoke); const smoke = ok(sm) && sm.s === 'on';
  setText($('#st-smoke'), ok(sm) ? (smoke ? '警報!' : '正常') : DASH, smoke ? 'bad' : (ok(sm) ? 'ok' : ''));
  if ($('#alert').hidden === smoke) { $('#alert').hidden = !smoke; if (smoke) catCall('poke', 'earTwitch'); updateMood(); }
}

function buildControls() {
  const u = cfg.ui || {};
  $('#lights').innerHTML = (u.lights || []).map((id) =>
    `<button class="f ctl light" data-act="light" data-eid="${id}"><span class="dot"></span><span class="name">${name(id)}</span><span class="val">${DASH}</span></button>`).join('');
  $('#acs').innerHTML = (u.acs || []).map((id) => `<div class="ac" data-eid="${id}">
      <div class="acname">${name(id)}<small>${DASH}</small></div>
      ${can(id, 'climate.set_temperature') ? `<button class="f ab" data-act="ac-down" data-eid="${id}" title="降 1 度">−</button>` : ''}
      <div class="actemp">${DASH}</div>
      ${can(id, 'climate.set_temperature') ? `<button class="f ab" data-act="ac-up" data-eid="${id}" title="升 1 度">+</button>` : ''}
      <button class="f ab pw" data-act="ac-power" data-eid="${id}">開</button></div>`).join('');
  $('#q-snap').innerHTML = icon('camera'); $('#garage-snap').innerHTML = icon('camera');
  $('#q-reload').innerHTML = icon('reload'); $('#q-settings').innerHTML = icon('gear'); $('#q-assist').innerHTML = icon('mic');
  if (cfg.assistant && cfg.assistant.enabled === false) { $('#q-assist').remove(); cfg.apps = cfg.apps.filter((a) => a.action !== 'assist'); }
  const camInfo = cfg.camera_info || {};
  const garageCam = u.garage_camera && (cfg.cameras || []).indexOf(u.garage_camera) >= 0 ? u.garage_camera : null;
  if (!garageCam) { $('#q-snap').remove(); $('#garage-snap').remove(); }
  const live = u.live_camera && camInfo[u.live_camera];
  if (live) { const b = $('#cam-live'); b.hidden = false; b.querySelector('.lc-ico').innerHTML = icon('camera'); b.firstChild.firstChild.textContent = live.name || '一樓畫面'; }
  else $('#cam-live').remove();
  if (!u.garage) $('.garage-row').remove();
}

const MODE = { cool: '冷氣', heat: '暖氣', dry: '除濕', fan_only: '送風', auto: '自動', heat_cool: '自動', off: '關' };
function renderControls() {
  document.querySelectorAll('#lights .light').forEach((el) => {
    const s = st(el.dataset.eid), on = ok(s) && s.s === 'on';
    el.classList.toggle('on', on);
    setText(el.querySelector('.val'), ok(s) ? (on ? '開' : '關') : DASH);
  });
  document.querySelectorAll('#acs .ac').forEach((row) => {
    const s = st(row.dataset.eid), on = ok(s) && s.s !== 'off';
    row.classList.toggle('on', on);
    const cur = ok(s) && s.a.current_temperature != null ? ` · 室溫 ${num(s.a.current_temperature)}°` : '';
    setText(row.querySelector('small'), ok(s) ? (on ? (MODE[s.s] || s.s) + ' 運轉中' : '關') + cur : DASH);
    setText(row.querySelector('.actemp'), ok(s) && s.a.temperature != null ? `${num(s.a.temperature)}°` : DASH);
    setText(row.querySelector('.pw'), on ? '關' : '開');
  });
}

function renderAll() { if (!cfg) return; renderWeather(); renderStatus(); renderControls(); }

function setConn() {
  const c = $('#conn');
  c.className = 'conn' + (!connected || !haConnected ? ' down' : cfg && cfg.mock ? ' mock' : '');
  c.title = !connected ? '連不到主機' : !haConnected ? 'Home Assistant 斷線' : (cfg && cfg.mock ? '模擬模式' : '已連線');
}

// ---------------------------------------------------------------- push channel (SSE)
let es;
function connect() {
  es = new EventSource('api/events');
  es.addEventListener('states', (e) => { const d = JSON.parse(e.data); states = d.states || {}; haConnected = !!d.connected; connected = true; setConn(); renderAll(); H.statesAt = Date.now(); });
  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data); const prev = states[d.id];
    if (d.st) states[d.id] = d.st; else delete states[d.id];
    renderAll(); H.lastPush = d;
    if (!prev || !d.st || prev.s !== d.st.s) catCall('poke', 'earTwitch');
  });
  es.addEventListener('ha', (e) => { haConnected = !!JSON.parse(e.data).connected; setConn(); });
  es.onerror = () => { connected = false; setConn(); };
  es.onopen = () => { connected = true; setConn(); };
}

// ---------------------------------------------------------------- service calls
async function call(entity_id, service, data, extra = {}) {
  if (cfg && cfg.can_call === false) { toast('這台裝置不能控制家裡(只有電視可以)'); return false; }
  H.calls.push({ entity_id, service, data });
  try {
    const r = await fetch('api/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ entity_id, service, data }, extra)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(r.status === 403 ? '不允許這個動作' : `失敗:${j.error || r.status}`); return false; }
    return true;
  } catch (e) { toast('連不到主機'); return false; }
}

// ---------------------------------------------------------------- dialogs
const nav = new Nav(ui, { onFocus, onBack, onEnter });

function openModal(title, bodyHtml, buttons, focusIndex = 0) {
  $('#m-title').textContent = title; $('#m-body').innerHTML = bodyHtml;
  $('#m-btns').innerHTML = buttons.map((b, i) => `<button class="f btn ${b.cls || ''}" data-mi="${i}">${b.label}</button>`).join('');
  modalButtons = buttons;
  $('#modal').hidden = false;
  nav.pushLayer($('#modal'), $('#m-btns').children[focusIndex]);
  catCall('poke', 'blink');
}
let modalButtons = [];
function closeModal() {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true; $('#m-body').innerHTML = ''; nav.popLayer();
  if (snapUrl) { URL.revokeObjectURL(snapUrl); snapUrl = null; }
  liveGen++; if (liveUrl) { URL.revokeObjectURL(liveUrl); liveUrl = null; }
}

function garage() {
  const id = cfg.ui.garage, g = st(id);
  if (!ok(g)) { toast('車庫門狀態不明,先不動作'); return; }
  if (g.s === 'opening' || g.s === 'closing') { toast('車庫門正在移動中'); return; }
  const open = g.s !== 'open';
  const svc = open ? 'cover.open_cover' : 'cover.close_cover';
  openModal(open ? '要打開車庫鐵門嗎?' : '要關上車庫鐵門嗎?',
    open ? '鐵門會往上捲開。確定門口附近沒有人或車再按「打開」。' : '關門前 Home Assistant 會先跑安全檢查腳本;門下有東西會停止。',
    [{ label: '取消' }, { label: open ? '打開' : '關上', cls: 'danger', run: async () => { if (await call(id, svc, undefined, { confirm: true })) toast(open ? '車庫門開啟中…' : '車庫門關閉中…'); } }], 0);
}

let snapUrl = null, snapBusy = false;
async function snapshot() {
  if (!(cfg.cameras || []).length) return;
  const cam = cfg.ui.garage_camera || cfg.cameras[0];
  const battery = !!((cfg.camera_info || {})[cam] || {}).battery;
  if ($('#modal').hidden) openModal('車庫畫面', '<div class="imgbox" id="snapbox">喚醒攝影機中…</div>', [{ label: '再拍一張', keep: true, run: snapshot }, { label: '關閉', cls: 'primary' }], 1);
  if (snapBusy) return;
  snapBusy = true;
  const box = () => $('#snapbox') || $('#snapimg');
  const show = (txt) => { const b = box(); if (b && b.id === 'snapbox') b.textContent = txt; else if (b) b.outerHTML = `<div class="imgbox" id="snapbox">${txt}</div>`; };
  show('喚醒攝影機中…');
  try {
    const r = await fetch(`api/snapshot/${encodeURIComponent(cam)}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); show(`拍太快了,請 ${Math.ceil(j.retry_after || 10)} 秒後再試`); return; }
    if (r.status === 403) { show('只有電視可以看攝影機'); return; }
    if (!r.ok) { show(battery ? '車庫相機在休眠,請稍後再試或用 Tapo App 喚醒' : '拍不到畫面,稍後再試'); return; }
    const blob = await r.blob();
    if (snapUrl) URL.revokeObjectURL(snapUrl);
    snapUrl = URL.createObjectURL(blob);
    const b = box(); if (b) b.outerHTML = `<img id="snapimg" alt="車庫" src="${snapUrl}">`;
    H.snapshots = (H.snapshots || 0) + 1;
  } catch (e) { show('連不到主機'); } finally { snapBusy = false; }
}

// Mains-powered camera (C400): refresh while the viewer is open and the page is visible.
let liveGen = 0, liveUrl = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function liveCam(cam) {
  const info = (cfg.camera_info || {})[cam] || {};
  const every = Math.max(1000, (info.refresh_s || 1.5) * 1000);
  openModal(info.name || '一樓畫面', '<div class="imgbox" id="livebox">連線中…</div><div class="camts" id="live-ts">&nbsp;</div>', [{ label: '關閉', cls: 'primary' }], 0);
  const g = ++liveGen; H.liveFrames = 0; H.liveCam = cam;
  let fails = 0;
  while (g === liveGen && !$('#modal').hidden) {
    if (document.hidden) { await sleep(600); continue; } // paused while another app is in front
    const t0 = performance.now();
    let wait = every;
    try {
      const r = await fetch(`api/snapshot/${encodeURIComponent(cam)}?t=${Date.now()}`, { cache: 'no-store' });
      if (g !== liveGen) break;
      if (r.status === 429) { const j = await r.json().catch(() => ({})); wait = Math.max(300, (j.retry_after || 1) * 1000); }
      else if (r.status === 403) { const b = $('#livebox'); if (b) b.textContent = '只有電視可以看攝影機'; break; }
      else if (!r.ok) { fails++; const b = $('#livebox'); if (b) b.textContent = '拍不到畫面,重試中…'; wait = Math.min(10000, every * (1 + fails)); }
      else {
        const url = URL.createObjectURL(await r.blob());
        const im = new Image(); im.src = url; try { await im.decode(); } catch (e) { /* */ }
        if (g !== liveGen) { URL.revokeObjectURL(url); break; }
        let img = $('#liveimg');
        if (!img) { const b = $('#livebox'); if (!b) { URL.revokeObjectURL(url); break; } b.outerHTML = '<img id="liveimg" alt="即時畫面">'; img = $('#liveimg'); }
        img.src = url;
        if (liveUrl) URL.revokeObjectURL(liveUrl);
        liveUrl = url; fails = 0; H.liveFrames++;
        const d = new Date(); const ts = $('#live-ts');
        if (ts) ts.textContent = `即時 · 更新於 ${d.toLocaleTimeString('zh-TW', { hour12: false })}`;
      }
    } catch (e) { fails++; const b = $('#livebox'); if (b) b.textContent = '連不到主機'; wait = 3000; }
    await sleep(Math.max(0, wait - (performance.now() - t0)));
  }
}

// ---------------------------------------------------------------- wallpaper scenes + schedule
// Manual pick while auto is on lasts until the next schedule boundary (localStorage 'wallOverride').
const autoWallOn = () => store.get('autoWall', '1') === '1';
function sceneById(id) { return sceneList(cfg).find((x) => x.id === id) || null; }
function manualScene() {
  const sc = sceneById(store.get('scene', ''));
  if (sc) return sc;
  const style = store.get('style', cfg.default_style), coat = store.get('coat', cfg.default_coat);
  return sceneList(cfg).find((x) => x.style === style && (x.coat || 'black') === coat) || { id: '', name: '', style, coat };
}
function wallOverride() {
  try { const o = JSON.parse(store.get('wallOverride', 'null')); if (o && o.until > now().getTime() && sceneById(o.scene)) return o; } catch (e) { /* */ }
  return null;
}
function wantedScene() {
  if (!autoWallOn()) return { scene: manualScene(), why: 'manual' };
  const o = wallOverride(); if (o) return { scene: sceneById(o.scene), why: 'override', until: o.until };
  const r = randomActive(cfg, now()); if (r) return { scene: r.scene, why: 'random', until: r.until.getTime() };
  const s = scheduled(cfg, now());
  if (!s) return { scene: manualScene(), why: 'manual' };
  // a scene from the factory may take over this slot (seeded per slot; only if its pack is available)
  const g = genPick(cfg, s.since, now());
  if (g && !failedScenes.has(g.id) && (!styleInfo || availScenes().indexOf(g) >= 0)) return { scene: g, why: 'generated', next: s.next };
  return { scene: s.scene, why: 'schedule', next: s.next };
}
function wallTick() {
  if (!cfg || !cat) return;
  const w = wantedScene(); H.wall = { scene: w.scene && w.scene.id, why: w.why };
  if (!w.scene || catLoading) return;
  if (cat.style !== w.scene.style || cat.coat !== (w.scene.coat || 'black') || curSceneId !== w.scene.id) applyScene(w.scene, true);
}
let curSceneId = null, catLoading = false;
const failedScenes = new Set(); // generated scenes whose pack did not load (e.g. pruned while this page was open): not picked again
async function applyScene(sc, fade) {
  curSceneId = sc.id; catLoading = true;
  try { await loadCat(sc.style, sc.coat || 'black', { fade, params: sc.params }); } finally { catLoading = false; }
  if (sc.gen && (H.style !== sc.style || H.coat !== sc.coat)) failedScenes.add(sc.id);
  H.scene = sc.id;
}

// ---------------------------------------------------------------- settings sheet
const COAT_NAMES = { black: '黑貓', tabby: '虎斑' };
let styleInfo = null;
async function openSheet() {
  $('#sheet').hidden = false;
  nav.pushLayer($('#sheet'), $('#sheet .btn'));
  await renderSheet(true);
}
async function renderSheet(probe) {
  if (probe || !styleInfo) {
    $('#s-scenes').innerHTML = '<span class="about">檢查可用的場景…</span>';
    styleInfo = catMod ? await catMod.probeStyles(uniq(sceneList(cfg).map((x) => x.style).concat(cfg.styles))) : [];
  }
  const avail = availScenes();
  const focusedKey = nav.cur && nav.cur.dataset && (nav.cur.dataset.scene || nav.cur.dataset.auto || nav.cur.dataset.pin || nav.cur.dataset.swat);
  $('#s-scenes').innerHTML = avail.length ? avail.map((x) => `<button class="f thumb ${x.id === curSceneId ? 'sel' : ''}" data-act="scene" data-scene="${x.id}"><img alt="" src="${thumbUrl(x)}"><span>${x.name || x.id}</span></button>`).join('')
    : '<span class="about">背景無法載入(WebGL 不可用)</span>';
  const auto = autoWallOn();
  const nextB = nextBoundary();
  $('#s-pin').innerHTML = `<button class="f opt ${auto && wallOverride() ? 'sel' : ''}" data-act="pin" data-pin="next">到下個時段${nextB ? ' ' + fmtHM(nextB) : ''}</button><button class="f opt ${auto ? '' : 'sel'}" data-act="pin" data-pin="always">一直固定</button>`;
  $('#s-auto').innerHTML = `<button class="f opt ${auto ? 'sel' : ''}" data-act="auto-wall" data-auto="on">開</button><button class="f opt ${auto ? '' : 'sel'}" data-act="auto-wall" data-auto="off">關</button>`;
  const swatOn = store.get('swat', '0') === '1';
  $('#s-swat').innerHTML = `<button class="f opt ${swatOn ? 'sel' : ''}" data-act="swat" data-swat="on">開</button><button class="f opt ${swatOn ? '' : 'sel'}" data-act="swat" data-swat="off">關</button><span class="about inl">停在 App 圖示上 1.5 秒,貓會撲一下</span>`;
  const sch = scheduled(cfg, now()), ov = auto && wallOverride();
  const rnd = auto && !ov && randomActive(cfg, now());
  const plan = randomPlan(cfg, now());
  const nm = (x) => (x && (x.name || x.id)) || '—';
  const gNow = sch && sch.mode === 'schedule' ? genPick(cfg, sch.since, now()) : null;
  $('#s-sched').innerHTML = !sch ? '<div class="about">沒有設定時間表</div>'
    : (sch.mode === 'rotate_daily' ? `<div class="srow on"><b>每天輪換</b><span>今天:${nm(sch.scene)}</span></div>`
      : sch.rows.map((r) => `<div class="srow ${auto && r.active && !ov && !rnd ? 'on' : ''}"><b>${r.from}</b><span>${nm(r.scene)}${r.active && gNow ? `(這個時段換成新場景:${nm(gNow)})` : ''}</span></div>`).join(''))
      + (plan.length ? `<div class="srow rnd ${rnd ? 'on' : ''}"><b>隨機</b><span>今天 ${plan.map((p) => `${fmtHM(p.from)}–${fmtHM(p.until)} ${nm(p.scene)}`).join('、')}</span></div>` : '')
      + (!auto ? '<div class="about">關閉中:一直固定在目前的場景</div>'
        : ov ? `<div class="about">手動選擇,維持到 ${fmtHM(new Date(ov.until))}</div>`
          : rnd ? `<div class="about">隨機出現中,${fmtHM(rnd.until)} 回到時間表</div>`
            : sch.next ? `<div class="about">下次換:${fmtHM(sch.next)}</div>` : '');
  renderFactory();
  $('#s-about').innerHTML = `主機:${location.host}${cfg.mock ? '(模擬模式)' : ''}<br>Home Assistant:${haConnected ? '已連線' : '未連線'}<br>畫面:${cat ? cat.quality + ' ' + cat.W + '×' + cat.H : '無背景'} · ${isTV ? '電視' : '瀏覽器'}`;
  const again = focusedKey && document.querySelector(`#sheet [data-scene="${focusedKey}"], #sheet [data-auto="${focusedKey}"], #sheet [data-pin="${focusedKey}"], #sheet [data-swat="${focusedKey}"]`);
  const closeBtn = $('#sheet .btn');
  if (again) { nav.cur = null; nav.focus(again); } else if (probe || !nav.cur || !document.contains(nav.cur) || nav.cur === closeBtn) nav.focus($('#sheet .thumb.sel') || $('#sheet .thumb') || $('#sheet .opt') || closeBtn);
}
// ---- scene factory (host-side generator, bridge /api/scenes/factory): latest scene + "generate one now"
let factoryTimer = null;
const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${fmtHM(d)}`; };
async function renderFactory() {
  const box = $('#s-factory'); if (!box) return;
  let f = null;
  try { const r = await fetch('api/scenes/factory', { cache: 'no-store' }); if (r.ok) f = await r.json(); } catch (e) { /* */ }
  H.factory = f;
  if (!f || !f.available) { box.innerHTML = '<span class="about">場景工廠沒有啟用</span>'; return; }
  const running = f.state === 'running', busy = running || f.pending > 0;
  const lines = [];
  lines.push(f.latest ? `最新場景:${f.latest.name},於 ${fmtWhen(f.latest.at)} 生成` : '還沒有自動生成的場景');
  if (running) lines.push(`正在生成新場景…(${f.step || '準備中'},約需 5–15 分鐘)`);
  else if (f.pending) lines.push('已排入,幾分鐘內開始生成');
  else if (f.last_result === 'disk low') lines.push('主機空間不足(< 4 GB),暫停生成');
  else if (f.last_result === 'quota') lines.push(`Google 生圖額度暫時用完了${f.quota_reset ? `,約 ${fmtWhen(f.quota_reset)} 後恢復` : ''}`);
  else if (f.last_result && f.last_result !== 'published' && f.last_finished) lines.push(`上次(${fmtWhen(f.last_finished)})沒有通過品質檢查,沒有上架`);
  else if (f.last_result === 'published' && f.latest && Date.now() - Date.parse(f.latest.at) < 6 * 3600e3 && !sceneById(f.latest.scene)) lines.push('新場景已上架:按「重新整理」就看得到');
  const focused = nav.cur && nav.cur.dataset && nav.cur.dataset.act === 'factory-run';
  box.innerHTML = `<button class="f opt" data-act="factory-run" ${busy || f.requests_left <= 0 ? 'aria-disabled="true"' : ''}>${busy ? '生成中…' : '立刻生成一張新場景'}</button>`
    + `<span class="about inl">${lines.join('<br>')}${!busy ? `<br>今天還可以按 ${f.requests_left} 次` : ''}`
    + `${f.disk ? `<br>主機剩餘空間 ${f.disk.free_gb} GB · 生成場景 ${f.disk.gen_count} 個 / ${Math.round(f.disk.gen_mb)} MB` : ''}</span>`;
  if (focused) nav.focus(box.querySelector('[data-act="factory-run"]'));
  clearTimeout(factoryTimer);
  if (busy && !$('#sheet').hidden) factoryTimer = setTimeout(renderFactory, 15000);
}
async function factoryRun() {
  try {
    const r = await fetch('api/scenes/factory/run', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    toast(j.queued ? '已開始:新場景大約 5–15 分鐘後上架' : j.reason === 'daily limit' ? '今天已經生成太多次了,明天再試' : j.reason === 'quota' ? 'Google 生圖額度暫時用完了,晚點再試' : j.reason === 'running' || j.reason === 'already requested' ? '正在生成中' : '無法開始生成', 3000);
  } catch (e) { toast('連不到主機', 2500); }
  renderFactory();
}
function availScenes() {
  return sceneList(cfg).filter((x) => { if (!styleInfo) return true; const si = styleInfo.find((s) => s.id === x.style); return si && (!x.coat || si.coats.indexOf(x.coat) >= 0); });
}
const thumbUrl = (x) => x.thumb || `../cats/${x.style}/${x.coat || 'black'}/assets/thumb.jpg`;
function nextBoundary() { const s = scheduled(cfg, now()); return s && s.next; }
// pick a scene by hand: while auto is on it lasts until the next schedule boundary; 'always' turns auto off
async function pickScene(sc, how) {
  store.set('scene', sc.id); store.set('style', sc.style); store.set('coat', sc.coat || 'black');
  let until = null;
  if (how === 'always') { store.set('autoWall', '0'); store.set('wallOverride', 'null'); }
  else if (autoWallOn()) { const nb = nextBoundary(); if (nb) { until = nb; store.set('wallOverride', JSON.stringify({ scene: sc.id, until: nb.getTime() })); } }
  H.pick = { scene: sc.id, how: how || 'next' };
  if (sc.id !== curSceneId) await applyScene(sc, true);
  return until;
}
function backToAuto() { store.set('autoWall', '1'); store.set('wallOverride', 'null'); wallTick(); }
function closeSheet() { if ($('#sheet').hidden) return; $('#sheet').hidden = true; nav.popLayer(); }
const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);

// ---------------------------------------------------------------- input handlers
let lastZone = null, idleTimer, prevFocusX = null;
// ---- 貓撲圖示: focus resting on a dock tile for 1.5 s -> the cat swats at it (once per dwell, >= 6 s apart)
let swatTimer = null, lastSwatAt = -1e9;
const SWAT_DWELL = 1500, SWAT_EVERY = 6000;
function armSwat(el) {
  clearTimeout(swatTimer);
  if (!el.closest('#dock') || el.classList.contains('gmain')) return;
  swatTimer = setTimeout(() => trySwat(el), SWAT_DWELL);
}
function trySwat(el) {
  if (nav.cur !== el || store.get('swat', '0') !== '1' || mood === 'sleepy' || !cat || !$('#sheet').hidden) return;
  const t = Date.now(); if (t - lastSwatAt < SWAT_EVERY) return;
  lastSwatAt = t;
  const r = el.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect();
  const x = (r.left + r.width / 2 - sr.left) / sr.width, y = (r.top + r.height / 2 - sr.top) / sr.height;
  catCall('poke', 'swat', x, y);
  H.swats = (H.swats || 0) + 1; H.lastSwat = { key: el.dataset.key, x: +x.toFixed(3), y: +y.toFixed(3), hit: !!cat.canSwat };
  if (cat.canSwat) setTimeout(() => { if (nav.cur === el) hitTile(el); }, 300); // impact ~0.3 s into the swipe
}
function hitTile(el) {
  el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit');
  const c = document.createElement('span'); c.className = 'claw';
  c.innerHTML = '<svg viewBox="0 0 100 100"><path d="M24 16 Q42 50 30 86M46 10 Q64 48 54 88M68 14 Q84 48 78 84"/></svg>';
  el.appendChild(c);
  setTimeout(() => { c.remove(); el.classList.remove('hit'); }, 460);
  H.hits = (H.hits || 0) + 1;
}
function onFocus(el, opt) {
  syncGroups(el);
  if (el.classList.contains('gmain')) { // open the group and move into it (from the side we came from)
    const g = el.parentNode; g.classList.add('open');
    const subs = g.querySelectorAll('.sub'); const gr = el.getBoundingClientRect();
    const fromRight = prevFocusX != null && prevFocusX > gr.left + gr.width / 2 && !(opt && opt.pointer);
    nav.focus(fromRight ? subs[subs.length - 1] : subs[0]);
    return;
  }
  { const rr = el.getBoundingClientRect(); prevFocusX = rr.left + rr.width / 2; }
  armSwat(el);
  if (el.closest('#sheet')) { try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* */ } }
  H.focus = el.id || el.dataset.key || el.dataset.style || el.dataset.coat || (el.dataset.act ? el.dataset.act + (el.dataset.eid ? ':' + el.dataset.eid : '') : 'btn:' + el.textContent.trim());
  const r = el.getBoundingClientRect();
  const sr = $('#stage').getBoundingClientRect();
  catCall('setGaze', (r.left + r.width / 2 - sr.left) / sr.width, (r.top + r.height / 2 - sr.top) / sr.height);
  const zone = el.closest('#dock, #panel, #quick, .layer'); const z = zone && zone.id;
  if (z !== lastZone) { lastZone = z; catCall('poke', 'earTwitch'); }
  clearTimeout(idleTimer); idleTimer = setTimeout(() => catCall('setGaze', null), 25000);
}

function onBack() {
  if (!$('#modal').hidden) return closeModal();
  if (assist && assist.isOpen()) return assist.back();
  if (!$('#sheet').hidden) return closeSheet();
  // At the root: stay (this is the home). Move focus back to the app row.
  const first = $('#dock .tile'); if (first) nav.focus(first);
}

// ---------------------------------------------------------------- remote colour keys (webOS keyCodes)
//   紅 403 = 上一個場景 · 綠 404 = 一直固定目前場景(再按一次取消)· 黃 405 = 回到自動換桌布 · 藍 406 = 下一個場景
//   (上一個/下一個在自動模式下維持到下個時段)
document.addEventListener('keydown', async (e) => {
  const k = e.keyCode; if (k < 403 || k > 406 || !cfg || !cat) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  e.preventDefault(); H.colorKeys = (H.colorKeys || 0) + 1;
  if (k === 405) { backToAuto(); const w = wantedScene(); toast(`自動換桌布 · ${(w.scene && w.scene.name) || ''}`, 2200); if (!$('#sheet').hidden) renderSheet(false); return; }
  const list = availScenes(); if (!list.length) return;
  const cur = Math.max(0, list.findIndex((x) => x.id === curSceneId));
  if (k === 404) {
    if (!autoWallOn()) { backToAuto(); toast('取消固定 · 自動換桌布', 2200); } else { const sc = list[cur]; await pickScene(sc, 'always'); toast(`固定:${sc.name}(一直固定)`, 2200); }
  } else {
    const sc = list[(cur + (k === 406 ? 1 : -1) + list.length) % list.length];
    const until = await pickScene(sc, autoWallOn() ? 'next' : 'always');
    toast(`場景:${sc.name}${until ? ' · 到 ' + fmtHM(until) : autoWallOn() ? '' : ' · 一直固定'}`, 2200);
  }
  if (!$('#sheet').hidden) renderSheet(false);
}, true);

async function onEnter(el) {
  catCall('poke', 'blink');
  if (el.dataset.mi != null) {
    const b = modalButtons[+el.dataset.mi]; if (!b) return;
    if (!b.keep) closeModal();
    if (b.run) b.run();
    return;
  }
  if (assist && assist.isOpen() && assist.enter(el)) return;
  const act = el.dataset.act, id = el.dataset.eid;
  switch (act) {
    case 'assist': return assist && assist.open();
    case 'live-cam': return liveCam(cfg.ui.live_camera);
    case 'scene': {
      const sc = sceneById(el.dataset.scene); if (!sc) return;
      toast(`切換到 ${sc.name || sc.id}…`, 1500);
      await pickScene(sc, autoWallOn() ? 'next' : 'always'); renderSheet(false); return;
    }
    case 'pin': {
      const sc = sceneById(curSceneId) || manualScene(); if (!sc || !sc.id) return;
      const until = await pickScene(sc, el.dataset.pin);
      toast(el.dataset.pin === 'always' ? `固定:${sc.name}(一直固定)` : `固定:${sc.name}${until ? '(到 ' + fmtHM(until) + ')' : ''}`, 2200);
      renderSheet(false); return;
    }
    case 'swat': store.set('swat', el.dataset.swat === 'on' ? '1' : '0'); renderSheet(false); return;
    case 'group': return; // the HDMI group tile opens on focus
    case 'auto-wall': {
      const on = el.dataset.auto === 'on'; store.set('autoWall', on ? '1' : '0'); store.set('wallOverride', 'null');
      if (on) wallTick(); else { const m = manualScene(); if (m.id !== curSceneId) applyScene(m, true); }
      renderSheet(false); return;
    }
    case 'app': return openApp(findApp(el.dataset.key));
    case 'settings': return openSheet();
    case 'sheet-close': return closeSheet();
    case 'factory-run': return el.getAttribute('aria-disabled') === 'true' ? toast('正在生成中或今天次數已用完', 2200) : factoryRun();
    case 'reload': return location.reload();
    case 'snapshot': return snapshot();
    case 'garage': return garage();
    case 'light': {
      const s = st(id); if (!s) { toast(`${name(id)}:沒有狀態`); return; }
      await call(id, 'light.toggle'); return;
    }
    case 'ac-power': {
      const s = st(id); if (!ok(s)) { toast(`${name(id)}:沒有狀態`); return; }
      if (await call(id, s.s === 'off' ? 'climate.turn_on' : 'climate.turn_off')) toast(`${name(id)}${s.s === 'off' ? '開機' : '關機'}`);
      return;
    }
    case 'ac-up': case 'ac-down': {
      const s = st(id); if (!ok(s) || s.a.temperature == null) { toast(`${name(id)}:沒有溫度`); return; }
      const step = +s.a.target_temp_step || 1, lo = s.a.min_temp != null ? +s.a.min_temp : 16, hi = s.a.max_temp != null ? +s.a.max_temp : 30;
      const t = Math.max(lo, Math.min(hi, +s.a.temperature + (act === 'ac-up' ? step : -step)));
      if (t === +s.a.temperature) { toast(`${name(id)}已經是${act === 'ac-up' ? '最高' : '最低'} ${t}°`); return; }
      // optimistic: show the new target now; the push from HA confirms it
      setText(el.parentNode.querySelector('.actemp'), `${num(t)}°`);
      await call(id, 'climate.set_temperature', { temperature: t });
      return;
    }
    case 'style': {
      const s = el.dataset.style; store.set('style', s);
      toast('切換畫風…', 1500);
      await loadCat(s, cat ? cat.coat : store.get('coat', cfg.default_coat)); renderSheet(false); return;
    }
    case 'coat': {
      const c = el.dataset.coat; store.set('coat', c);
      await loadCat(cat ? cat.style : store.get('style', cfg.default_style), c); renderSheet(false); return;
    }
  }
}

function findApp(key) {
  for (const a of cfg.apps) { if (a.key === key) return a; for (const g of a.group || []) if (g.key === key) return g; }
  return null;
}
// 'ytsearch_play' tile (e.g. 壁爐): the bridge picks a long video for the tile's query once a day; play it directly.
const YT_APP = 'youtube.leanback.v4';
async function ytPlay(app) {
  toast(`正在開啟 ${app.title}…`, 2500);
  let vid = null;
  try { const r = await fetch(`api/ytpick?key=${encodeURIComponent(app.key)}`, { cache: 'no-store' }); const j = await r.json(); if (r.ok && j.videoId) { vid = j.videoId; H.ytpick = j; } } catch (e) { /* */ }
  const params = vid ? { contentTarget: `https://www.youtube.com/tv?v=${vid}` } : { contentTarget: `https://www.youtube.com/tv#/search?q=${encodeURIComponent(app.query || app.title)}` };
  H.launches.push(YT_APP + (vid ? '?v=' + vid : '?q=' + (app.query || '')));
  try { await launch(YT_APP, params); } catch (e) { H.lastLaunchError = e.message; toast('無法開啟 YouTube', 3000); }
}

async function openApp(app) {
  if (!app) return;
  if (app.action === 'settings') return openSheet();
  if (app.action === 'assist') return assist && assist.open();
  if (app.action === 'ytsearch_play') return ytPlay(app);
  H.launches.push(app.id);
  toast(`正在開啟 ${app.title}…`, 2000);
  try {
    await launch(app.id, app.params);
  } catch (e) {
    H.lastLaunchError = e.message;
    toast(e.message === 'bridge-not-implemented' ? `無法開啟 ${app.title}:這裡不能直接開 App(主機的 launch 尚未實作)` : `無法開啟 ${app.title}`, 4000);
  }
}

function buildDock() {
  const tile = (a) => `<button class="f tile" data-act="app" data-key="${a.key}" style="--c:${a.color || '#3a4660'}">${appIcon(a) || `<span class="badge">${icon(a.icon)}</span>`}<span class="t">${a.title}</span></button>`;
  // a group tile (HDMI) expands in place into compact sub-tiles while it has focus (transform/opacity only)
  const group = (a) => `<div class="grp" data-grp="${a.key}" style="--c:${a.color || '#3a4660'}"><button class="f tile gmain" data-act="group" data-key="${a.key}">${appIcon(a) || `<span class="badge">${icon(a.icon)}</span>`}<span class="t">${a.title}</span></button>`
    + `<div class="gsubs">${a.group.map((g) => `<button class="f tile sub" data-act="app" data-key="${g.key}" title="${g.title || g.key}">${appIcon(g) || ''}<span class="t">${g.label || g.title}</span></button>`).join('')}</div></div>`;
  $('#dock').innerHTML = cfg.apps.map((a) => (Array.isArray(a.group) && a.group.length ? group(a) : tile(a))).join('');
}
function syncGroups(el) {
  document.querySelectorAll('#dock .grp.open').forEach((g) => { if (!g.contains(el)) g.classList.remove('open'); });
}

// ---------------------------------------------------------------- cat background
let cat = null, catMod = null, assist = null;
function catCall(fn, ...a) { if (cat) cat.call(fn, ...a); else (pendingCat[fn] = a); }
const pendingCat = {};
let mood = null;
function updateMood(h) {
  if (h == null) { const d = new Date(); h = d.getHours() + d.getMinutes() / 60; }
  const smoke = !$('#alert').hidden;
  const m = smoke ? 'alert' : (h >= 23 || h < 6 ? 'sleepy' : 'awake');
  if (m !== mood) { mood = m; catCall('setMood', m); }
}
async function loadCat(style, coat, opts = {}) {
  if (!cat) return;
  const order = uniq([style].concat(cfg.styles, ['_example']));
  try {
    const used = await cat.load(style, coat, order.slice(1), opts);
    if (!used) return; // superseded by a newer load
    H.style = used.style; H.coat = used.coat; H.catReady = true;
    if (used.style !== style || used.coat !== coat) console.warn('[cat] fell back to', used.style, used.coat);
  } catch (e) { H.catErr = String(e); console.warn('[cat] no background', e); }
}
async function initCat() {
  if (qs.get('cat') === '0') return;
  try {
    catMod = await import('./cat.js');
    const quality = qs.get('q') || (isTV ? 'tv' : 'desktop');
    // 電視上毛玻璃(backdrop-filter)會掉到 24 fps,實測 2026-11-15;電視預設 lite,?glass=1 可強制開
    document.body.classList.toggle('lite', qs.get('glass') !== '1' && (qs.get('lite') === '1' || isTV || !!(cfg.ui && cfg.ui.lite)));
    cat = new catMod.CatHost($('#stage'), { quality, fps: +(qs.get('fps') || (quality === 'tv' ? 30 : 60)) });
    for (const k in pendingCat) cat.call(k, ...pendingCat[k]);
    const w = wantedScene(); H.wall = { scene: w.scene && w.scene.id, why: w.why };
    await applyScene(w.scene, false);
  } catch (e) { H.catErr = String(e); console.warn('[cat] disabled', e); }
}

// ---------------------------------------------------------------- boot
const DEFAULT_CFG = { apps: [{ key: 'settings', title: '設定', action: 'settings', icon: 'gear' }], ui: {}, styles: ['_example'], default_style: '_example', default_coat: 'black', names: {}, services: {}, cameras: [] };
async function main() {
  try {
    const r = await fetch('api/config', { cache: 'no-store' });
    cfg = r.ok ? await r.json() : DEFAULT_CFG;
  } catch (e) { cfg = DEFAULT_CFG; }
  buildControls(); buildDock(); renderAll(); setConn();
  assist = createAssist({ nav, catCall, launch, toast, H });
  tick();
  nav.focus($('#dock .tile'));
  connect();
  H.ready = true;
  initCat(); // background loads after the UI is usable
}
main().catch((e) => { H.err = String(e && e.stack || e); console.error(e); });
