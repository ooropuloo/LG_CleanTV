// Simple line icons (24x24 viewBox, stroke = currentColor-ish via CSS). Generic glyphs, not brand logos.
const P = {
  play: '<rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="M10 9.2v5.6l4.8-2.8z" fill="#fff"/>',
  house: '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  tv: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M9 3l3 3 3-3"/>',
  hdmi: '<path d="M3 8h18v5l-3 3H6l-3-3z"/><path d="M7 11h10"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.4"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 6.8 11 3.8 3.8 0 0 0 7 18.5z"/>',
  rain: '<path d="M7 15h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 6.8 7.5 3.8 3.8 0 0 0 7 15z"/><path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"/>',
  storm: '<path d="M7 14h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 6.8 6.5 3.8 3.8 0 0 0 7 14z"/><path d="M12.5 14l-2 4h3l-2 4"/>',
  snow: '<path d="M7 14h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 6.8 6.5 3.8 3.8 0 0 0 7 14z"/><path d="M9 18h.01M12 20h.01M15 18h.01"/>',
  fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
};
export function icon(name, color) {
  return `<svg viewBox="0 0 24 24"${color ? ` style="stroke:${color}"` : ''}>${P[name] || P.grid}</svg>`;
}

// App 圖示(2026-11-15):自己畫的彩色 App 磚,64×64,圓角背景就在 SVG 裡。外觀仿各家 App 讓人一眼認得,只在自家電視用。
const R = (fill) => `<rect width="64" height="64" rx="15" fill="${fill}"/>`;
const G = (id, a, b) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>`;
const APP = {
  youtube: () => `${R('#fff')}<rect x="10" y="17" width="44" height="30" rx="9" fill="#ff0033"/><path d="M28 24.5v15l13-7.5z" fill="#fff"/>`,
  netflix: () => `${R('#000')}<path d="M21 11h8.5l5 26V11H43v42h-8.5l-5-26v26H21z" fill="#e50914"/><path d="M29.5 11 43 53h-8.5L21 11z" fill="#b20710"/>`,
  prime: () => `${G('gp', '#22c4ff', '#0a84c9')}<rect width="64" height="64" rx="15" fill="url(#gp)"/><text x="32" y="33" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="700" fill="#fff">prime</text><text x="32" y="47" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="10.5" font-weight="600" fill="#fff" letter-spacing=".5">video</text><path d="M17 38.5q15 6 30 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M44.5 36.2l3.4 2.1-3.6 1.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  ha: () => `${G('gh', '#41d0ff', '#1495d6')}<rect width="64" height="64" rx="15" fill="url(#gh)"/><path d="M32 12 12 31v20h40V31z" fill="#fff"/><g fill="none" stroke="#1aa7e6" stroke-width="2.6" stroke-linecap="round"><path d="M32 51V28M32 41l-7-7M32 36l7-6"/></g><g fill="#1aa7e6"><circle cx="32" cy="27" r="3.4"/><circle cx="24" cy="33" r="3.4"/><circle cx="40" cy="29" r="3.4"/></g>`,
  lghome: () => `${G('gl', '#c4074a', '#8a0030')}<rect width="64" height="64" rx="15" fill="url(#gl)"/><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="3.2"/><circle cx="25.5" cy="25" r="2.6" fill="#fff"/><path d="M31 21v19h6.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"/><path d="M38 32h9" stroke="#fff" stroke-width="3.2"/>`,
  livetv: () => `${G('gt', '#4a5874', '#2a3348')}<rect width="64" height="64" rx="15" fill="url(#gt)"/><rect x="11" y="19" width="42" height="28" rx="5" fill="none" stroke="#fff" stroke-width="3"/><path d="M24 11l8 8 8-8M24 52h16" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="27" r="3" fill="#ff3b30"/><text x="35" y="39" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="11" font-weight="800" fill="#fff">LIVE</text>`,
  hdmi: (n) => `${G('gd' + n, '#3c4760', '#232b3d')}<rect width="64" height="64" rx="15" fill="url(#gd${n})"/><path d="M13 18h38v9l-6 6H19l-6-6z" fill="none" stroke="#cfd8ea" stroke-width="2.8" stroke-linejoin="round"/><path d="M20 24h24" stroke="#cfd8ea" stroke-width="2.4" stroke-linecap="round"/><text x="32" y="54" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="800" fill="#fff">${n}</text>`,
  assist: () => `${G('ga', '#9b6bff', '#5b2fd6')}<rect width="64" height="64" rx="15" fill="url(#ga)"/><rect x="25" y="13" width="14" height="24" rx="7" fill="#fff"/><path d="M18 30a14 14 0 0 0 28 0M32 44v7M25 51h14" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M49 11l1.6 3.6 3.6 1.6-3.6 1.6L49 21.4l-1.6-3.6-3.6-1.6 3.6-1.6z" fill="#ffe08a"/>`,
  fireplace: () => `${G('gf', '#3b2418', '#160c08')}<rect width="64" height="64" rx="15" fill="url(#gf)"/><rect x="10" y="46" width="44" height="6" rx="3" fill="#5a3a28"/><path d="M32 9c3 8 12 12 12 24a12 12 0 0 1-24 0c0-6 3-9 5-12 1 5 3 6 5 7-2-7 0-13 2-19z" fill="#ff7a1a"/><path d="M32 22c2 6 7 8 7 14a7 7 0 0 1-14 0c0-3 2-5 3-7 1 3 2 4 3 4-1-4 0-8 1-11z" fill="#ffc23a"/><path d="M32 33c1 3 3 4 3 7a3 3 0 0 1-6 0c0-2 2-4 3-7z" fill="#fff3c4"/>`,
  settings: () => `${G('gs', '#8a93a8', '#555e74')}<rect width="64" height="64" rx="15" fill="url(#gs)"/><g transform="translate(12 12) scale(1.667)" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${P.gear}</g>`,
};
export function appIcon(app) {
  const k = app.key || '', m = /^hdmi(\d)$/.exec(k);
  const f = m ? () => APP.hdmi(m[1]) : k === 'hdmi' ? () => APP.hdmi('') : APP[k];
  return f ? `<svg class="appico" viewBox="0 0 64 64">${f()}</svg>` : null;
}
