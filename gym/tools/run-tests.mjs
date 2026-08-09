// Node runner —— 同 test.html 共用 gym/tests.js。CI／subagent 用呢個，exit code 0 = 全綠。
// 用法：cd site/gym && node tools/run-tests.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;

globalThis.eq = function (actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg || '') + ' 預期 ' + e + '，實際 ' + a);
};

globalThis.check = function (name, fn) {
  try { fn(); passed++; }
  catch (err) { failed++; console.error('✗ ' + name + ' — ' + err.message); }
};

// 間接 eval：喺全域 scope 執行，令 engine.js 嘅 `var GymEngine` 變成全域
const run = (0, eval);
run(readFileSync(join(dir, 'engine.js'), 'utf8'));
run(readFileSync(join(dir, 'tests.js'), 'utf8'));

console.log(failed ? (failed + ' 個失敗 / ' + (passed + failed) + ' 個測試')
                   : ('全部通過 — ' + passed + ' 個測試'));
process.exit(failed ? 1 : 0);
