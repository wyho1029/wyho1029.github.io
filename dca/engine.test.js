// 跑法：node dca/engine.test.js
// 用參考檔「SPY vs QQQ 月供回測」嘅公開答案對數：每月 HKD 5,000，
// 2015-09 至 2026-09，股息扣 30% 預扣稅再投資。兩邊數據源唔同（stockanalysis
// vs Yahoo）、匯率取法唔同（FRED 月均 vs 當月首個報價），所以容許少少誤差。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { backtest, xirr } = require('./engine.js');
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

const REF = {   // 參考檔數字：最終市值（HKD）、XIRR、最大回撤
  SPY: [1613238, 0.151, -0.182], QQQ: [2269545, 0.207, -0.282],
  VGT: [2876844, 0.246, -0.286], VUG: [1908671, 0.179, -0.282],
  VOO: [1618265, 0.152, -0.182], GLD: [1593517, 0.149, -0.228],
  VTI: [1557563, 0.145, -0.190], VTV: [1334932, 0.120, -0.221],
  SCHD: [1284185, 0.113, -0.187], VEA: [1199252, 0.102, -0.206],
  IWM: [1165545, 0.097, -0.277], VWO: [1041606, 0.078, -0.210],
  BND: [672479, 0.002, -0.047],
};
const base = { ccy: 'HKD', amt: 5000, freq: 1, from: '2015-09', to: '2026-09',
               lump: 0, step: 0, div: 'net', tax: 0.3, fee: 0 };

let worst = 0;
for (const [t, [v, x, dd]] of Object.entries(REF)) {
  const r = backtest(D, t, base);
  const dv = r.value / v - 1;
  worst = Math.max(worst, Math.abs(dv));
  console.log(`${t.padEnd(5)} 市值 ${Math.round(r.value).toLocaleString().padStart(10)}` +
    ` vs ${v.toLocaleString().padStart(10)}  差 ${(dv * 100).toFixed(2).padStart(6)}%` +
    `   XIRR ${(r.xirr * 100).toFixed(1)}% vs ${(x * 100).toFixed(1)}%` +
    `   回撤 ${(r.mdd.pct * 100).toFixed(1)}% vs ${(dd * 100).toFixed(1)}%`);
  assert.strictEqual(r.invested, 665000, `${t} 本金`);
  assert.ok(Math.abs(dv) < 0.01, `${t} 市值差 ${(dv * 100).toFixed(2)}%`);
  assert.ok(Math.abs(r.xirr - x) < 0.003, `${t} XIRR`);
  assert.ok(Math.abs(r.mdd.pct - dd) < 0.01, `${t} 最大回撤`);
}
console.log(`\n最大市值誤差 ${(worst * 100).toFixed(2)}%`);

// SPY 細節：股數、股息買入股數、平均成本、期數
const spy = backtest(D, 'SPY', base);
assert.strictEqual(spy.buys, 133);
assert.ok(Math.abs(spy.shares - 269.6824) / 269.6824 < 0.01, `SPY 股數 ${spy.shares}`);
assert.ok(Math.abs(spy.divShares - 18.57) < 0.6, `SPY 股息股數 ${spy.divShares}`);
assert.ok(Math.abs(spy.avgCost - 339.45) / 339.45 < 0.01, `SPY 平均成本 ${spy.avgCost}`);
assert.strictEqual(spy.mdd.peak, '2021-12');
assert.strictEqual(spy.mdd.trough, '2022-09');

// BND 唔扣稅：參考檔話約 708,702
const bnd = backtest(D, 'BND', { ...base, div: 'gross' });
assert.ok(Math.abs(bnd.value / 708702 - 1) < 0.01, `BND 唔扣稅 ${bnd.value}`);

// ---- 設定真係有作用（唔係擺設）----
const q = backtest(D, 'SPY', { ...base, freq: 3 });
assert.strictEqual(q.buys, 45, '每季供：133 個月 → 45 期');
assert.strictEqual(q.invested, 45 * 5000);
// 每月 USD 5,000 買到嘅股數係 HKD 5,000 嘅約 7.8 倍，但前者用美元報、後者用
// 港元報 —— 兩邊都乘咗／除咗 7.8，所以**數字**應該差唔多（只差匯率波動）。
const usd = backtest(D, 'SPY', { ...base, ccy: 'USD' });
assert.strictEqual(usd.invested, 665000);
assert.ok(Math.abs(usd.value / spy.value - 1) < 0.02, `USD ${usd.value} vs HKD ${spy.value}`);
assert.ok(Math.abs(usd.shares / spy.shares - 7.8) < 0.1, '股數應該大約係 7.8 倍');
const step = backtest(D, 'SPY', { ...base, step: 0.1 });
assert.ok(step.invested > spy.invested, '每年加供要多咗本金');
assert.strictEqual(step.inv[11], 60000, '第一年仲係 5000 × 12');
assert.strictEqual(step.inv[12], 65500, '第二年每期 5500');
const lump = backtest(D, 'SPY', { ...base, lump: 100000 });
assert.strictEqual(lump.invested, 765000);
const cash = backtest(D, 'SPY', { ...base, div: 'cash' });
assert.ok(cash.cashUsd > 0 && cash.divShares === 0, '收現金唔應該再投資');
assert.ok(cash.value < spy.value, '牛市入面收現金應該少過再投資');
const gross = backtest(D, 'SPY', { ...base, div: 'gross' });
assert.ok(gross.value > spy.value && gross.divTax === 0, '唔扣稅應該多啲、冇稅');
const fee = backtest(D, 'SPY', { ...base, fee: 5 });
assert.ok(fee.value < spy.value && fee.invested === spy.invested, '手續費食咗回報、唔影響本金');

// 開始日早過 ETF 成立：要自動由成立月計，並標示 clipped
const voo = backtest(D, 'VOO', { ...base, from: '2005-01' });
assert.ok(voo.clipped && voo.from === '2010-09', `VOO 由 ${voo.from} 開始`);
// 範圍完全喺成立之前 → null
assert.strictEqual(backtest(D, 'VOO', { ...base, from: '2001-01', to: '2005-01' }), null);
// GLD 唔派息
assert.strictEqual(backtest(D, 'GLD', base).divGross, 0);

// XIRR：一筆過 100，一年後 110 → 10%
const r = xirr([{ d: new Date('2020-01-01'), v: -100 }, { d: new Date('2021-01-01'), v: 110 }]);
assert.ok(Math.abs(r - 0.0997) < 0.002, `XIRR ${r}`);

console.log('✓ 全部通過');
