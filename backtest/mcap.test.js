const test = require('node:test');
const assert = require('node:assert');
const sig = require('./data/signals.json');
const mcap = require('./data/mcap.json');

const capOf = ([t, m]) => Object.hasOwn(mcap.caps, t) && Object.hasOwn(mcap.caps[t], m) ? mcap.caps[t][m] : undefined;

test('每一行訊號都有市值 key，值係整數（億）或者 null', () => {
  const bad = sig.filter(r => { const v = capOf(r); return !(v === null || Number.isInteger(v)); });
  assert.deepStrictEqual(bad.slice(0, 20), []);
});

test('九成五以上嘅訊號有市值', () => {
  const n = sig.filter(r => Number.isInteger(capOf(r))).length;
  assert.ok(n / sig.length >= 0.95, `得 ${n} / ${sig.length}`);
});

test('單位係億美元：冇負數、冇大過 3 萬億美元、最少一個大過 1,000 億', () => {
  const v = Object.values(mcap.caps).flatMap(Object.values).filter(Number.isInteger);
  assert.strictEqual(mcap.unit, '億美元');
  assert.match(mcap.asof, /^\d{4}-\d{2}-\d{2}$/);
  // 2026-10 最大係 MSFT 2023-02 約 18,566 億；超過 30,000 多數係壞匯出（例如合股細價股冇擋到），真係有就核對完先放寬
  assert.deepStrictEqual(v.filter(x => x < 0 || x > 30000), []);
  assert.ok(v.some(x => x > 1000));
});

// 以下係防壞匯出嘅固定樣本（2026-10 匯出嘅數）
test('固定樣本：AAPL 2016-08 約 5,660 億（±5%，用當時股數）', () => {
  // 獨立參考：2016-08-31 收市 106.10 美元 × 10-Q 披露 53.3 億股 ≈ 5,658 億（數據用 Yahoo 2016-07-28 嘅
  // 53.88 億股，得 5,717，+1%）。變返用今日股數會得約 3,900（低 3 成），誤用派息調整嘅 Adj Close 會再低約 8.5%
  const v = capOf(['AAPL', '2016-08']);
  assert.ok(Math.abs(v / 5658 - 1) <= 0.05, `AAPL 2016-08 = ${v}`);
});

test('固定樣本：已知錯又冇公佈數嘅個案係 null', () => {
  for (const r of [['C', '1995-01'], ['PCG', '1994-12'], ['PCG', '1988-02'], ['PCG', '1988-06'], ['FITB', '2003-06'],
                   ['LIN', '2016-03'], ['STLA', '2019-09'], ['ET', '2016-05'], ['BKR', '2016-07'], ['IEP', '2016-02'],
                   ['IEP', '2016-11']])
    assert.strictEqual(capOf(r), null, r.join(' '));
});

test('固定樣本：校正過嘅個案（公佈年底市值、披露股數）冇變返用今日股數', () => {
  // 用今日股數嘅話：SAN 2001-12 約 1,200、BAC 2000-05 約 1,940、HON 2022-10 約 640、GSK 2002-08 約 760；
  // KMI 2014-06 錨點如果插值跨過 2014-11 合併會變 572
  const [san, bac, hon, gsk, kmi] = [['SAN', '2001-12'], ['BAC', '2000-05'], ['HON', '2022-10'], ['GSK', '2002-08'],
                                     ['KMI', '2014-06']].map(r => capOf(r));
  assert.ok(san < 500, `SAN 2001-12 = ${san}（公佈年底市值推算約 387）`);
  assert.ok(bac > 500 && bac < 1000, `BAC 2000-05 = ${bac}（約 915）`);
  assert.ok(hon > 1000, `HON 2022-10 = ${hon}（披露股數校正約 1,370）`);
  assert.ok(gsk > 1000, `GSK 2002-08 = ${gsk}（公佈年底市值推算約 1,150）`);
  assert.ok(kmi < 500, `KMI 2014-06 = ${kmi}（合併前約 374）`);
});

test('固定樣本：同一間公司唔同股份類別，同一個月市值差唔過 2%', () => {
  for (const [a, b, m] of [['BRK-A', 'BRK-B', '2016-03'], ['GOOG', 'GOOGL', '2023-03']]) {
    const x = capOf([a, m]), y = capOf([b, m]);
    assert.ok(Number.isInteger(x) && Number.isInteger(y) && Math.abs(x / y - 1) < 0.02, `${m}：${a} ${x} 對 ${b} ${y}`);
  }
});

test('市值分頁行數冇大幅跳動（2026-10-17：> 500 億 276 行、> 1,000 億 126 行，±25%）', () => {
  const v = sig.map(capOf).filter(Number.isInteger);
  for (const [cut, was] of [[500, 276], [1000, 126]]) {
    const n = v.filter(x => x > cut).length;
    assert.ok(Math.abs(n / was - 1) <= 0.25, `> ${cut} 億有 ${n} 行（上次 ${was}），重匯出之後要查吓點解`);
  }
});
