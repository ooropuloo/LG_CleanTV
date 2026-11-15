// Legacy entry (old webOS / Chrome 53): polyfills, then the normal app with ./cat.js swapped for ./legacy/videocat.js.
// Built into app.legacy.js by `node dev/build_legacy.mjs` (esbuild, target chrome53). Do not load this file directly.
import './polyfills.js';
import '../app.js';
