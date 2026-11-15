---
name: lg-cleantv-setup
description: Step-by-step installer and troubleshooter for LG_CleanTV (貓咪首頁) — a custom home screen for LG webOS TVs with an animated cat wallpaper, Home Assistant controls, an AI assistant and a self-hosted scene factory. Use when someone opened this repo and wants to install it, set up their LG TV (Developer Mode, .ipk), deploy the bridge to their home server, connect Home Assistant, support an old webOS 4.x TV, make or auto-generate cat scenes, or fix a problem with it ("裝起來", "設定", "電視沒畫面", "連不到", "LG 電視首頁").
---

# LG_CleanTV 安裝與排錯

用中文(使用者的語言)一步一步帶。**每一步做完都要驗證再往下**;使用者要動手的(電視遙控器、登入、按允許)講清楚按哪裡,然後等他回覆。

## 規則(先讀)
- **秘密不落地**:HA token、Gemini key、電視 Passphrase 只放 `bridge/.env`(git 忽略,chmod 600)或當次的環境變數。不要寫進其他檔案、不要印出來、不要 commit。`bridge/config.json`、`lg/.devkey/` 也都在 `.gitignore`。
- **不要替使用者輸入密碼或驗證碼**(LG 帳號、HA 登入);請他自己操作。
- 會影響別人的動作先問:重啟 Home Assistant、改 HA 設定檔、在主機上裝東西、動別的 Docker 容器。
- 自動控制裝置的 HA 自動化一律接一個 `input_boolean` 總開關,**預設關**,測好再讓使用者自己打開。
- 細節以 repo 內文件為準:`README.md`(安裝步驟)、`docs/DEVNOTES.md`(API、設定欄位)、`cats/README.md`、`cats/live/NOTES.md`、`factory/README.md`。

## 第 0 步:盤點(一次問完,記下來)
| 要知道 | 為什麼 |
|---|---|
| 電視型號、webOS 版本(設定 → 支援 → 電視資訊) | webOS 22+(Chromium 94+)走新版;webOS 4.x 走 legacy(見第 6 步) |
| 電視 IP(建議有線、路由器固定 IP) | App 安裝、HA 配對、允許控制的白名單 |
| 一台 24 小時開著的 Linux 主機(有 Docker)的 IP;可以就是跑 HA 那台 | bridge 跑在這裡 |
| Home Assistant 網址、能不能建長期存取權杖 | bridge 代理 HA |
| 要放上首頁的 HA 實體(燈、冷氣、門、攝影機、溫濕度、天氣…) | 寫進 `config.json` 白名單 |
| 要不要 AI 助手(需要 Gemini API key,免費版可) | 選配 |
| 要不要場景工廠(主機上要能裝 agy 並登入 Google 帳號) | 選配 |
| 開發用電腦:Python 3.10+、Node 18+、Chrome(舊電視錄影片還要 ffmpeg) | 打包、測試 |

## 第 1 步:電視開 Developer Mode(使用者動手)
1. 到 https://webostv.developer.lge.com/ 用 LG 帳號登入(一般 LG 帳號即可;建議用 Email+密碼註冊,電視上要用遙控器輸入)。
2. 電視「LG Content Store」搜尋安裝 **Developer Mode**,用同一帳號登入,**Dev Mode Status → ON**(電視會重開)。
3. 重開後再進 Developer Mode,**Key Server → ON**。請使用者回報畫面上的 **IP** 和 **Passphrase**(6 碼)。Remain Session 約 999 小時。
- 驗證:`curl -s -o /dev/null -w "%{http_code}" http://<電視IP>:9991/webos_rsa` 回 200;port 9922 開著。

## 第 2 步:在電腦上先跑模擬版(不碰電視、不碰 HA)
```bash
pip install -r bridge/requirements.txt
python bridge/server.py --mock          # 開 http://127.0.0.1:8790/  方向鍵/Enter/Esc 操作
```
- 驗證:瀏覽器看到時鐘、貓背景(沒有場景素材時是程式產生的備用背景)、App 列;`curl http://127.0.0.1:8790/api/health` 有 `"mock": true`。

