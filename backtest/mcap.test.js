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
  // 2026-10 最大係 MSFT 2023-02 18,521 億；超過 30,000 多數係壞匯出（例如合股細價股冇擋到），真係有就核對完先放寬
  assert.deepStrictEqual(v.filter(x => x < 0 || x > 30000), []);
  assert.ok(v.some(x => x > 1000));
});

// 以下係防壞匯出嘅固定樣本（2026-10 匯出嘅數）
test('固定樣本：AAPL 2016-08 約 3,871 億（±5%）', () => {
  // 誤用派息調整嘅 Adj Close 會低約 8.5%。AAPL 每年回購約 2–3%，隔一兩年重匯出要更新呢個數
  const v = capOf(['AAPL', '2016-08']);
  assert.ok(Math.abs(v / 3871 - 1) <= 0.05, `AAPL 2016-08 = ${v}`);
});

test('固定樣本：同一間公司唔同股份類別，同一個月市值差唔過 2%', () => {
  for (const [a, b, m] of [['BRK-A', 'BRK-B', '2016-03'], ['GOOG', 'GOOGL', '2023-03']]) {
    const x = capOf([a, m]), y = capOf([b, m]);
    assert.ok(Number.isInteger(x) && Number.isInteger(y) && Math.abs(x / y - 1) < 0.02, `${m}：${a} ${x} 對 ${b} ${y}`);
  }
});

test('市值分頁行數冇大幅跳動（2026-10：> 500 億 287 行、> 1,000 億 120 行，±25%）', () => {
  const v = sig.map(capOf).filter(Number.isInteger);
  for (const [cut, was] of [[500, 287], [1000, 120]]) {
    const n = v.filter(x => x > cut).length;
    assert.ok(Math.abs(n / was - 1) <= 0.25, `> ${cut} 億有 ${n} 行（上次 ${was}），重匯出之後要查吓點解`);
  }
});
