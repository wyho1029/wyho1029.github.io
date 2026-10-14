// 股票回測用嘅 TDX 指標引擎（瀏覽器 + Node 共用）。瀏覽器出全域 Ind；Node 用 module.exports。
//
// 逐行照 Stock/scanner/indicators.py 嘅 compute_indicators（FCOLOR、CHAODI、MCDXX、HDLY），
// 連 pandas 嘅 NaN 處理都復刻 —— 之後會逐月同 Python 輸出對數（color/td/buymore 要完全一樣，
// 數值 ≤ 1e-9·max(1,|py|)，NaN 位置一樣）。所以 ewm / rolling 唔係「大概啱」，係照 pandas 內部算法行。
// 另加 Python 冇嘅 HDLY（VAR51、buyless）同 CHAODI（blue、icon）。
// bars = {t,o,h,l,c,v}，全部等長陣列；輸出全部係普通 Array，唔改動輸入。
var Ind = (function () {
  'use strict';

  const isNum = x => typeof x === 'number';

  // ---------------------------------------------------------------------------
  // pandas 行為復刻
  // ---------------------------------------------------------------------------

  // Series.ewm(adjust=False, ignore_na=False).mean()，照 pandas aggregations.pyx 嘅 ewm：
  // 開頭 NaN 照出 NaN，第一個有效值做種子；中途 NaN 令舊權重衰減但值唔郁；常數序列唔會有浮點誤差。
  // pandas 怪癖：com==1（alpha=0.5，即 EMA(x,3)）時，每步衰減後新權重改用 1-舊權重（有 NaN 缺口先睇得出分別）。
  function ewm(x, com) {
    const a = 1 / (1 + com), f = 1 - a, out = new Array(x.length);
    let w = NaN, ow = 1, nw = a;
    for (let i = 0; i < x.length; i++) {
      const cur = x[i], obs = cur === cur;
      if (w === w) {
        ow *= f;
        if (com === 1) nw = 1 - ow;
        if (obs) { if (w !== cur) w = (ow * w + nw * cur) / (ow + nw); ow = 1; }
      } else if (obs) w = cur;
      out[i] = w;
    }
    return out;
  }

  // alpha 嘅換算都照 pandas：span=n → com=(n-1)/2；alpha=m/n → com=(1-alpha)/alpha；最後 alpha=1/(1+com)
  const EMA = (x, n) => ewm(x, (n - 1) / 2);
  const SMA = (x, n, m) => { const a = m / n; return ewm(x, (1 - a) / a); };

  // rolling(n, min_periods=1).mean()，照 pandas roll_mean：窗口滑動時逐個加減（Kahan 補償），
  // 跳過 NaN；而且「窗口入面所有有效值都相同」就直接回嗰個值 —— 否則平價窗口會有 ±1ulp 雜訊，
  // CCI 嘅 (typ-MA)/AVEDEV 就會變 0/0 式嘅 ±67。全正（全負）數出負（正）結果就當 0（pandas 同款）。
  function MA(x, n) {
    const N = x.length, out = new Array(N);
    const neg = v => v < 0 || Object.is(v, -0);
    let sum = 0, cAdd = 0, cRem = 0, nobs = 0, negCt = 0, same = 0, prev = NaN;
    const add = v => {
      if (v === v) {
        nobs++;
        const y = v - cAdd, t = sum + y;
        cAdd = t - sum - y; sum = t;
        if (neg(v)) negCt++;
        same = v === prev ? same + 1 : 1; prev = v;
      }
    };
    const rem = v => {
      if (v === v) {
        nobs--;
        const y = -v - cRem, t = sum + y;
        cRem = t - sum - y; sum = t;
        if (neg(v)) negCt--;
      }
    };
    for (let i = 0; i < N; i++) {
      const s = Math.max(0, i + 1 - n);
      if (i === 0 || s >= i) {              // 開頭，或者 n=1（窗口冇重疊）：由頭起窗
        sum = cAdd = cRem = 0; nobs = negCt = same = 0; prev = x[s];
        for (let j = s; j <= i; j++) add(x[j]);
      } else {
        for (let j = Math.max(0, i - n); j < s; j++) rem(x[j]);
        add(x[i]);
      }
      let r = nobs > 0 ? sum / nobs : NaN;
      if (nobs > 0) {
        if (same >= nobs) r = prev;
        else if ((negCt === 0 && r < 0) || (negCt === nobs && r > 0)) r = 0;
      }
      out[i] = r;
    }
    return out;
  }

  // rolling(n, min_periods=1).min()/.max()：跳過 NaN；窗口入面冇有效值就 NaN
  function winExt(x, n, better) {
    const out = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let m = NaN;
      for (let j = Math.max(0, i + 1 - n); j <= i; j++) {
        const v = x[j];
        if (v === v && (m !== m || better(v, m))) m = v;
      }
      out[i] = m;
    }
    return out;
  }
  const LLV = (x, n) => winExt(x, n, (a, b) => a < b);
  const HHV = (x, n) => winExt(x, n, (a, b) => a > b);

  // numpy 嘅 pairwise 加法（np.add.reduce）：n<8 逐個加；n≤128 用 8 個累加器；再大就對半拆。
  // AVEDEV 靠 np.mean，照住呢個次序加先會同 numpy 逐 bit 一樣。
  function psum(a, lo, n) {
    if (n < 8) {
      let r = 0;
      for (let i = 0; i < n; i++) r += a[lo + i];
      return r;
    }
    if (n <= 128) {
      const r = a.slice(lo, lo + 8);
      let i = 8;
      for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[lo + i + j];
      let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
      for (; i < n; i++) res += a[lo + i];
      return res;
    }
    let n2 = n >> 1;
    n2 -= n2 % 8;
    return psum(a, lo, n2) + psum(a, lo + n2, n - n2);
  }

  // rolling(n, min_periods=1).apply(lambda x: abs(x - x.mean()).mean(), raw=True)：
  // 窗口入面有任何 NaN／±inf，x.mean() 就係 NaN／inf，成個結果 NaN
  function AVEDEV(x, n) {
    const out = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const w = x.slice(Math.max(0, i + 1 - n), i + 1), k = w.length;
      if (!w.every(Number.isFinite)) { out[i] = NaN; continue; }
      const m = psum(w, 0, k) / k;
      out[i] = psum(w.map(v => Math.abs(v - m)), 0, k) / k;
    }
    return out;
  }

  // Series.shift(n)：頭 n 個 NaN
  function REF(x, n = 1) {
    return x.map((_, i) => (i - n >= 0 && i - n < x.length ? x[i - n] : NaN));
  }

  // a 由下向上穿越 b；a、b 其中一邊可以係數字。i=0 冇上一支，一律 false
  function CROSS(a, b) {
    const n = (isNum(a) ? b : a).length;
    const A = isNum(a) ? new Array(n).fill(a) : a, B = isNum(b) ? new Array(n).fill(b) : b;
    return A.map((_, i) => i > 0 && A[i] > B[i] && A[i - 1] <= B[i - 1]);
  }

  // 分母 0 → NaN；±Infinity → NaN（NaN 照傳）。兩邊都可以係數字
  function safeDiv(a, b) {
    const f = (p, q) => { const r = q === 0 ? NaN : p / q; return Number.isFinite(r) ? r : NaN; };
    if (isNum(a) && isNum(b)) return f(a, b);
    const n = (isNum(a) ? b : a).length;
    return Array.from({ length: n }, (_, i) => f(isNum(a) ? a : a[i], isNum(b) ? b : b[i]));
  }

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  const sub = (a, b) => a.map((x, i) => x - b[i]);
  const ffill = x => { let last = NaN; return x.map(v => (v === v ? (last = v) : last)); };
  const fillna = (x, k) => x.map(v => (v === v ? v : k));
  const clip = (x, lo, hi) => x.map(v => (v !== v ? v : v < lo ? lo : v > hi ? hi : v));   // NaN 唔郁

  // TD Setup 計數：dir=-1 連續 c[i] < c[i-4]，dir=+1 連續 c[i] > c[i-4]；斷咗歸零；頭 4 支冇得比 → 0
  function tdCount(c, dir) {
    const out = new Array(c.length).fill(0);
    for (let i = 4; i < c.length; i++)
      if (dir < 0 ? c[i] < c[i - 4] : c[i] > c[i - 4]) out[i] = out[i - 1] + 1;
    return out;
  }

  // 每個陣列取頭 n 個（回測：只畀指標睇到「已見」嗰段，唔洩露未來）
  function head(bars, n) {
    return { t: bars.t.slice(0, n), o: bars.o.slice(0, n), h: bars.h.slice(0, n),
             l: bars.l.slice(0, n), c: bars.c.slice(0, n), v: bars.v.slice(0, n) };
  }

  // ---------------------------------------------------------------------------
  // 主計算
  // ---------------------------------------------------------------------------
  function compute(bars) {
    const { o, h, l, c, v } = bars;

    // ===== FCOLOR：KD + MACD 共振四色 =====
    const llv14 = LLV(l, 14);
    const rsv = fillna(ffill(safeDiv(sub(c, llv14), sub(HHV(h, 14), llv14)).map(x => x * 100)), 50);
    const k = SMA(rsv, 3, 1);
    const d = SMA(k, 3, 1);
    const diff = sub(EMA(c, 12), EMA(c, 26));
    const dea = EMA(diff, 9);
    const macd = sub(diff, dea).map(x => 2 * x);
    const color = c.map((_, i) => {
      const ok = v[i] > 1;                                  // NaN 比較一律 false → 'none'
      if (macd[i] < 0 && k[i] > d[i] && ok) return 'yellow';
      if (macd[i] > 0 && k[i] > d[i] && ok) return 'green';
      if (macd[i] > 0 && k[i] < d[i] && ok) return 'blue';
      if (macd[i] < 0 && k[i] < d[i] && ok) return 'red';
      return 'none';
    });

    // ===== CHAODI：改良 CCI(36) =====
    const typ = c.map((ci, i) => {
      const oi = o[i], hi = h[i], li = l[i];
      const p1 = ((hi > ci && ci > oi) || (hi > oi && oi >= ci)) ? ci : hi;
      const p2 = ((li < ci && ci < oi) || (li < oi && oi <= ci)) ? ci : li;
      return p1 + p2 / 3;                                   // 原式就係 PRICE1 + PRICE2/3
    });
    const cci = safeDiv(sub(typ, MA(typ, 36)), AVEDEV(typ, 36).map(x => 0.015 * x));
    const cci1 = EMA(fillna(cci, 0), 4);
    const blue = CROSS(cci1, -150).map(b => (b ? 60 : -100));
    const icon = CROSS(100, cci1);

    // ===== MCDXX：動能(紅) + 熱度(黃) 雙 RSI =====
    const dc = sub(c, REF(c, 1));
    const temp1 = dc.map(x => Math.max(x, 0));              // 第 0 支 NaN：Math.max(NaN,0) 都係 NaN，同 np.maximum 一樣
    const temp2 = dc.map(x => Math.abs(x));
    const rsi1 = safeDiv(SMA(temp1, 50, 1), SMA(temp2, 50, 1)).map(x => x * 100);
    const mm_rsi = clip(rsi1.map(x => 1.5 * (x - 50)), 0, 20);
    const rsi2 = safeDiv(SMA(temp1, 40, 1), SMA(temp2, 40, 1)).map(x => x * 100);
    const hot_rsi = clip(rsi2.map(x => 0.7 * (x - 30)), 0, 20);

    // ===== HDLY：主力行為 =====
    const var1 = REF(c.map((_, i) => (l[i] + o[i] + c[i] + h[i]) / 4), 1);
    const lv = sub(l, var1);
    const var2 = safeDiv(SMA(lv.map(x => Math.abs(x)), 13, 1), SMA(lv.map(x => Math.max(x, 0)), 10, 1));
    const var3 = EMA(fillna(var2, 0), 10);
    const var4 = LLV(l, 33);
    const var5 = EMA(l.map((x, i) => (x <= var4[i] ? var3[i] : 0)), 3);

    // HDLY 嘅「主力拉高／出貨」：VAR21..VAR51（Python 冇）
    const hv = sub(h, var1);
    const var21 = safeDiv(SMA(hv.map(x => Math.abs(x)), 13, 1), SMA(hv.map(x => Math.min(x, 0)), 10, 1));
    const var31 = EMA(fillna(var21, 0), 10);
    const var41 = HHV(h, 33);
    const var51 = EMA(h.map((x, i) => (x >= var41[i] ? var31[i] : 0)), 3);

    const hhv55 = HHV(h, 55);
    const mm_line = safeDiv(sub(hhv55, c).map(x => 100 * x), sub(hhv55, LLV(l, 55)));
    const llv34 = LLV(l, 34);
    const rsv34 = fillna(ffill(safeDiv(sub(c, llv34), sub(HHV(h, 34), llv34)).map(x => x * 100)), 50);
    const k34 = SMA(rsv34, 3, 1);
    const d34 = SMA(k34, 3, 1);
    const retail = EMA(k34.map((x, i) => 3 * x - 2 * d34[i]), 6);
    const buymore = CROSS(retail, mm_line);                 // 紅線上穿黃線 = 買入 icon
    const buyless = CROSS(mm_line, retail);

    return {
      color, td: tdCount(c, -1),
      k, d, diff, dea, macd, cci1, mm_rsi, hot_rsi, var5, mm_line, retail,
      ma30: MA(c, 30), ma40: MA(c, 40), ma150: MA(c, 150), mavol30: MA(v, 30), var51,
      buymore, buyless, blue, icon,
    };
  }

  return { head, REF, EMA, SMA, MA, LLV, HHV, AVEDEV, CROSS, safeDiv, tdCount, compute };
})();

if (typeof module !== 'undefined') module.exports = Ind;
