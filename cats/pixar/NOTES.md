# 皮克斯風小貓(cats/pixar)

## progress

**狀態(02:30,完成)**:black 與 tabby 兩種花色都做完,所有最終截圖都在 `dev/shots/pixar/final_*.png`。迭代過程的截圖在 `dev/shots/pixar/wip/`。

## 做了什麼

全部程序化產生,沒有外部素材,不用 PMREM,光照自己算。

| 檔案 | 內容 |
|---|---|
| `index.js` | `meta`(`coats: ['black','tabby']`)、`createCatScene`:組場景、時段光線、全部動畫 |
| `build.js` | 幾何:頭(SDF → surface nets,耳朵併進同一個 mesh,在 shader 裡轉)、肩膀、前掌(四趾)、尾巴(參數化管子)、毯子(參數化 + 雜訊位移 + 貓掌壓出的凹陷)、鼻子、嘴、鬍鬚;毛色函式 `coatPalette()` |
| `shaders.js` | 毛(底層 + instanced 殼層,一次 draw call 畫完所有層)、眼睛、實體(鼻子/眼皮/嘴)、鬍鬚、背景 |
| `sdf.js` | SDF 形狀、smooth min/max、naive surface nets(頂點用牛頓法貼回表面,法線取 SDF 梯度) |
| `util.js` | seed 亂數(mulberry32)、value noise、分小步積分的彈簧 |
| `dev/gpu.html` | 自己的小測試頁:查無頭 Chrome 的 GPU(GTX 1660 Ti / ANGLE D3D11) |

### 外觀
- **毛**:每個毛面都是「底層(不透明)+ N 層殼(透明,instanced,`gl_InstanceID` 決定高度)」。一根一根的毛來自 64³ 的 3D 雜訊貼圖(R8,256 KB),在**未變形**的座標取樣,所以頭轉、尾巴擺時毛不會游動。毛長、密度、耳朵權重、透光量存在頂點屬性 `aFur`;眼睛、鼻子周圍的毛短,臉頰的毛蓬。輪廓光 = fresnel × 越外層越強,做出參考圖那圈藍色絨邊。毛有慣性(頭轉時毛尖落後,`uLag`)。
- **眼睛**(主角):球體 + fragment shader。光線在角膜折射(η=1/1.22)後打到虹膜平面,所以有景深視差;虹膜有兩層放射紋(繞一圈接得起來的週期雜訊)、瞳孔旁的亮環、深色角膜緣、下半部的聚光(光從上面進來)、被眉骨/眼皮擋到的上半部陰影;角膜用往前鼓的法線做兩個銳利的 catchlight(固定在相機空間,所以位置穩定)和 fresnel 環境反射。瞳孔大小依情緒/時段平滑變化。
- **眼皮**:真的幾何(球殼),繞眼球的水平軸轉,眨眼是眼皮閉合,不是把眼球壓扁;眼球 shader 依眼皮位置畫陰影。眼皮邊緣有深色眼線。
- **毯子**:參數化的捲布(稜線在螢幕 y≈0.69–0.71),雜訊位移出大波浪和毛團;殼層做捲毛團,斜看時淡掉以免出現殼層條紋;貓掌和下巴附近有假的接觸陰影(shader 裡依距離變暗)。
- **時段**:day / dusk / night 三組光線依小時平滑混合。夜裡:房間暗、月光從右上來、藍白輪廓光、瞳孔放大、眼睛的 catchlight 加強(眼睛會「抓到光」)、耳內透光跟著變暗。

