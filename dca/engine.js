/* 月供回測計算核心。網頁同 node 測試（engine.test.js）共用呢一份。
 *
 * 計法同參考嗰版「SPY vs QQQ 月供回測」一致：
 *  - 每期喺當月第一個交易日以開市價買入，可買碎股
 *  - 港元供款按當月第一個匯率報價換做美元
 *  - 除息日持有嘅股數收息；除息日正正係供款日嗰期，新買嘅股冇得收
 *  - 股息（扣稅後）以除息當月月底收市價再買入
 *  - 市值以月底收市價計（最後一個月 = 數據最新收市價）
 */
(function (root) {
  'use strict';

  function monthAdd(m, k) {
    const y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + k;
    const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12 + 1;
    return yy + '-' + String(mm).padStart(2, '0');
  }
  function monthDiff(a, b) {           // b - a，以月計
    return (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  }
  function monthEndDate(m) {
    const y = +m.slice(0, 4), mo = +m.slice(5, 7);
    return new Date(Date.UTC(y, mo, 0));   // 下個月第 0 日 = 本月最後一日
  }

  // XIRR：現金流 [{d: Date, v: number}]，回年化回報（小數）。Newton，唔收斂就二分。
  function xirr(flows) {
    if (flows.length < 2) return NaN;
    const t0 = flows[0].d.getTime();
    const yrs = flows.map(f => (f.d.getTime() - t0) / (365 * 864e5));   // Excel XIRR 以 365 日計
    const f = r => flows.reduce((s, x, i) => s + x.v / Math.pow(1 + r, yrs[i]), 0);
    const df = r => flows.reduce((s, x, i) => s - yrs[i] * x.v / Math.pow(1 + r, yrs[i] + 1), 0);
    let r = 0.1;
    for (let i = 0; i < 60; i++) {
      const y = f(r), d = df(r);
      if (!isFinite(y) || !isFinite(d) || d === 0) break;
      const nr = r - y / d;
      if (nr <= -0.9999) break;
      if (Math.abs(nr - r) < 1e-9) return nr;
      r = nr;
    }
    // 二分後備：-99.99% 到 +1000%
    let lo = -0.9999, hi = 10, flo = f(lo), fhi = f(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return NaN;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(fm) < 1e-7) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /* D：data.json；t：代號；o：設定
   *   o.ccy  'HKD' | 'USD'
   *   o.amt  每期金額（o.ccy）
   *   o.freq 每幾多個月供一次（1 / 3 / 12）
   *   o.from, o.to  'YYYY-MM'
   *   o.lump 第一期額外一筆過金額
   *   o.step 每年加供（小數，0.05 = 每年多 5%）
   *   o.div  'net' 扣稅再投資 | 'gross' 唔扣稅再投資 | 'cash' 扣稅收現金
   *   o.tax  預扣稅率（小數）
   *   o.fee  每次買入手續費（美元）
   */
  function backtest(D, t, o) {
    // own property：唔可以俾 'constructor'、'__proto__' 呢啲原型鏈名稱過關
    if (!Object.prototype.hasOwnProperty.call(D.etfs, t)) return null;
    const E = D.etfs[t];
    const first = monthAdd(D.m0, E.i);
    const last = monthAdd(first, E.c.length - 1);
    const from = o.from > first ? o.from : first;
    const to = o.to < last ? o.to : last;
    if (from > to) return null;

    const tax = o.div === 'gross' ? 0 : (o.tax || 0);
    const dvByK = {};
    E.dv.forEach(d => { (dvByK[d[0]] = dvByK[d[0]] || []).push(d); });

    let shares = 0, divShares = 0, cash = 0, invested = 0, usdSpent = 0, buys = 0;
    let divGross = 0, divTax = 0, peak = -Infinity, peakM = null;
    const out = { months: [], inv: [], val: [] }, flows = [];
    const mdd = { pct: 0, peak: null, trough: null };
    const worst = { pct: Infinity, at: null };
    let under = 0;

    const n = monthDiff(from, to) + 1;
    for (let k = 0; k < n; k++) {
      const m = monthAdd(from, k);
      const ek = monthDiff(first, m);          // ETF 內部索引
      const gk = E.i + ek;                     // 全局索引（匯率用）
      const fxb = o.ccy === 'HKD' ? D.fxb[gk] : 1;
      const fxc = o.ccy === 'HKD' ? D.fxc[gk] : 1;
      const open = E.o[ek], close = E.c[ek];

      // ① 供款
      let newShares = 0;
      if (k % o.freq === 0) {
        let amt = o.amt * Math.pow(1 + (o.step || 0), Math.floor(k / 12));
        if (k === 0) amt += o.lump || 0;
        if (amt > 0) {
          const usd = amt / fxb - (o.fee || 0);
          invested += amt;
          // 現金流日期 = 當月真正嘅首個交易日（成立月就係成立日），唔係一律 1 號
          const fd = D.fd ? D.fd[gk] : 1;
          const day = ek === 0 ? Math.max(fd, E.d0 || 1) : fd;
          flows.push({ d: new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, day)), v: -amt });
          if (usd > 0) {
            newShares = usd / open;
            usdSpent += usd;
            buys++;
          }
        }
      }
      const before = shares;
      shares += newShares;

      // ② 股息
      (dvByK[ek] || []).forEach(([, a, onBuyDay]) => {
        const held = before + (onBuyDay ? 0 : newShares);
        const g = held * a, net = g * (1 - tax);
        divGross += g * fxc;
        divTax += (g - net) * fxc;
        if (o.div === 'cash') cash += net;
        else { const s = net / close; shares += s; divShares += s; }
      });

      // ③ 月底估值
      const v = (shares * close + cash) * fxc;
      out.months.push(m); out.inv.push(invested); out.val.push(v);
      if (v > peak) { peak = v; peakM = m; }
      const dd = peak > 0 ? v / peak - 1 : 0;
      if (dd < mdd.pct) { mdd.pct = dd; mdd.peak = peakM; mdd.trough = m; }
      const r = invested > 0 ? v / invested - 1 : 0;
      if (invested > 0 && r < worst.pct) { worst.pct = r; worst.at = m; }
      if (v < invested) under++;
    }

    const value = out.val[out.val.length - 1];
    // 估值日 = 呢隻 ETF 自己最後一個有效收市日（唔係全部 ETF 入面最新嗰日）
    const endDate = to === last ? new Date((E.ld || D.asof) + 'T00:00:00Z') : monthEndDate(to);
    flows.push({ d: endDate, v: value });

    return {
      t, from, to, first, clipped: o.from < first,
      months: out.months, inv: out.inv, val: out.val,
      invested, value, gain: value - invested, ret: invested ? value / invested - 1 : 0,
      xirr: xirr(flows),
      mdd, worst: worst.at ? worst : { pct: 0, at: null }, under,
      shares, divShares, cashUsd: cash, buys,
      avgCost: shares - divShares > 0 ? usdSpent / (shares - divShares) : 0,
      lastClose: E.c[monthDiff(first, to)],
      divGross, divTax, endDate,
    };
  }

  const api = { backtest, xirr, monthAdd, monthDiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DCA = api;
})(this);
