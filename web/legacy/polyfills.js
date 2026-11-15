// Small polyfills for Chrome 53 (webOS 4.x). Only what tv-home uses or may soon use; syntax is lowered by esbuild.
/* eslint-disable no-extend-native */
if (!Promise.prototype.finally) {
  Promise.prototype.finally = function (fn) {
    return this.then((v) => Promise.resolve(fn()).then(() => v), (e) => Promise.resolve(fn()).then(() => { throw e; }));
  };
}
[Element.prototype, Document.prototype, DocumentFragment.prototype].forEach((p) => {
  if (!p.append) p.append = function () { for (let i = 0; i < arguments.length; i++) { const n = arguments[i]; this.appendChild(n instanceof Node ? n : document.createTextNode(String(n))); } };
});
if (!Element.prototype.replaceWith) Element.prototype.replaceWith = function (n) { if (this.parentNode) this.parentNode.replaceChild(n, this); };
if (!Object.fromEntries) Object.fromEntries = function (it) { const o = {}; for (const [k, v] of it) o[k] = v; return o; };
if (!Array.prototype.flat) Array.prototype.flat = function (d) { d = d === undefined ? 1 : d; return d < 1 ? this.slice() : this.reduce((a, x) => a.concat(Array.isArray(x) ? x.flat(d - 1) : x), []); };
if (!String.prototype.padStart) String.prototype.padStart = function (n, s) { let r = String(this); if (r.length >= n) return r; s = s == null ? ' ' : String(s); while (r.length < n) r = s + r; return r.slice(r.length - n); };
if (!Object.entries) Object.entries = function (o) { return Object.keys(o).map((k) => [k, o[k]]); };
if (!Object.values) Object.values = function (o) { return Object.keys(o).map((k) => o[k]); };
// HTMLImageElement.decode (Chrome 64) -> resolve on load
if (typeof HTMLImageElement !== 'undefined' && !HTMLImageElement.prototype.decode) {
  HTMLImageElement.prototype.decode = function () {
    const im = this;
    if (im.complete && im.naturalWidth) return Promise.resolve();
    return new Promise((res, rej) => { im.addEventListener('load', () => res()); im.addEventListener('error', () => rej(new Error('decode'))); });
  };
}

// mark the page (legacy.css keys off body.legacy); runs before app.js because imports evaluate in order
document.body.classList.add('legacy', 'lite');
