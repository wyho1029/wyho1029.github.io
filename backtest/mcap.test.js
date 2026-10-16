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

test('單位係億美元：冇大過 60 萬億、最少一個大過 1,000 億', () => {
  const v = Object.values(mcap.caps).flatMap(Object.values).filter(Number.isInteger);
  assert.strictEqual(mcap.unit, '億美元');
  assert.match(mcap.asof, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepStrictEqual(v.filter(x => x < 0 || x > 600000), []);
  assert.ok(v.some(x => x > 1000));
});
