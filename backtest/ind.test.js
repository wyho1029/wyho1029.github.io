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
