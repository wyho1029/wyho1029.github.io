// bridge.js — 擴充功能嗰邊（ISOLATED world）：讀設定，傳畀 page.js
// page.js 喺網頁本身運行，用唔到 chrome.storage，所以靠 CustomEvent 傳 JSON 字串過去。
const DEFAULTS = { enabled: true, aheadMin: 0, keepWatched: true, overlay: true };

function sendSettings() {
  chrome.storage.local.get(DEFAULTS, s => {
    document.dispatchEvent(new CustomEvent('ytpb:settings', { detail: JSON.stringify(s) }));
  });
}

document.addEventListener('ytpb:hello', sendSettings);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') sendSettings(); });
sendSettings();
