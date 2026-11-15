# 第三方程式碼與授權

本專案整體以 GPL-3.0 授權(見 `LICENSE`);以下第三方程式碼保留各自的 MIT 授權與著作權聲明。

## three.js — MIT
`vendor/three.module.js`、`vendor/three.core.js`、`vendor/OrbitControls.js`、`vendor/BufferGeometryUtils.js` 來自
[three.js](https://github.com/mrdoob/three.js),MIT 授權,原文見 `vendor/LICENSE`(Copyright © 2010-2025 three.js authors)。

## couch-tv — MIT
部分做法改寫自 [couch-tv](https://github.com/Seagey/couch-tv)(main `20f0159`)。改寫的程式在檔案內保留了原始著作權與授權聲明:

- `lg/build.py`:`_tar_gz`、`_ar`、`pack_python`(純 Python 打包 webOS .ipk)。

參考(未複製程式碼、只參考做法):`lg/app/webos.js`(luna 呼叫、launch、Developer Mode extend)、`lg/app/index.html`
(開機頁探測伺服器、離線畫面)、`bridge/tv_power.py`(SSAP 設計筆記)。

```
MIT License

Copyright (c) 2026 Seagey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 其他
- 執行期相依(不隨附):aiohttp 等(`bridge/requirements.txt`)、numpy / scipy / opencv(`factory/Dockerfile`)、
  paramiko(`lg/tvssh.py`)、esbuild(`package.json` devDependency)。
- agy(Google Antigravity CLI)、Gemini API、YouTube 網頁由使用者自行取得與遵守其條款。
