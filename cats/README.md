# tv-home 貓場景:共用契約

LG 電視(QNED81,2023 年機種,webOS 26)自訂首頁的 3D 背景。畫面 16:9,人坐在約 3 公尺外看。
首頁 UI(時鐘、天氣、家裡狀態、App 列)會疊在場景上面,所以構圖要讓位給 UI。

兩種畫風各一個資料夾,介面相同,首頁可以隨時切換:

| 資料夾 | 畫風 |
|---|---|
| `cats/pixar/` | 皮克斯風:造型誇張可愛、大眼睛、柔軟絨毛 |
| `cats/real/` | 擬真風:真實貓的比例與解剖、看得到毛流、自然光 |

主角都是:**一隻黑色小貓,琥珀色眼睛,從柔軟的毯子/檯面後面探頭,一隻前掌搭在邊上,尾巴在畫面左側擺動**。
參考圖 `dev/ref/ref_cat_launcher.jpg`(只參考氛圍與構圖,要做自己的原創版本,不要照抄)。

## 介面

```js
// cats/<style>/index.js(可再拆檔,但都放在自己的資料夾裡)
import * as THREE from 'three';          // 由頁面的 import map 指到 vendor/three.module.js(r180)

export const meta = {
  id: 'pixar', name: '皮克斯風',
  // 也可以寫成 (quality) => ({...})
  renderer: { antialias: true, toneMapping: 'ACESFilmic', exposure: 1.0, shadows: false, shadowType: 'PCFSoft' },
};

export function createCatScene({ renderer, quality, aspect, seed, coat }) {   // 可以是 async
  return {
    scene, camera,                 // THREE.Scene / THREE.PerspectiveCamera;外面只做 renderer.render(scene, camera)
    update(dt, t),                 // dt 秒(≤0.1),t = 模擬開始後的秒數。所有動畫只能由這兩個值和 seed 決定
    resize(aspect),
    setGaze(x, y),                 // 要貓看的螢幕位置,0~1、左上為原點(例如目前選到的 App 圖示);setGaze(null) 回到自己東張西望
    setMood(name),                 // 'awake'(預設)| 'sleepy' | 'alert'
    setHour(h),                    // 0~24,依時段調整光線氣氛(白天 / 傍晚 / 深夜)
    poke(kind),                    // 立即觸發一次:'blink' | 'earTwitch' | 'tailFlick' | 'yawn' | 'pawTap';不認得的忽略
    dispose(),
  };
}
```

- `quality`:`'tv'`(畫布 1280×720)或 `'desktop'`(1920×1080)。
- `coat`(花色,2026-11-15 新增):`'black'`(預設,黑貓、琥珀色眼睛)或 `'tabby'`(屋主家的貓:棕色虎斑、綠眼睛、白下巴)。
  參考照片 `dev/ref/mycat_1.jpg`、`dev/ref/mycat_2.jpg`;風格目標圖 `dev/ref/gen/pixar_tabby_a.png`、`dev/ref/gen/real_tabby_a.png`。
  `meta.coats` 列出支援的花色,例如 `['black', 'tabby']`。不認得的值當成 `'black'`。預覽用 `coat=tabby`。
- `renderer` 已依 `meta.renderer` 設好色調映射與陰影;建場景時可以拿它做一次性的 PMREM 或烘焙貼圖。
- **可重現**:`update` 裡不可用 `Date.now()`、`performance.now()`、`Math.random()`、計時器。隨機一律用 `seed` 做的亂數產生器,事件用模擬時間 `t` 排程。同樣的 seed 模擬到同樣的 t,畫面要一樣(截圖才能比較)。
- `setGaze`、`setMood`、`setHour`、`poke` 至少要存在且不出錯;做得到的都做。

## 構圖(螢幕座標 0~1,左上為原點)

| 區域 | 範圍 | 要求 |
|---|---|---|
| 時鐘/天氣/日期(白字) | x 0–0.30,y 0–0.33 | 背景要暗、平靜、低細節;貓耳朵不要伸進來 |
| 左側資訊卡(半透明) | x 0.01–0.18,y 0.34–0.54 | 尾巴盡量落在 x 0.18–0.34 之間 |
| 右上快捷列 | x 0.80–0.99,y 0.03–0.10 | 背景平靜 |
| 右側面板(半透明) | x 0.78–1.0,y 0.20–0.56 | 後面不要放重要的東西 |
| App 列 | y 0.86–0.99,整排 | 毯子/檯面要蓋住畫面下方約 28%(上緣在 y 0.68–0.74),App 列像是放在毯子上 |
| 貓 | 頭中心 x 0.50–0.54,眼睛 y 0.40–0.52 | 前掌搭在毯子邊(y 0.70–0.84),要露在 App 列上方 |

用 `ui=1` 疊上假 UI 檢查。

## 動作(「會擺動、真實一點」)

