// popup.js — 設定小視窗：改完即刻寫入 chrome.storage，bridge.js 會自動傳去 YouTube 分頁
const DEFAULTS = { enabled: true, aheadMin: 0, keepWatched: true, overlay: true };
const $ = id => document.getElementById(id);

chrome.storage.local.get(DEFAULTS, s => {
  for (const k of ['enabled', 'keepWatched', 'overlay']) $(k).checked = s[k];
  $('aheadMin').value = String(s.aheadMin);
});

for (const k of ['enabled', 'keepWatched', 'overlay']) {
  $(k).addEventListener('change', () => chrome.storage.local.set({ [k]: $(k).checked }));
}
$('aheadMin').addEventListener('change', () => chrome.storage.local.set({ aheadMin: Number($('aheadMin').value) }));
