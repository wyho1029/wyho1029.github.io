/* GymEngine 測試案例。由 test.html（瀏覽器）同 tools/run-tests.mjs（node）共用。
   靠 runner 提供嘅全域 check() 同 eq()。新測試追加喺檔案末尾。 */

// ---- roundToStep ----
check('roundToStep 四捨五入到 1.25', function () {
  eq(GymEngine.roundToStep(42.3, 1.25), 42.5);
  eq(GymEngine.roundToStep(40.9, 1.25), 41.25);
  eq(GymEngine.roundToStep(40, 1.25), 40);
});

check('roundToStep 支援 2.5 同 5', function () {
  eq(GymEngine.roundToStep(41, 2.5), 40);
  eq(GymEngine.roundToStep(42, 5), 40);
  eq(GymEngine.roundToStep(43, 5), 45);
});

// ---- weekIndex ----
check('weekIndex 由 startDate 起計 7 日一格', function () {
  eq(GymEngine.weekIndex('2026-08-11', '2026-08-11'), 0, '同日');
  eq(GymEngine.weekIndex('2026-08-11', '2026-08-17'), 0, '第 7 日仍係第 0 格');
  eq(GymEngine.weekIndex('2026-08-11', '2026-08-18'), 1, '第 8 日入第 1 格');
  eq(GymEngine.weekIndex('2026-08-11', '2026-09-08'), 4, '第 29 日入第 4 格');
});

check('weekIndex 唔跟星期幾', function () {
  eq(GymEngine.weekIndex('2026-08-12', '2026-08-18'), 0, '由星期三起計，下個星期二仍係第 0 格');
});
