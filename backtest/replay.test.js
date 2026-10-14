const test = require('node:test');
const assert = require('node:assert');
const Replay = require('./replay.js');

const bars = { t: ['a','b','c','d','e'], o: [10, 11, 20, 18, 25], h: [10, 12, 22, 19, 26],
               l: [9, 10, 15, 16, 24], c: [11, 12, 19, 18, 25], v: [1, 1, 1, 1, 1] };

test('readout start：入場價＝下個月開市', () =>
  assert.deepStrictEqual(Replay.readout(bars, 1, 1), { state: 'start', entry: 20 }));

test('readout run：有回撤', () =>
  assert.deepStrictEqual(Replay.readout(bars, 1, 4),
    { state: 'run', entry: 20, cur: 25, pct: 25, held: 3, dd: -25 }));

test('readout run：冇跌穿入場價 → dd 係 null', () =>
  assert.strictEqual(Replay.readout({ ...bars, l: [9, 10, 21, 22, 24] }, 1, 4).dd, null));

test('readout pending：訊號係最後一支', () =>                              // Review Focus 2
  assert.deepStrictEqual(Replay.readout(bars, 4, 4), { state: 'pending' }));

test('windowRange：歷史最多 96 支', () => {
  assert.deepStrictEqual(Replay.windowRange(10), { from: 0, to: 10 });
  assert.deepStrictEqual(Replay.windowRange(500), { from: 405, to: 500 });
});

test('shuffle：同一個 seed 出同一個排列，而且係真排列', () => {
  const a = Replay.shuffle(50, 7);
  assert.deepStrictEqual(a, Replay.shuffle(50, 7));
  assert.deepStrictEqual([...a].sort((x, y) => x - y), [...Array(50).keys()]);
  assert.notDeepStrictEqual(a, [...Array(50).keys()]);
});

test('relLabel', () => {
  assert.strictEqual(Replay.relLabel(5, 5), '轉黃');
  assert.strictEqual(Replay.relLabel(17, 5), '+12');
  assert.strictEqual(Replay.relLabel(0, 5), '−5');
});
