// Spatial navigation for the TV remote + Magic Remote pointer.
// Focusable = elements with class "f" inside the active layer (topmost open modal, else #ui).
export const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESC: 27, BACKSPACE: 8 };

export class Nav {
  constructor(root, { onFocus, onBack, onEnter }) {
    this.root = root; this.cur = null; this.layers = []; this.onFocus = onFocus; this.onBack = onBack; this.onEnter = onEnter;
    document.addEventListener('keydown', (e) => this.key(e), true);
    // Magic Remote / mouse: hovering focuses, click activates
    root.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('.f'); if (el && this.inLayer(el)) this.focus(el, { pointer: true, soft: el.tagName === 'INPUT' }); });
    root.addEventListener('click', (e) => { const el = e.target.closest && e.target.closest('.f'); if (el && this.inLayer(el)) { this.focus(el, { pointer: true, soft: el.tagName === 'INPUT' }); this.onEnter(el); } });
  }

  layer() { return this.layers.length ? this.layers[this.layers.length - 1] : this.root; }
  inLayer(el) { return this.layer().contains(el); }
  items() {
    // group tiles (HDMI): collapsed -> only the main tile; open -> only its sub-tiles
    return Array.prototype.filter.call(this.layer().querySelectorAll('.f'), (el) => !el.disabled && el.offsetParent !== null
      && !el.closest('.grp:not(.open) .gsubs') && !(el.classList.contains('gmain') && el.parentNode.classList.contains('open')));
  }

  pushLayer(el, first) { this.layers.push(el); this.prevs = (this.prevs || []).concat([this.cur]); this.focus(first || this.items()[0]); }
  popLayer() {
    this.layers.pop(); const prev = (this.prevs || []).pop();
    if (prev && document.contains(prev) && prev.offsetParent !== null) this.focus(prev); else this.focus(this.items()[0]);
  }

  focus(el, opt = {}) {
    if (!el || el === this.cur) return;
    if (this.cur) this.cur.classList.remove('focus');
    this.cur = el; el.classList.add('focus');
    if (opt.soft) { try { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); } catch (e) { /* */ } }
    else { try { el.focus({ preventScroll: true }); } catch (e) { /* */ } } // soft: highlight only (a text field would open the TV keyboard)
    this.onFocus && this.onFocus(el, opt);
  }

  move(dir) {
    const items = this.items();
    if (!this.cur || items.indexOf(this.cur) < 0) { this.focus(items[0]); return; }
    const a = this.cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === this.cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let main, cross, overlap;
      if (dir === 'left' || dir === 'right') {
        main = dir === 'left' ? a.left - b.right : b.left - a.right;
        if ((dir === 'left' ? bx >= ax : bx <= ax)) continue;
        overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlap <= 0) continue; // left/right stays in its row (end of row = stay)
        cross = Math.abs(by - ay) * 0.5;
      } else {
        main = dir === 'up' ? a.top - b.bottom : b.top - a.bottom;
        if ((dir === 'up' ? by >= ay : by <= ay)) continue;
        overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        cross = overlap > 0 ? Math.abs(bx - ax) * 0.3 : Math.abs(bx - ax);
      }
      const score = Math.max(0, main) + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) this.focus(best);
  }

  key(e) {
    const k = e.keyCode;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      if (k === KEY.BACKSPACE) return;
      if ((k === 37 || k === 39) && t.value) return; // move the caret inside a non-empty text field
      if (e.isComposing || k === 229) return;        // IME composition (LG keyboard Chinese input)
    }
    const dirs = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
    if (dirs[k]) { e.preventDefault(); this.move(dirs[k]); return; }
    if (k === KEY.ENTER) { e.preventDefault(); if (this.cur) this.onEnter(this.cur); return; }
    if (k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE) { e.preventDefault(); this.onBack(); }
  }
}