### 動作(全部只看 `update(dt,t)` 與 seed)
- 注視:沒有 `setGaze` 時每 1.5–4 秒換目標(40% 看觀眾);眼睛用快的彈簧(ω=34)先到,頭用慢的(ω≈5,ζ=0.5 有一點過衝)跟上。`setGaze(x,y)` 把螢幕座標換成相機前方的點,頭轉約 70%,眼睛補剩下的。
- 眨眼 2.5–7 秒一次,20% 連眨兩下,大幅轉眼時常伴隨眨眼;想睡時眼皮下垂而且慢慢飄。
- 耳朵:左右各自 4–12 秒抖一下(低阻尼彈簧,會顫),會轉向注視方向;alert 往前,sleepy 往外垂。
- 尾巴:20 個骨架點,在 shader 裡用 Catmull-Rom 彎;靜止形狀是「?」;疊上從根部傳到尾端的波(延遲 1.5 秒)、慢速漂移、深度方向的擺動,以及偶發的尾尖甩動(脈衝沿尾巴傳下去)。
- 頭:閒置歪頭/點頭的雜訊,6–13 秒一次好奇地歪頭;呼吸 0.4–0.5 Hz(身體縮放、頭微動、鬍鬚和毛慢一點跟)。
- 前掌偶爾(20–40 秒)抬起來踩一下;哈欠(sleepy 時 16–30 秒一次):頭往上、眼睛瞇起、耳朵往後、嘴巴張開。
- `poke`:`blink`、`earTwitch`、`tailFlick`、`yawn`、`pawTap` 都有作用;其他字串會被忽略。

### 花色 `coat`
- `black`(預設):近黑的毛(帶藍色光澤)、琥珀色眼睛、暖粉橘的耳內透光、粉紅鼻子。
- `tabby`:同一個模型、同一套動畫,只換顏色函式與眼睛/鼻子參數。棕灰底色加每根毛的深淺(ticking)、額頭條紋 + M 字、頭頂往後的條紋、眼角往後的黑線和臉頰弧線、鬍鬚墊的小黑點、白下巴和上唇、黑色耳緣、淡粉耳內、環紋尾巴加黑尾尖、淺色前掌加橫紋、綠眼睛(黃綠內圈)、磚粉色鼻子(fresnel 深色描邊)。tabby 的輪廓光和光澤減半,條紋才不會被洗掉。

## 實測(這台筆電,GTX 1660 Ti;bench=120,每次跑會差 ±20%,筆電溫度影響很大)

| | tv black | tv tabby | desktop black | desktop tabby | 預算 tv / desktop |
|---|---|---|---|---|---|
| bench ms/frame | 2.34–3.00 | 2.70 | 4.16–4.98 | 5.76 | ≤ 4.0 / ≤ 10 |
| update JS ms | 0.11–0.12 | 0.13 | 0.08–0.12 | 0.17 | ≤ 0.5 |
| draw calls | 21 | 21 | 21 | 21 | ≤ 30 / ≤ 80 |
| 三角形/格(含所有殼層) | 225,054 | 225,054 | 1,464,172 | 1,464,172 | ≤ 250k / ≤ 1.5M |
| 貓的殼層數(最多的頭) | 10 | 10 | 26 | 26 | ≤ 12 / ≤ 40 |
| 毯子殼層數 | 5 | 5 | 10 | 10 | ≤ 6 / — |
| 建場景 ms | 330–580 | 340–580 | 520–860 | 620–670 | ≤ 2500 / ≤ 5000 |
| 貼圖記憶體 | 0.25 MB | | 0.25 MB | | ≤ 48 / ≤ 160 MB |

殼層數(tv / desktop):頭 10/26、身體 4/10、前掌 7/18、尾巴 8/20、毯子 5/10。沒有陰影貼圖、沒有後製、沒有額外的 render target。

## 可調參數
- `index.js` 的 `Q`:各部位殼層數、`furScale`(毛長)、`density`(毛的細度)、眼球細分、`shellAlpha`。
- `index.js` 的 `LOOKS`:三個時段的主光/補光/輪廓光/天地光/背景/鬍鬚/眼睛亮度/瞳孔加大量。
- `build.js` 的 `HEAD`、`NECK`、`EYE`、`EAR`、`PAW`:比例與位置;`coatPalette()`:毛色與條紋(每個部位一個函式,要加新花色就照 `tabbyPalette()` 加一個)。
- `CAT_X`(貓的水平位置)、`TAIL_BASE`、`TAIL_LEN`;`buildWhiskers` 裡鬍鬚的根數、長度、下垂。
- 網址加 `&dbg=1` 會在 console 印出每個 mesh 的三角形數 × 層數。

