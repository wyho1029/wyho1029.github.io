# YouTube 全片預載（Brave 插件）

睇 YouTube 時喺背後一路預載成條片，快進、倒後都唔使等。
安裝同「加大記憶體」教學：<https://wyho1029.github.io/yt-prebuffer/>

## 點運作

YouTube 網頁播放器用 SABR 串流：播放器 POST 一個 protobuf 去 `*.googlevideo.com/videoplayback?sabr=1`，
話畀伺服器知播到邊（`playerTimeMs`）同已經有咗邊幾段（`bufferedRanges`）；伺服器只會送播放位置前面一小段，
仲會用 `NEXT_REQUEST_POLICY` 話畀播放器知預載到幾遠就停。插件喺頁面（MAIN world）攔 `fetch`／`XMLHttpRequest`：

| 改咩 | 點改 |
|---|---|
| 播放器自己嘅上限 | 播放器每條軌最多預載 `min(預算 bytes ÷ 格式 byterate, 上限秒數)`：畫面 20MiB、聲音 8MiB、上限 120 秒（1080p 大約 70 秒）。插件喺 `base.js` 原始碼搵返呢幾個變數名（每版唔同），喺設定物件建立時換成 getter：開咗就回傳 4000MiB／300MiB／揀咗嘅秒數，熄咗就回傳原本數值；播放器撞記憶體上限時自己 ×0.8 照收 |
| 請求 | `playerTimeMs` 改做「影音兩邊由播放位置連續預載到嘅尾」（取細嗰邊），伺服器就由嗰度繼續送 |
| 回應 | `NEXT_REQUEST_POLICY` 嘅目標預載長度調高（只升唔降）；播放器用 `min(呢個目標, 自己上限)` 決定使唔使再要 |
| `SourceBuffer.remove` | 播放位置 10 秒之前嘅刪除唔做（照發 `updateend`），倒後唔使重新下載 |
| `appendBuffer` 撞 `QuotaExceededError` | 自動將預載長度收細，片上顯示「到咗記憶體上限」 |

直播、唔係睇片頁（例如首頁預覽）唔郁；任何一步解唔到都原封不動放行。
播放器嘅邏輯係用 2026 年 8 月版 `base.js`（854a788e，取自 NewPipeExtractor 測試資料）分析同實測。

Chromium 預設每條片只留 150MB 畫面 + 12MB 聲音，所以長片要用
`--mse-video-buffer-size-limit-mb` / `--mse-audio-buffer-size-limit-mb` 開 Brave（單位 MB，要細過 4096）。

## 檔案

```
extension/
  manifest.json   MV3
  sabr.js         UMP／protobuf 最細解碼同改寫（冇依賴，瀏覽器同 node 共用）
  page.js         MAIN world：攔 fetch／XHR／MSE，顯示進度
  bridge.js       ISOLATED world：讀 chrome.storage 設定，用 CustomEvent 傳畀 page.js
  popup.*         設定小視窗
tools/build.py    產生 icon、打包 yt-prebuffer.zip（改完 extension/ 要重新跑）
test/sabr.test.js node yt-prebuffer/test/sabr.test.js
```

除咗單元測試，開發時亦用 Playwright 開真 Chromium 載入插件、將 `www.youtube.com`／`*.googlevideo.com`
指去本機假伺服器試過：fetch（Uint8Array、Request、BYOB reader）、XHR、保留已睇部分、記憶體上限提示、
popup 開關都正常；亦用真 `base.js` 試過換上限、熄咗還原、撞記憶體上限時收細。
出問題可以喺 Console 打 `__ytpbStats()` 睇數字，或者 `copy(__ytpbDump())` 複製最近每個請求／回應嘅記錄，
`localStorage.ytpbDebug = '1'` 開詳細記錄。

協定欄位編號參考咗開源專案 [LuanRT/googlevideo](https://github.com/LuanRT/googlevideo)（MIT）。
