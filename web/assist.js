// AI 助手 overlay. Input = a big text field: on the TV, focusing it opens the LG virtual keyboard
// (verified 2026-11-15: PalmSystem.isKeyboardVisible + 'keyboardStateChange'); its mic key / the remote's
// mic button dictates into it. webkitSpeechRecognition exists on webOS 26 but start() fails with
// "not-allowed" (http page, no getUserMedia), so it is not used.
// Brain = bridge POST /api/assist; this page only renders the reply and launches YouTube.
import { icon } from './icons.js';

const YT_APP = 'youtube.leanback.v4';
const ytVideo = (id) => ({ contentTarget: `https://www.youtube.com/tv?v=${id}` });              // verified on the TV
const ytSearch = (q) => ({ contentTarget: `https://www.youtube.com/tv#/search?q=${encodeURIComponent(q)}` }); // not verified
const EXAMPLES = ['客廳冷氣開著嗎?', '把客廳冷氣調到 26 度', '主燈關掉', '播放貓咪影片', '搜尋 下雨聲'];
const HINT = '按遙控器的麥克風鍵說話,或用鍵盤輸入,按 OK 送出';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createAssist({ nav, catCall, launch, toast, H }) {
  const $ = (s) => document.querySelector(s);
  const layer = $('#assist'), input = $('#as-input');
  let busy = false, pending = null, autoTimer = null, lastTwitch = 0, lastQuery = '';
  H.assist = { opened: 0, sent: [], last: null };
  $('#as-badge').innerHTML = icon('mic');

  const twitch = () => { const n = Date.now(); if (n - lastTwitch > 1200) { lastTwitch = n; catCall('poke', 'earTwitch'); } };
  const hint = (t, cls) => { const h = $('#as-hint'); h.textContent = t; h.className = 'as-hint' + (cls ? ' ' + cls : ''); };
  const listening = (on) => { layer.classList.toggle('listening', !!on); if (on) twitch(); };

  function renderExamples() {
    $('#as-label').textContent = '試試看(用遙控器選一個)';
    $('#as-cards').className = 'as-cards ex';
    $('#as-cards').innerHTML = EXAMPLES.map((t) => `<button class="f as-ex" data-act="as-ex">${esc(t)}</button>`).join('');
  }

  function renderResults(results, query) {
    lastQuery = query || '';
    if (!results || !results.length) { renderExamples(); return; }
    $('#as-label').textContent = `YouTube「${query || ''}」· 選一部按 OK 播放`;
    $('#as-cards').className = 'as-cards';
    $('#as-cards').innerHTML = results.slice(0, 4).map((r) => `<button class="f as-card" data-act="as-play" data-vid="${esc(r.videoId)}" data-title="${esc(r.title)}">
        <span class="th"><img alt="" src="https://i.ytimg.com/vi/${encodeURIComponent(r.videoId)}/mqdefault.jpg" onerror="this.style.visibility='hidden'"><span class="dur">${esc(r.duration || '')}</span></span>
        <span class="tt">${esc(r.title)}</span><span class="ch">${esc(r.channel || '')}</span></button>`).join('')
      + (query ? `<button class="f as-card more" data-act="as-ytsearch"><span class="th">${icon('play')}</span><span class="tt">在 YouTube 裡搜尋</span><span class="ch">「${esc(query)}」</span></button>` : '');
  }

  function open() {
    layer.hidden = false; H.assist.opened++;
    document.getElementById('ui').classList.add('assist-open');
    nav.pushLayer(layer, input);
    if (!$('#as-cards').children.length) renderExamples();
    hint(HINT); input.placeholder = '例如:客廳冷氣調到 26 度、播放貓咪影片';
    catCall('poke', 'earTwitch');
    try { input.focus(); } catch (e) { /* */ }
  }
  function close() {
    if (layer.hidden) return;
    cancelPending(); clearTimeout(autoTimer);
    try { input.blur(); } catch (e) { /* */ }
    layer.hidden = true; listening(false);
    document.getElementById('ui').classList.remove('assist-open');
    nav.popLayer();
  }

  function cancelPending() { if (pending) { clearTimeout(pending.timer); pending = null; layer.classList.remove('counting'); } }

  function chip(text, cls) { return `<span class="as-chip ${cls || ''}">${cls === 'bad' ? '' : '✓ '}${esc(text)}</span>`; }

  function playSoon(videoId, title, delay) {
    cancelPending();
    const chips = $('#as-chips');
    const id = 'as-count';
    chips.insertAdjacentHTML('beforeend', `<span class="as-chip go" id="${id}">▶ 即將在 YouTube 播放${title ? '「' + esc(title.slice(0, 28)) + '」' : ''} · 按返回取消</span>`);
    layer.classList.add('counting');
    H.assist.pendingPlay = videoId;
    pending = { timer: setTimeout(async () => {
      pending = null; layer.classList.remove('counting');
      H.launches.push(YT_APP + '?v=' + videoId);
      try { await launch(YT_APP, ytVideo(videoId)); close(); } catch (e) {
        const c = document.getElementById(id); if (c) { c.className = 'as-chip bad'; c.textContent = '開不了 YouTube(這裡不能直接開 App)'; }
        H.lastLaunchError = e.message;
      }
    }, delay) };
  }

  async function submit(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text || busy) return;
    clearTimeout(autoTimer); cancelPending();
    busy = true; H.assist.sent.push(text);
    try { input.blur(); } catch (e) { /* */ }
    $('#as-conv').hidden = false;
    $('#as-you').textContent = text;
    $('#as-reply').innerHTML = '<span class="dots">想一下<i>.</i><i>.</i><i>.</i></span>';
    $('#as-chips').innerHTML = '';
    layer.classList.add('thinking'); listening(false); twitch();
    hint('思考中…');
    let j = null, status = 0;
    try {
      const r = await fetch('api/assist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      status = r.status; j = await r.json().catch(() => null);
    } catch (e) { status = -1; }
    busy = false; layer.classList.remove('thinking');
    H.assist.last = j;
    if (!j || !j.ok) {
      const msg = status === 403 ? '只有電視可以使用 AI 助手' : status === 429 ? `問太快了,請 ${Math.ceil((j && j.retry_after) || 10)} 秒後再試` : status === -1 ? '連不到主機' : 'AI 助手暫時不能用';
      $('#as-reply').textContent = msg; hint(HINT); nav.focus(input, { soft: true }); return;
    }
    $('#as-reply').textContent = j.reply || '好了。';
    input.value = ''; input.placeholder = '還有什麼事?按 OK 再說一次';
    const play = (j.actions || []).find((a) => a.type === 'play');
    $('#as-chips').innerHTML = (j.done || []).filter((d) => !(play && /^在 YouTube 播放/.test(d))).map((d) => chip(d)).join('');
    renderResults(j.results, j.query);
    hint(HINT);
    // 2026-11-15 屋主:搜尋完不要自動播放,一律等他選。AI 建議的那部只是先選好、標「推薦」
    if (play) {
      const cards = Array.prototype.slice.call(document.querySelectorAll('#as-cards .as-card'));
      const rec = cards.find((c) => c.dataset.vid === play.videoId) || cards[0];
      if (rec) rec.classList.add('rec');
      $('#as-reply').textContent = (j.results && j.results.length > 1) ? '找到這些,選一部按 OK 播放(推薦的已幫你選好)。' : (j.reply || '找到了,按 OK 播放。');
      hint('選一部按 OK 播放 · 按返回取消');
      nav.focus(rec || input);
    }
    else if (j.results && j.results.length) nav.focus($('#as-cards .as-card'));
    else nav.focus(input, { soft: true });
    if ((j.done || []).length) catCall('poke', 'blink');
  }

  // dictation heuristics: a multi-character insert that is not IME composition = voice → send after a pause
  input.addEventListener('input', (e) => {
    twitch(); listening(true);
    clearTimeout(autoTimer);
    const multi = e.data && e.data.length >= 2 && !e.isComposing && /insertText|insertReplacementText/.test(e.inputType || '');
    if (multi && input.value.trim().length >= 2) {
      hint('聽到了,馬上送出…(繼續輸入可取消)', 'go');
      autoTimer = setTimeout(() => submit(input.value), 1500);
      H.assist.autoArmed = true;
    }
  });
  input.addEventListener('focus', () => listening(true));
  input.addEventListener('blur', () => listening(false));
  document.addEventListener('keyboardStateChange', (e) => {
    const vis = !!(e.detail && e.detail.visibility);
    H.assist.keyboard = vis;
    if (layer.hidden) return;
    listening(vis);
    if (!vis && input.value.trim() && !busy && document.activeElement === input) { nav.focus($('#as-send')); hint('按 OK 送出', 'go'); }
  });

  return {
    open, close, submit,
    isOpen: () => !layer.hidden,
    back() { if (pending) { cancelPending(); const c = document.getElementById('as-count'); if (c) { c.className = 'as-chip bad'; c.textContent = '已取消播放'; } return true; } close(); return true; },
    enter(el) {
      const act = el.dataset.act;
      if (el === input && document.activeElement !== input) { input.focus(); return true; } // opens the TV keyboard
      if (el === input || act === 'as-send') { submit(input.value); return true; }
      if (act === 'as-ex') { input.value = el.textContent; submit(el.textContent); return true; }
      if (act === 'as-play') { $('#as-chips').innerHTML = ''; playSoon(el.dataset.vid, el.dataset.title, 900); return true; }
      if (act === 'as-ytsearch') { launch(YT_APP, ytSearch(lastQuery)).then(close).catch(() => toast('開不了 YouTube')); return true; }
      return false;
    },
  };
}