## 已知缺點
1. **毯子**比較像一團團的雲/棉花,不像參考圖那種密、捲的 fleece;稜線上還看得到一點點殼層的層次。
2. **近看的毛**(zoom 特寫)顆粒像海綿,是 3D 雜訊格子線性內插出來的;正常距離看起來還好。毛沒有真正的流向(只有很弱的 gravity/comb)。
3. **嘴**是細管,黑貓上幾乎看不到;tabby 特寫時嘴線會被毛切得鋸齒狀。鼻子特寫偏塑膠。
4. **tabby** 的 M 字只做出額頭條紋,M 的形狀不明顯;臉頰條紋偏淡;前掌的條紋大多在毯子後面。
5. 頭轉很大(看最左/最右的 App)時,側臉露出一大片沒有細節的黑/棕。
6. 即時播放(dt 不固定)時,事件時間點會跟固定步長的截圖不同(每次事件才抽亂數,所以同 dt 序列一定一樣;不同 dt 序列會不一樣)。

## 下一步建議
- 毯子:改成「毛團 = 少量 instanced 小球 + 殼層」或在殼層用捲曲的 2D 圖案(依稜線方向),做出 fleece 的捲毛。
- 毛:用 2D 的毛流向場(沿頭的切線)讓毛有方向;3D 雜訊改成每格一根的「點」圖案,特寫會乾淨很多。
- 嘴:加一點淡淡的上唇亮邊讓黑貓的嘴看得出來;tabby 的嘴改成畫在頂點色上。
- tabby:用更高解析度的頭網格或在 shader 裡算條紋(用頭的區域座標),條紋邊緣會更乾淨。

## 指令
```bash
cd LG_CleanTV      # 一次只跑一個
node dev/shot.mjs dev/shots/pixar/final_clean.png "dev/cat.html?style=pixar&t=2&gaze=0.5,0.42"
node dev/shot.mjs dev/shots/pixar/final_ui.png "dev/cat.html?style=pixar&t=3&gaze=0.365,0.92&ui=1"
node dev/shot.mjs dev/shots/pixar/final_sheet.png "dev/cat.html?style=pixar&sheet=8&t0=0&t1=7&poke=tailFlick@3;earTwitch@5"
node dev/shot.mjs dev/shots/pixar/final_eyes.png "dev/cat.html?style=pixar&t=2&gaze=0.5,0.42&zoom=0.36,0.3,0.3,0.3"
node dev/shot.mjs dev/shots/pixar/final_tv.png "dev/cat.html?style=pixar&q=tv&t=2&gaze=0.5,0.42&ui=1"
node dev/shot.mjs dev/shots/pixar/final_sleepy.png "dev/cat.html?style=pixar&mood=sleepy&t=6"
node dev/shot.mjs dev/shots/pixar/final_night.png "dev/cat.html?style=pixar&hour=22&t=2&gaze=0.5,0.42"
# tabby:同上加 &coat=tabby(final_tabby_clean / _ui / _eyes / _tv)
node dev/shot.mjs dev/shots/pixar/wip/b.png "dev/cat.html?style=pixar&q=tv&bench=120"
```

## harness 方面
- 沒改 `dev/cat.html`、`dev/shot.mjs`。`zoom=` 用 `setViewOffset`,所以注視點的換算不用 `projectionMatrixInverse`(自己用 fov/aspect 算),特寫時貓看的方向才不會變。
- bench 數字在筆電上每次跑差 ±20%(溫度),表格是多次的範圍。