## 第 3 步:主機部署 bridge
```bash
git clone <repo> /opt/tv-home && cd /opt/tv-home      # 或使用者指定的位置
cp bridge/.env.example bridge/.env && chmod 600 bridge/.env
cp bridge/config.example.json bridge/config.json
```
- `.env`:`HA_URL`、`HA_TOKEN`(請使用者在 HA 個人頁面建長期權杖,自己貼進去或用 `read -s` 輸入,不要經過對話)、`TV_IP`、選配 `GEMINI_API_KEY`。
- `config.json`:先用 REST 讀一次 HA 確認實體存在(`GET /api/states/<id>`,只讀),再把使用者的實體換進 `ui`、`entities`(允許的服務;車庫門等設 `"confirm": true`)、`cameras`(電池相機 `"battery": true`;Tapo 電池款加 `"wake_host": "<相機IP>:8800"`)、`apps`、`allow_call_from`。
- `sudo sh bridge/run.sh` → 容器 `tv-home`(--net=host,port 8790)。
- 驗證:`curl http://<主機IP>:8790/api/health` 回 `"ha": true, "mock": false`;`/api/states` 只看得到白名單實體。

## 第 4 步:打包並安裝電視 App
```bash
pip install paramiko
mkdir -p lg/.devkey && curl -o lg/.devkey/webos_rsa http://<電視IP>:9991/webos_rsa
python lg/build.py --bridge http://<主機IP>:8790 --version 0.1.0          # 新電視(含 requiredACG)
python lg/build.py --bridge http://<主機IP>:8790 --version 0.1.0 --no-acg # 舊電視 webOS 4.x
export TV_IP=<電視IP> TV_PASSPHRASE=<Passphrase>      # 只放環境變數
python lg/tvssh.py install build/lg/com.lgcleantv.home_0.1.0_all.ipk
python lg/tvssh.py launch com.lgcleantv.home
```
- 驗證:`curl http://<電視IP>:9998/json` 看到 `http://<主機IP>:8790/?tv=1`;`node dev/tvcdp.mjs shot tv.png`(設 `TV_IP`)截圖用 Read 看;`node dev/tvcdp.mjs eval "navigator.userAgent"`。
- 主機 IP 變了才要重打包;改介面只要更新主機上的 `web/`、`cats/`,電視重開 App。

## 第 5 步:Home Assistant
1. 加官方 **LG webOS TV** 整合(IP 填電視),請使用者在電視上按「允許」。
2. 建 `input_boolean`(例如 `tv_home_autolaunch`),預設關。
3. 把 `ha/automations.example.yaml` 的兩個自動化換成使用者的實體 id 後加入:開機 4 秒後(不是被 HDMI/Apple TV 喚醒)launch App;停在首頁 20 秒、距上次 >6 天就續期 Developer Mode。**改 HA 檔案前先備份、`check_config` 通過才 reload**。
4. 開 App 一律用 `webostv.command` + `system.launcher/launch {id}`,不要用 `media_player.select_source`(剛切過 App 時常找不到來源)。
- 驗證:HA 的 media_player 狀態 on、`source` 顯示「貓咪首頁」;使用者打開總開關後關機再開一次。

## 第 6 步:舊電視(webOS 4.x,Chrome 53,沒有 WebGL2)
- 首頁會自動改載 `web/legacy/app.legacy.js`(`?legacy=1` 可強制)。改過 `web/*.js` 要 `npm install`(只裝 esbuild)後 `node dev/build_legacy.mjs`。
- 背景是預錄循環影片 `cats/video/*.mp4`(repo 已附 8 個);新場景用 `node dev/record_loop.mjs` 錄(需要 Chrome + ffmpeg)。
- 限制:貓眼不會跟著焦點、沒有毛玻璃與動畫;自動生成的場景只有靜態圖。

