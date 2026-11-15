// 自動生成的場景(活圖 v2):主機上的場景工廠(../../factory/)產生的 pack,每個 pack = 一個 coat(資料夾名 = id)。
// 清單在 ./scenes.json(工廠原子更新;bridge 也把它併進 /api/config 的 scenes),頁面載入時讀一次。
// 每個 pack 自帶 motion.json(依姿勢:探頭貓 / 睡貓 / 女孩+貓),引擎同 heroine-live / tabby-scenes-live(../live/engine2.js)。
import { createRigScene } from '../live/engine2.js';

let list = [];
try {
  const r = await fetch(new URL('./scenes.json', import.meta.url), { cache: 'no-store' });
  if (r.ok) list = ((await r.json()).scenes || []).filter((s) => s && /^[\w-]+$/.test(s.coat || ''));
} catch (e) { /* no generated scenes yet */ }

export const meta = {
  id: 'gen-live', name: '自動生成場景(活圖)', coats: list.map((s) => s.coat),
  renderer: { antialias: false, toneMapping: 'None', exposure: 1, shadows: false },
};

export async function createCatScene({ renderer, quality, aspect, seed, coat }) {
  if (!/^[\w-]+$/.test(coat || '') || meta.coats.indexOf(coat) < 0) throw new Error(`gen-live: no pack ${coat}`);
  const base = new URL(`./${coat}/`, import.meta.url);
  const motion = await fetch(new URL('motion.json', base), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('motion.json'); return r.json(); });
  return createRigScene({ renderer, quality, aspect, seed, base: new URL('assets/', base), motion });
}