- **尾巴**:至少 8 節的骨架或沿曲線彎曲;波從根部傳到尾端(尾端落後),疊上慢速漂移與偶發的尾尖甩動;不可以是單純的正弦週期。
- **耳朵**:左右各自隨機抖動(4~12 秒一次),會微微轉向注視的方向。
- **眼睛**:用眼皮閉合來眨眼(不是把眼球壓扁),間隔 2.5~7 秒,偶爾連眨兩下;視線每 1.5~4 秒換一個目標,眼睛先快速轉過去,頭慢一拍跟上;瞳孔大小隨情緒/光線平滑變化。
- **呼吸**:每秒 0.4~0.6 次的細微起伏;毛和鬍鬚慢一點跟上。
- **頭**:閒置時微微歪頭、點頭;偶爾好奇地歪一下。
- **前掌**:偶爾踩一下(很少)。
- 皮克斯風可以誇張一點(預備動作、過衝);擬真風要慢、細微、自然。

## 效能預算

電視晶片比電腦慢很多,而且毛的多層繪製很吃填色率。**兩種品質都要做,並且都要量。**

| | `tv` | `desktop` |
|---|---|---|
| 畫布 | 1280×720 | 1920×1080 |
| `bench` 每格(這台電腦;空場景約 1.3 ms) | ≤ 4.0 ms | ≤ 10 ms |
| draw call | ≤ 30 | ≤ 80 |
| 每格送出的三角形(毛的每一層都算) | ≤ 250k | ≤ 1.5M |
| 貓身上的毛層數 | ≤ 12(毯子另計 ≤ 6) | ≤ 40 |
| 即時陰影貼圖 | 不可(用假的接觸陰影/烘焙) | 可,一盞燈 |
| 後製 pass / 每格額外的 render target | 不可 | 盡量不要 |
| 建場景時間(這台電腦) | ≤ 2.5 秒 | ≤ 5 秒 |
| `update` 的 JS 時間 | ≤ 0.5 ms,不在每格配置新物件 | 同左 |
| 貼圖記憶體 | ≤ 48 MB | ≤ 160 MB |

## 限制

- 不可下載任何外部素材、不可連網;模型、貼圖、環境光全部用程式產生(canvas、DataTexture、PMREM.fromScene 都可以)。
- 只 import `three`(需要 `vendor/BufferGeometryUtils.js` 也可以,用相對路徑)和自己資料夾裡的檔案。
- 目標瀏覽器是電視上的 Chromium(版本還不確定,先當成 Chrome 94):WebGL2 / GLSL ES 3.00;不要用比 Chrome 94 新的 JS API(例如 `Array.prototype.at`、`structuredClone`、`findLast`);不要依賴浮點 render target。
- 只能寫自己的資料夾(`cats/<style>/`)和 `dev/shots/<style>/`。`dev/cat.html`、`dev/shot.mjs`、`vendor/`、這份 README 不要改;需要 harness 沒有的功能,就在自己的資料夾放自己的測試頁,並寫進 NOTES.md。

## 預覽與截圖

```bash
cd LG_CleanTV
node dev/shot.mjs dev/shots/pixar/a.png "dev/cat.html?style=pixar&t=3&ui=1"          # 模擬到第 3 秒、疊 UI
node dev/shot.mjs dev/shots/pixar/s.png "dev/cat.html?style=pixar&sheet=8&t0=0&t1=4"  # 8 張連續畫面看動作
node dev/shot.mjs dev/shots/pixar/e.png "dev/cat.html?style=pixar&t=3&zoom=0.3,0.25,0.4,0.4"  # 特寫
node dev/shot.mjs dev/shots/pixar/b.png "dev/cat.html?style=pixar&q=tv&bench=120"     # 量每格毫秒
```

- 其他參數:`q=tv|desktop`、`gaze=x,y`、`mood=`、`hour=`、`poke=blink@2;earTwitch@3.5`、`seed=`、`info=0`。說明在 `dev/cat.html` 開頭。
- `shot.mjs` 自帶伺服器與逾時,結束時會清掉自己開的 Chrome。**一次只跑一個**,跑完再跑下一個(這台是筆電,同時跑會過熱)。
- 截圖用 Read 工具直接看圖。每一輪都要看圖、找出最明顯的問題、修正,不要只看數字。

## 交付

- `cats/<style>/index.js`(與拆出去的檔案)。
- `cats/<style>/NOTES.md`:做了什麼、可調參數、兩種品質的實測數字(bench、draw call、三角形、毛層數、建場景時間)、已知缺點、下一步建議。
- `dev/shots/<style>/` 裡的最終截圖:`final_clean.png`、`final_ui.png`、`final_sheet.png`、`final_eyes.png`(眼睛特寫)、`final_tv.png`(`q=tv`)、`final_sleepy.png`、`final_night.png`。
