// 股票回測用嘅重播輔助（瀏覽器 + Node 共用）。瀏覽器出全域 Replay；Node 用 module.exports。
//
// 純 view-model，冇 DOM：讀數（入場價／現價／升跌／持有月數／回撤）、可見視窗、盲測洗牌、相對月份標籤。
// bars = {t,o,h,l,c,v}（同 Ind 一樣，全部等長陣列）；sig = 轉黃訊號月嘅位置；last = 已推進到嘅最後一支。
var Replay = (function () {
  'use strict';

  // 讀數。入場價 = 訊號月下一個月嘅 open，所以 bars 要傳成串，唔好用 Ind.head 截過
  // （截咗，訊號月就變成「最後一支」，會誤判做 pending）。三種 state：
  //   pending —— 訊號就係最後一支已完成月，下個月未開市，未有入場價；
  //   start   —— last === sig，仲未推進，只有入場價；
  //   run     —— 已推進：cur = c[last]，pct = 相對入場價嘅升跌 %，held = 持有咗幾多個月，
  //              dd = 入場後最低價 min(l[sig+1..last]) 相對入場價嘅跌幅 %（負數）；冇跌穿入場價就係 null。
  function readout(bars, sig, last) {
    if (sig + 1 >= bars.o.length) return { state: 'pending' };
    const entry = bars.o[sig + 1];
    if (last === sig) return { state: 'start', entry };
    const cur = bars.c[last];
    let lo = Infinity;
    for (let i = sig + 1; i <= last; i++) if (bars.l[i] < lo) lo = bars.l[i];
    return { state: 'run', entry, cur, pct: (cur / entry - 1) * 100, held: last - sig,
             dd: lo < entry ? (lo / entry - 1) * 100 : null };
  }

  // 視窗：已見K線最多 past 支（包括 last），歷史唔夠就由 0 開始
  function windowRange(last, past = 96) {
    return { from: Math.max(0, last - past + 1), to: last };
  }

  // mulberry32：32-bit seeded PRNG，每次出 [0,1)
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 0..n-1 嘅排列：Fisher–Yates（由後向前）+ mulberry32，同一個 seed 永遠出同一個排列（盲測清單洗牌用）
  function shuffle(n, seed) {
    const a = Array.from({ length: n }, (_, i) => i), rnd = mulberry32(seed);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 相對訊號月嘅標籤：訊號月「轉黃」，之後 +k，之前 −k（負號係 U+2212，唔係 ASCII 連字號）
  function relLabel(i, sig) {
    return i === sig ? '轉黃' : i > sig ? '+' + (i - sig) : '−' + (sig - i);
  }

  return { readout, windowRange, shuffle, relLabel };
})();

if (typeof module !== 'undefined') module.exports = Replay;
