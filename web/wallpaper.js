// 固定時間換桌布: scenes + schedule (pure functions, no DOM).
// A scene = {id, name, style (module folder under cats/), coat (pack id inside it), params?}.
// config.wallpaper_schedule:
//   {mode: "schedule", entries: [{from: "06:30", scene: "<id>", days?: [0..6]}]}   (0 = Sunday)
//   {mode: "rotate_daily", scenes?: ["<id>", ...], at?: "06:00"}                   one scene per day, cycling
//   a bare list of entries is accepted as mode "schedule"; an entry may give {style, coat} instead of scene.

export function hm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null;
}
export const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Scene list from config; without one, every style × coat. */
export function sceneList(cfg) {
  if (Array.isArray(cfg.scenes) && cfg.scenes.length) return cfg.scenes.filter((s) => s && s.id && s.style);
  const out = [];
  for (const st of cfg.styles || []) for (const c of ['tabby', 'black']) out.push({ id: `${st}-${c}`, name: `${st} · ${c}`, style: st, coat: c });
  return out;
}

function entryScene(scenes, e) {
  if (e.scene) return scenes.find((s) => s.id === e.scene) || null;
  if (e.style) return scenes.find((s) => s.style === e.style && (s.coat || 'black') === (e.coat || 'black')) || { id: `${e.style}-${e.coat || 'black'}`, name: `${e.style} · ${e.coat || 'black'}`, style: e.style, coat: e.coat || 'black', params: e.params };
  return null;
}

export function normSchedule(ws) {
  if (!ws) return null;
  if (Array.isArray(ws)) return { mode: 'schedule', entries: ws };
  return ws;
}

/** -> {scene, since: Date, next: Date|null, mode, rows: [{from, scene, active}]} or null (no schedule). */
export function scheduled(cfg, now) {
  const scenes = sceneList(cfg), ws = normSchedule(cfg.wallpaper_schedule);
  if (!ws || !scenes.length) return null;
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (d, min) => new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + d, 0, min);
  if (ws.mode === 'rotate_daily') {
    const list = (ws.scenes || []).map((id) => scenes.find((s) => s.id === id)).filter(Boolean);
    const pool = list.length ? list : scenes;
    const m = hm(ws.at) || 0;
    let since = at(0, m); if (since > now) since = at(-1, m);
    const dayNo = Math.round((Date.UTC(since.getFullYear(), since.getMonth(), since.getDate())) / 864e5);
    const scene = pool[((dayNo % pool.length) + pool.length) % pool.length];
    return { mode: 'rotate_daily', scene, since, next: new Date(since.getFullYear(), since.getMonth(), since.getDate() + 1, 0, m),
      rows: [{ from: fmt(since), scene, active: true }] };
  }
  const entries = (ws.entries || []).map((e) => ({ min: hm(e.from), days: Array.isArray(e.days) ? e.days : null, scene: entryScene(scenes, e), from: e.from }))
    .filter((e) => e.min != null && e.scene).sort((a, b) => a.min - b.min);
  if (!entries.length) return null;
  let cur = null, next = null;
  for (let d = -7; d <= 8; d++) {
    const wd = at(d, 0).getDay();
    for (const e of entries) {
      if (e.days && e.days.indexOf(wd) < 0) continue;
      const t = at(d, e.min);
      if (t <= now) { if (!cur || t > cur.t) cur = { t, e }; } else if (!next || t < next.t) next = { t, e };
    }
  }
  if (!cur) return null;
  const today = now.getDay();
  const rows = entries.filter((e) => !e.days || e.days.indexOf(today) >= 0).map((e) => ({ from: e.from, scene: e.scene, active: e === cur.e }));
  return { mode: 'schedule', scene: cur.e.scene, since: cur.t, next: next ? next.t : null, rows };
}

