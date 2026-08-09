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

// ---- 測試用嘅 fixture ----
var SQUAT = { id: 'Barbell_Squat', upperLower: 'lower', minWeight: 20, metric: 'reps' };
var BENCH = { id: 'Bench', upperLower: 'upper', minWeight: 20, metric: 'reps' };
var PLANK = { id: 'Plank', upperLower: 'upper', minWeight: 0, metric: 'seconds' };
var INC = { upper: 2.5, lower: 5 };

/** 砌一個 session：sets 係 [[weight, reps], ...] */
function sess(date, exerciseId, targetWeight, targetReps, sets) {
  return {
    date: date, day: 'A', done: true, note: '',
    entries: [{
      slot: 'squat', exerciseId: exerciseId,
      target: { sets: sets.length, reps: targetReps, weight: targetWeight },
      actual: sets.map(function (s) { return { w: s[0], r: s[1] }; })
    }]
  };
}

check('allHit：全部組達到目標次數', function () {
  var s = sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]]);
  eq(GymEngine.allHit(s.entries[0]), true);
});

check('allHit：有一組唔夠就唔算達標', function () {
  var s = sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,7]]);
  eq(GymEngine.allHit(s.entries[0]), false);
});

check('全部達標 → 下肢加 5kg', function () {
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 45, reps: 8 });
});

check('全部達標 → 上肢加 2.5kg', function () {
  var sessions = [sess('2026-08-11', 'Bench', 30, 8, [[30,8],[30,8],[30,8]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Bench',
       exercise: BENCH, increments: INC, reps: 8 }), { weight: 32.5, reps: 8 });
});

check('差少少（總次數 >= 80%）→ 重量不變', function () {
  // 目標 24 下，做咗 22 下 = 91%
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,6]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 40, reps: 8 });
});

check('差好遠（總次數 < 80%）→ 即刻 deload 10%', function () {
  // 目標 24 下，做咗 15 下 = 62%。40 × 0.9 = 36
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,6],[40,5],[40,4]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 36, reps: 8 });
});

check('連續兩次差少少 → 第二次之後 deload', function () {
  var sessions = [
    sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,6]]),
    sess('2026-08-14', 'Barbell_Squat', 40, 8, [[40,8],[40,7],[40,7]])
  ];
  eq(GymEngine.failStreak(sessions, 'Barbell_Squat'), 2);
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 36, reps: 8 });
});

check('deload 之後再失手一次 → 維持重量，唔會即刻再 deload', function () {
  var sessions = [
    sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,6]]),
    sess('2026-08-14', 'Barbell_Squat', 40, 8, [[40,8],[40,7],[40,7]]),
    sess('2026-08-17', 'Barbell_Squat', 36, 8, [[36,8],[36,8],[36,7]])  // deload 後仍未全中
  ];
  eq(GymEngine.failStreak(sessions, 'Barbell_Squat'), 1, '重量下降處停止計數');
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 36, reps: 8 });
});

check('deload 後再達標 → 恢復加重', function () {
  var sessions = [
    sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,6]]),
    sess('2026-08-14', 'Barbell_Squat', 36, 8, [[36,8],[36,8],[36,8]])
  ];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 41, reps: 8 });
});

check('deload 結果對齊 1.25 且唔低過 minWeight', function () {
  // 22 × 0.9 = 19.8 → 對齊 20，但 minWeight 20 → 20
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 22, 8, [[22,4],[22,4],[22,3]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 20, reps: 8 });
});

check('自定加重幅度生效', function () {
  var sessions = [sess('2026-08-11', 'Bench', 30, 8, [[30,8],[30,8],[30,8]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Bench', exercise: BENCH,
       increments: { upper: 1.25, lower: 5 }, reps: 8 }), { weight: 31.25, reps: 8 });
});

check('首次做某動作 → 估計值 × 65%，對齊 1.25', function () {
  eq(GymEngine.nextTarget({ sessions: [], exerciseId: 'Barbell_Squat', exercise: SQUAT,
       increments: INC, reps: 8, estimate: 60 }), { weight: 40, reps: 8 });  // 39 → 40（對齊後）
});

check('首次且無估計值 → 用 minWeight', function () {
  eq(GymEngine.nextTarget({ sessions: [], exerciseId: 'Barbell_Squat', exercise: SQUAT,
       increments: INC, reps: 8 }), { weight: 20, reps: 8 });
});

check('未完成嘅 session 唔計入歷史', function () {
  var s = sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]]);
  var pending = sess('2026-08-14', 'Barbell_Squat', 45, 8, [[45,3]]);
  pending.done = false;
  eq(GymEngine.nextTarget({ sessions: [s, pending], exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 45, reps: 8 });
});

check('計時動作：達標 → +5 秒，重量恆為 0', function () {
  var sessions = [{
    date: '2026-08-11', day: 'A', done: true, note: '',
    entries: [{ slot: 'core', exerciseId: 'Plank',
                target: { sets: 3, reps: 45, weight: 0 },
                actual: [{ w: 0, r: 45 }, { w: 0, r: 45 }, { w: 0, r: 45 }] }]
  }];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Plank', exercise: PLANK,
       increments: INC, reps: 45 }), { weight: 0, reps: 50 });
});

check('計時動作：未達標 → 維持秒數', function () {
  var sessions = [{
    date: '2026-08-11', day: 'A', done: true, note: '',
    entries: [{ slot: 'core', exerciseId: 'Plank',
                target: { sets: 3, reps: 45, weight: 0 },
                actual: [{ w: 0, r: 45 }, { w: 0, r: 40 }, { w: 0, r: 30 }] }]
  }];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Plank', exercise: PLANK,
       increments: INC, reps: 45 }), { weight: 0, reps: 45 });
});