## 第 7 步:貓場景
- **手做**:用任何生圖工具做 16:9 圖(貓在毯子/檯面後探頭、尾巴在左側和身體分開、眼睛睜開、左上 1/3 與右側 22% 暗而平靜、無文字)→ 複製一份 `rig.json` 標地標(`cats/live/tools/look.py` 放大找座標)→ `prep.py` / `prep_scene.py` → `thumbs.py` → 在 `config.json` 的 `scenes` 加一筆。步驟細節在 `cats/live/NOTES.md`。
- **檢查**:`node dev/shot.mjs out.png "dev/cat.html?style=<style>&coat=<pack>&t=3"`,加 `extremes=1`、`gaze=0.05,0.92`、`q=tv&bench=120`,每張都要用 Read 看圖。
- **屋主經驗**:不要做眨眼(看起來假);臉要整塊剛性移動(臉內變形會讓嘴巴歪);貓撲圖示預設關。

## 第 8 步(選配):場景工廠
- 主機要先裝好並登入 agy(使用者在真正的終端機自己登入),`agy --print "hello"` 可用。
- `sudo sh factory/run.sh build` → `sudo sh factory/run.sh test --no-publish` → 看產出的圖與 debug 圖 → `sudo sh factory/install-cron.sh`。
- 停用:`touch factory-data/DISABLED`。磁碟:剩 < 4 GB 不跑;生成場景 ≤ 30 個且 ≤ 300 MB。agy 免費生圖額度約十幾張就暫停數小時,工廠會跳過。
- agy 自己的對話/暫存會一直累積,建議加每日清理(只刪 2 天前的 conversations/brain/log,不碰登入憑證)。

## 排錯速查
| 症狀 | 原因 / 解法 |
|---|---|
| SSH 進電視被拒 | dropbear 只吃 ssh-rsa 簽章;用 `lg/tvssh.py`(已處理)。Passphrase 換過要重抓 key |
| 電視全黑 / 模組載不到 | App 是 file://,ES module 被擋 → 介面一定要由主機 http 提供(本專案已如此);確認主機 8790 連得到 |
| 顯示離線畫面 | 主機或容器沒開、IP 變了、防火牆擋 8790 |
| 按鈕沒反應(看得到狀態) | 該 IP 不在 `allow_call_from` / `TV_IP` |
| 開 App 失敗 | webOS 26 需 appinfo `requiredACG: ["application.launcher"]`;舊電視用 `--no-acg` 版 |
| 電視掉幀 | 大面積 `backdrop-filter`;電視上自動 `body.lite`,別加大 blur/陰影 |
| HA 連不到電視 | 電視 IP 變了 → webostv 整合「重新設定」改 host(不用重新配對) |
| App 被刪 | Developer Mode 1000 小時到期 → 用續期自動化或手動 Extend 後重裝 |
| 電池相機拍不到 | 深睡;設 `wake_host`,bridge 會每秒試連最多 15 秒喚醒 |
| AI 助手只會簡單指令 | 沒有 Gemini key 或免費額度用完 → 自動退回規則版;`GEMINI_MODELS` 可列多個模型 |
| 舊電視影片每圈卡一下 | 不要用 `<video loop>`;`videocat.js` 用 MediaSource 接續 |

## 完成檢查表
- [ ] 模擬版在電腦上正常
- [ ] `/api/health` 顯示 HA 已連線,白名單正確
- [ ] 電視開 App 看到首頁、60 fps(`dev/tvcdp.mjs` 量 requestAnimationFrame)
- [ ] 燈/冷氣可控制,車庫門需二次確認
- [ ] HA 配對完成、總開關打開後開機自動進首頁
- [ ] Developer Mode 續期自動化在
- [ ] (選配)AI 助手、場景工廠、舊電視影片