// ---------------------------------------------------------------- random takeovers (e.g. the heroine)
// config.wallpaper_schedule.random: [{scene, between: ["07:00","17:00"], chance: 0.12, min_minutes: 20, max_minutes: 45,
//   max_per_day?: 2, gap_minutes?: 60, days?: [0..6]}], config.wallpaper_schedule.check_minutes (default 15), .seed (optional).
// At every check slot inside the window we roll (seeded per day + rule + slot, so it is reproducible and testable)
// whether the scene takes over for a random duration; afterwards the regular schedule comes back.
function hash32(str) { // xmur3 + mulberry32 -> [0,1)
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
  let a = h >>> 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** All takeovers of the day that contains `day` (local): [{scene, from: Date, until: Date, rule}] in time order. */
export function randomPlan(cfg, day) {
  const ws = normSchedule(cfg.wallpaper_schedule), scenes = sceneList(cfg);
  if (!ws || !Array.isArray(ws.random) || !ws.random.length) return [];
  const step = Math.max(1, +ws.check_minutes || 15), seed = ws.seed != null ? String(ws.seed) : '';
  const d0 = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const out = [];
  ws.random.forEach((r, ri) => {
    const sc = scenes.find((s) => s.id === r.scene); if (!sc) return;
    if (Array.isArray(r.days) && r.days.indexOf(d0.getDay()) < 0) return;
    const b = r.between || ['00:00', '23:59'], a = hm(b[0]), e = hm(b[1]);
    if (a == null || e == null) return;
    const end = e > a ? e : e + 1440;                       // a window may run past midnight
    const lo = Math.max(1, +r.min_minutes || 20), hi = Math.max(lo, +r.max_minutes || lo);
    const maxN = r.max_per_day != null ? +r.max_per_day : 3, gap = r.gap_minutes != null ? +r.gap_minutes : 0;
    let n = 0, free = a;
    for (let m = a; m < end && n < maxN; m += step) {
      if (m < free) continue;
      const key = `${seed}|${dayKey(d0)}|${ri}|${m}`;
      if (hash32(key) >= (r.chance != null ? +r.chance : 0.1)) continue;
      const dur = Math.round(lo + (hi - lo) * hash32(key + '|d'));
      const stop = Math.min(end, m + dur);
      out.push({ scene: sc, from: new Date(d0.getTime() + m * 60000), until: new Date(d0.getTime() + stop * 60000), rule: ri });
      n++; free = stop + gap;
    }
  });
  return out.sort((x, y) => x.from - y.from);
}

/** The takeover active at `now` (checks today and yesterday, for windows past midnight) or null. */
export function randomActive(cfg, now) {
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  for (const p of randomPlan(cfg, y).concat(randomPlan(cfg, now))) if (p.from <= now && now < p.until) return p;
  return null;
}

// ---------------------------------------------------------------- generated scenes (scene factory, cats/gen-live)
// config.wallpaper_schedule.generated: {chance: 0.35, new_chance: 0.8, new_days: 2, recent_days: 30}
// Scenes with {gen: true, tod, created} (merged in by the bridge) may take over a regular schedule slot:
// per slot (day + slot start) a seeded roll decides, so the choice is stable for the whole slot and testable.
// Only scenes whose time of day fits the slot are used (night slot: sleeping-cat scenes only); a scene
// generated in the last `new_days` days gets a high chance (`new_chance`) so a fresh scene shows up soon.
const TOD_FIT = [[5, 10, ['morning', 'day']], [10, 17, ['day', 'morning', 'rain']], [17, 23, ['dusk', 'night', 'rain']], [23, 29, ['sleep']]];
export function todFits(hour) {
  const h = hour < 5 ? hour + 24 : hour;
  for (const [a, b, l] of TOD_FIT) if (h >= a && h < b) return l;
  return [];
}
/** The generated scene replacing the schedule slot that started at `since`, or null. */
export function genPick(cfg, since, now) {
  const ws = normSchedule(cfg.wallpaper_schedule), g = ws && ws.generated;
  if (!g || g.enabled === false || !since) return null;
  const at = now || since;
  const ageD = (s) => { const t = Date.parse(s.created || ''); return isNaN(t) ? 999 : (at.getTime() - t) / 864e5; };
  const fits = todFits(since.getHours() + since.getMinutes() / 60);
  const pool = sceneList(cfg).filter((s) => s.gen && fits.indexOf(s.tod) >= 0 && ageD(s) >= 0 && ageD(s) <= (g.recent_days || 30));
  if (!pool.length) return null;
  const key = `${ws.seed != null ? ws.seed : ''}|gen|${dayKey(since)}|${since.getHours()}:${since.getMinutes()}`;
  const fresh = pool.filter((s) => ageD(s) <= (g.new_days != null ? g.new_days : 2)).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  if (fresh.length && hash32(key + '|new') < (g.new_chance != null ? g.new_chance : 0.8)) return fresh[0];
  if (hash32(key) >= (g.chance != null ? g.chance : 0.35)) return null;
  return pool[Math.floor(hash32(key + '|pick') * pool.length) % pool.length];
}
