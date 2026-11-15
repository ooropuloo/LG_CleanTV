# tv-home:做法決定(2026-11-15)

**自己做,借用 couch-tv 的幾個做法**(couch-tv = github.com/Seagey/couch-tv,MIT,讀的是 main `20f0159`)。
不 fork 的原因:LG 版沒有 Home Assistant(只有 Android 版有,且刻意不給車庫門/鎖)、場景只能放圖片/影片不能放程式、沒有開瀏覽器到 HA 的方法、沒有繁中、一個 4,865 行的 app.js 每天幾十個 commit。

## 架構
- **電視上**:一個很小的 webOS App(.ipk,Developer Mode 安裝),啟動後導到家裡主機上的網頁(hosted web app)。
  - packaged app 是 `file://`,module script 會被擋 → 介面放主機上用 http 提供(three.js 是 ES module)。
  - 主機連不到時顯示離線畫面,不可以黑屏。
- **主機上**(192.168.1.10,一直開著):一個小容器 `tv-home`
  - 提供首頁網頁與貓場景的靜態檔。
  - 代理 HA:token 只在容器裡,網頁拿不到;只允許白名單內的實體與動作。
  - 電視開機時自動打開首頁(用 HA 的 webostv 或自己連電視的 SSAP websocket 3001)。
  - 每天幫 Developer Mode 按 Extend(`ares-launch com.palmdts.devmode -p '{"extend":true}'`,session 1000 小時)。

## 平台事實
- webOS 26 = Chromium 132(25=120、24=108、23=94)。Re:New 升級會換新引擎(issue #89 回報)。WebGL2 未文件化,要實機測。
- webOS 26 起 `devicePixelRatio` 1(25 是 2)。
- 開 App:`luna://com.webos.applicationManager/launch {id, params}`(webOSDev.launch 是它的包裝)。webOS 26 Re:New 宣告 `requiredACG` 就會強制 ACG(launch 需要 `application.launcher`),webOS 27 必填。
- App id:YouTube `youtube.leanback.v4`(深連結 `params.contentTarget=https://www.youtube.com/tv?v=<id>`)、瀏覽器 `com.webos.app.browser`(`params.target=<url>`)、HDMI `com.webos.app.hdmi1`~`4`、電視 `com.webos.app.livetv`、LG 首頁 `com.webos.app.home`。
- 開別的 App 時 webOS 會關掉我們的 App,回來是冷啟動(1~3.7 秒)→ 首頁要啟動快。
- Back 鍵 keyCode 461。LG 時鐘螢幕保護約閒置 3 分鐘出現(couch-tv 未解)。
- webOS 26 待機時 couch-tv 的開機偵測會漏(issue #89),我們自己做要處理。

## 可借用(要保留 "Copyright (c) 2026 Seagey" 與 MIT 授權文字)
- `lg/build.py`:純 Python 打包 .ipk(`_tar_gz`、`_ar`、`pack_python`)。
- `lg/app/webos.js`:`luna()`(含 `held` 陣列避免被回收)、`launch()`、`extendDevMode()`、`webOSRelaunch` + `PalmSystem.activate()`。
- `lg/app/boot.html`:探測伺服器、離線退路、6 秒防黑屏。`lg/app/appinfo.json`。
- `bridge/lg.py`:`_handshake`、`PERMISSIONS`、`_watch`/`_hook`、`NOTHING` 正規式、`_back_to_couch`、`extend_devmode_now`、`check_devmode_left`。

## 實機要先測
`navigator.userAgent`、`devicePixelRatio`、`webgl2`、GPU 字串、貓的 fps;hosted 頁面裡 PalmServiceBridge 是否存在、launch 能不能用(有無 `requiredACG`);開 YouTube / 瀏覽器到 HA / HDMI;冷啟動時間;螢幕保護;待機後開機偵測;從主機容器 `ares-launch` Extend。
