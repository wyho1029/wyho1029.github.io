const test = require('node:test');
const assert = require('node:assert');
const Ind = require('./ind.js');

const NUM = ['k','d','diff','dea','macd','cci1','mm_rsi','hot_rsi','var5','mm_line','retail','ma30','ma40'];
const bars = (c, v) => ({ t: c.map((_, i) => String(i)), o: c, h: c, l: c, c, v: v || c.map(() => 100) });

test('ewm 跟 pandas：開頭 NaN 照出 NaN，第一個有效值做種子，常數唔郁', () => {
  const y = Ind.EMA([NaN, 2, 2, 2], 3);
  assert.ok(Number.isNaN(y[0]));
  assert.deepStrictEqual(y.slice(1), [2, 2, 2]);
});

test('CROSS 任何一邊都可以係數字', () => {
  assert.deepStrictEqual(Ind.CROSS([-200, -100, -160], -150), [false, true, false]);
  assert.deepStrictEqual(Ind.CROSS(100, [120, 90, 110]), [false, true, false]);
});

test('tdCount：向下、向上，斷咗歸零', () => {
  assert.deepStrictEqual(Ind.tdCount([10,10,10,10,9,8,7,6,5,4,3,2,1,100], -1),
                         [0,0,0,0,1,2,3,4,5,6,7,8,9,0]);
  assert.deepStrictEqual(Ind.tdCount([1,1,1,1,2,3,1], 1), [0,0,0,0,1,2,0]);
});

test('flat prices：唔 throw、全部 none、冇 Infinity', () => {          // Review Focus 1
  const S = Ind.compute(bars(Array(40).fill(5), Array(40).fill(0)));
  assert.ok(S.color.every(c => c === 'none'));
  for (const k of [...NUM, 'ma150', 'mavol30', 'var51'])
    assert.ok(S[k].every(v => Number.isFinite(v) || Number.isNaN(v)), k);
});

test('short history（14 支）照計得', () => {                          // Review Focus 3
  const S = Ind.compute(bars([5,6,7,6,5,4,5,6,7,8,9,8,7,6]));
  assert.strictEqual(S.ma150.length, 14);
  assert.strictEqual(S.color.length, 14);
});

test('tdDisplay：數到 9 嗰段標 1..9，之後唔標', () => {
  assert.deepStrictEqual(Ind.tdDisplay([0,1,2,3,4,5,6,7,8,9,10,11,0]), [0,1,2,3,4,5,6,7,8,9,0,0,0]);
});

test('tdDisplay：停喺 8 嗰段一個都唔標', () => {
  assert.deepStrictEqual(Ind.tdDisplay([1,2,3,4,5,6,7,8,0]), [0,0,0,0,0,0,0,0,0]);
});

test('tdDisplay 只計前段：9 未出現就冇 label（唔洩露未來）', () => {
  const cnt = Ind.tdCount([10,10,10,10,9,8,7,6,5,4,3,2,1], -1);
  assert.ok(Ind.tdDisplay(cnt.slice(0, 12)).every(x => x === 0));
  assert.strictEqual(Ind.tdDisplay(cnt)[12], 9);
});

test('compute 有齊向上同向下嘅 label', () => {
  const S = Ind.compute(bars([1,1,1,1,2,3,4,5,6,7,8,9,10]));
  assert.deepStrictEqual(S.tdUp.slice(4), [1,2,3,4,5,6,7,8,9]);
  assert.ok(S.tdDn.every(x => x === 0));
});

test('isSignalAt 同 nine_yellow._gate 一樣', () => {
  const S = { color: Array(26).fill('red'), td: Array(26).fill(0) };
  S.td[12] = 9; S.color[13] = 'yellow';
  assert.deepStrictEqual(Ind.isSignalAt(S, 13), { nine: 12, gap: 1 });
  S.color[12] = 'yellow';
  assert.strictEqual(Ind.isSignalAt(S, 13), null);                          // 唔係「剛轉黃」
  S.color[12] = 'red'; S.color[13] = 'red'; S.color[25] = 'yellow';
  assert.strictEqual(Ind.isSignalAt(S, 25), null);                          // gap 13 超出窗口
  assert.strictEqual(Ind.isSignalAt({ color: ['red', 'yellow'], td: [9, 0] }, 1), null);   // 少過 13 支
});

// ---- 同 Python 逐月對數（fixtures.json 由 backtest_web_export.py 匯出）----
const fx = require('./data/fixtures.json');
const near = (a, b) => (b === null ? Number.isNaN(a) : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

test('fixtures 有 ≥15 隻，IBM 由 1970 年代開始', () => { assert.ok(fx.length >= 15); assert.strictEqual(fx.find(f => f.code === 'US.IBM').t[0].slice(0, 3), '197'); });

for (const f of fx) test(`同 Python 對數 ${f.code}`, () => {
  const S = Ind.compute(f);
  assert.deepStrictEqual(S.color, f.color);
  assert.deepStrictEqual(S.td, f.td);
  assert.deepStrictEqual(S.buymore, f.buymore);
  for (const k of NUM) f[k].forEach((v, i) =>
    assert.ok(near(S[k][i], v), `${f.code} ${k}[${i}] ${f.t[i]}: js=${S[k][i]} py=${v}`));
});
