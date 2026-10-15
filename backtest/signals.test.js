const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Ind = require('./ind.js');
const sig = require('./data/signals.json');

test('每一行都係剛轉黃、窗口內有 9，入場價＝下月開市', () => {
  const byT = new Map();
  for (const r of sig) { if (!byT.has(r[0])) byT.set(r[0], []); byT.get(r[0]).push(r); }
  const bad = [];
  for (const [t, rows] of byT) {
    const bars = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', t + '.json'), 'utf8'));
    const S = Ind.compute(bars);
    for (const [, month, nine, gap, entry] of rows) {
      const i = bars.t.indexOf(month), hit = i < 0 ? null : Ind.isSignalAt(S, i);
      const okEntry = i + 1 < bars.t.length ? entry === bars.o[i + 1] : entry === null;
      if (!hit || bars.t[hit.nine] !== nine || hit.gap !== gap || !okEntry) bad.push(`${t} ${month}`);
    }
  }
  assert.deepStrictEqual(bad.slice(0, 20), []);
});
