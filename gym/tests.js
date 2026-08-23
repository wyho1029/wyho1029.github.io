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
  // 目標 24 下，做咗 15 下 = 62%。40 × 0.9 = 36 → 對齊 2.5 → 35
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,6],[40,5],[40,4]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 35, reps: 8 });
});

check('連續兩次差少少 → 第二次之後 deload', function () {
  var sessions = [
    sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,6]]),
    sess('2026-08-14', 'Barbell_Squat', 40, 8, [[40,8],[40,7],[40,7]])
  ];
  eq(GymEngine.failStreak(sessions, 'Barbell_Squat'), 2);
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 35, reps: 8 });
});

check('deload 之後再失手一次 → 維持重量，唔會即刻再 deload', function () {
  var sessions = [
    sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,6]]),
    sess('2026-08-14', 'Barbell_Squat', 40, 8, [[40,8],[40,7],[40,7]]),
    sess('2026-08-17', 'Barbell_Squat', 35, 8, [[35,8],[35,8],[35,7]])  // deload 後仍未全中
  ];
  eq(GymEngine.failStreak(sessions, 'Barbell_Squat'), 1, '重量下降處停止計數');
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 35, reps: 8 });
});

check('deload 後再達標 → 恢復加重', function () {
  var sessions = [
    sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,6]]),
    sess('2026-08-14', 'Barbell_Squat', 35, 8, [[35,8],[35,8],[35,8]])
  ];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 40, reps: 8 });
});

check('deload 結果對齊 2.5 且唔低過 minWeight', function () {
  // 22 × 0.9 = 19.8 → 對齊 2.5 → 20，同時 minWeight 20 都係 20
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 22, 8, [[22,4],[22,4],[22,3]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 20, reps: 8 });
});

check('自定加重幅度生效', function () {
  var sessions = [sess('2026-08-11', 'Bench', 30, 8, [[30,8],[30,8],[30,8]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Bench', exercise: BENCH,
       increments: { upper: 1.25, lower: 5 }, reps: 8 }), { weight: 31.25, reps: 8 });
});

check('首次做某動作 → 估計值 × 65%，對齊 2.5', function () {
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

check('deload 唔會出上唔到槓嘅重量（一律 2.5 嘅倍數）', function () {
  [[37.5, 35], [45, 40], [52.5, 47.5], [60, 55]].forEach(function (pair) {
    var sessions = [sess('2026-08-11', 'Barbell_Squat', pair[0], 8, [[pair[0],3],[pair[0],3],[pair[0],2]])];
    var got = GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
      exercise: SQUAT, increments: INC, reps: 8 });
    eq(got.weight, pair[1], pair[0] + 'kg deload');
    eq(got.weight % 2.5, 0, pair[0] + 'kg deload 結果要係 2.5 嘅倍數');
  });
});

// ---- 強度參數 ----
check('INTENSITY 三檔參數正確', function () {
  eq(GymEngine.INTENSITY.light.sets, 2);
  eq(GymEngine.INTENSITY.medium.sets, 3);
  eq(GymEngine.INTENSITY.heavy.sets, 4);
  eq(GymEngine.INTENSITY.medium.reps, 8);
  eq(GymEngine.INTENSITY.medium.restSec, 120);
  eq(GymEngine.INTENSITY.heavy.accessories, 2);
});

// ---- 第 1 週只做 2 組 ----
check('第 1 週：medium 都只出 2 組', function () {
  eq(GymEngine.setsForWeek('medium', 0), 2);
});

check('第 2 週起：medium 恢復 3 組', function () {
  eq(GymEngine.setsForWeek('medium', 1), 3);
  eq(GymEngine.setsForWeek('medium', 4), 3);
});

check('第 1 週：light 本身就係 2 組，唔會變少', function () {
  eq(GymEngine.setsForWeek('light', 0), 2);
});

// ---- 每個 7 日區塊最多加一次重 ----
check('同一 7 日區塊內第二次做同一動作 → 唔准加重', function () {
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]])];
  eq(GymEngine.canIncreaseThisWeek(sessions, 'Barbell_Squat', '2026-08-11', '2026-08-14'), false);
});

check('去到下一個 7 日區塊 → 可以再加重', function () {
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]])];
  eq(GymEngine.canIncreaseThisWeek(sessions, 'Barbell_Squat', '2026-08-11', '2026-08-19'), true);
});

check('第 5 週起 ramp-back 限制解除', function () {
  var sessions = [sess('2026-09-15', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]])];
  eq(GymEngine.canIncreaseThisWeek(sessions, 'Barbell_Squat', '2026-08-11', '2026-09-17'), true);
});

check('從未做過該動作 → 唔受限', function () {
  eq(GymEngine.canIncreaseThisWeek([], 'Barbell_Squat', '2026-08-11', '2026-08-14'), true);
});

// ---- 「重」強度閘門 ----
function doneSessions(n, startDate) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var d = new Date(Date.parse(startDate + 'T00:00:00Z') + i * 2 * 86400000);
    out.push(sess(d.toISOString().slice(0, 10), 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]]));
  }
  return out;
}
var PROFILE3 = { daysPerWeek: 3, startDate: '2026-08-11', intensityUnlockedAt: null, intensityUnlockForced: false };

check('滿 4 週但只做 5 次 → 仍鎖', function () {
  var r = GymEngine.heavyUnlock(PROFILE3, doneSessions(5, '2026-08-11'), '2026-09-10');
  eq(r.unlocked, false);
  eq(r.sessionsNeeded, 9);
  eq(r.sessionsDone, 5);
});

check('做夠 9 次但只 2 週 → 仍鎖', function () {
  var r = GymEngine.heavyUnlock(PROFILE3, doneSessions(9, '2026-08-11'), '2026-08-25');
  eq(r.unlocked, false);
  eq(r.weeksDone, 2);
});

check('4 週 + 9 次 → 解鎖', function () {
  var r = GymEngine.heavyUnlock(PROFILE3, doneSessions(9, '2026-08-11'), '2026-09-10');
  eq(r.unlocked, true);
  eq(r.forced, false);
});

check('強制解鎖 → 即使未夠數都保持解鎖', function () {
  var p = { daysPerWeek: 3, startDate: '2026-08-11',
            intensityUnlockedAt: '2026-08-13', intensityUnlockForced: true };
  var r = GymEngine.heavyUnlock(p, doneSessions(2, '2026-08-11'), '2026-08-14');
  eq(r.unlocked, true);
  eq(r.forced, true);
});

check('未完成嘅 session 唔計入解鎖次數', function () {
  var s = doneSessions(9, '2026-08-11');
  s[0].done = false;
  var r = GymEngine.heavyUnlock(PROFILE3, s, '2026-09-10');
  eq(r.sessionsDone, 8);
  eq(r.unlocked, false);
});

check('每週日數唔同 → 所需次數跟住變', function () {
  var p5 = { daysPerWeek: 5, startDate: '2026-08-11', intensityUnlockedAt: null, intensityUnlockForced: false };
  eq(GymEngine.heavyUnlock(p5, [], '2026-09-10').sessionsNeeded, 15);
});

// ---- 動作庫 fixture ----
var EXDB = [
  { id: 'Barbell_Squat', name: '槓鈴深蹲', slot: 'squat', upperLower: 'lower', minWeight: 20, metric: 'reps' },
  { id: 'Front_Barbell_Squat', name: '前蹲', slot: 'squat', upperLower: 'lower', minWeight: 20, metric: 'reps' },
  { id: 'Leg_Press', name: '腿推機', slot: 'squat', upperLower: 'lower', minWeight: 0, metric: 'reps' },
  { id: 'Romanian_Deadlift', name: '羅馬尼亞硬拉', slot: 'hinge', upperLower: 'lower', minWeight: 20, metric: 'reps' },
  { id: 'Barbell_Deadlift', name: '傳統硬拉', slot: 'hinge', upperLower: 'lower', minWeight: 20, metric: 'reps' },
  { id: 'Barbell_Bench_Press_-_Medium_Grip', name: '平板臥推', slot: 'horizontal_push', upperLower: 'upper', minWeight: 20, metric: 'reps' },
  { id: 'Dumbbell_Bench_Press', name: '啞鈴臥推', slot: 'horizontal_push', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Standing_Military_Press', name: '站姿肩推', slot: 'vertical_push', upperLower: 'upper', minWeight: 20, metric: 'reps' },
  { id: 'Seated_Dumbbell_Press', name: '坐姿啞鈴推', slot: 'vertical_push', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Bent_Over_Barbell_Row', name: '槓鈴划船', slot: 'horizontal_pull', upperLower: 'upper', minWeight: 20, metric: 'reps' },
  { id: 'Seated_Cable_Rows', name: '坐姿繩索划船', slot: 'horizontal_pull', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Wide-Grip_Lat_Pulldown', name: '寬握高位下拉', slot: 'vertical_pull', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Pullups', name: '引體向上', slot: 'vertical_pull', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Plank', name: '平板支撐', slot: 'core', upperLower: 'upper', minWeight: 0, metric: 'seconds' },
  { id: 'Hanging_Leg_Raise', name: '懸垂舉腿', slot: 'core', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Cable_Crunch', name: '繩索捲腹', slot: 'core', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Barbell_Curl', name: '槓鈴彎舉', slot: 'accessory', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Triceps_Pushdown', name: '三頭下壓', slot: 'accessory', upperLower: 'upper', minWeight: 0, metric: 'reps' },
  { id: 'Face_Pull', name: '面拉', slot: 'accessory', upperLower: 'upper', minWeight: 0, metric: 'reps' }
];
var NOPREFS = { swaps: {}, banned: [] };

check('splitFor：3 日 = A/B/C', function () {
  var s = GymEngine.splitFor(3);
  eq(s.length, 3);
  eq(s.map(function (d) { return d.day; }), ['A', 'B', 'C']);
});

check('splitFor：2/4/5 日都有定義', function () {
  eq(GymEngine.splitFor(2).length, 2);
  eq(GymEngine.splitFor(4).length, 4);
  eq(GymEngine.splitFor(5).length, 5);
});

check('3 日 split：Day A 同 Day C 嘅 squat variant 唔同', function () {
  var s = GymEngine.splitFor(3);
  var a = s[0].slots.filter(function (x) { return x.slot === 'squat'; })[0];
  var c = s[2].slots.filter(function (x) { return x.slot === 'squat'; })[0];
  eq(a.variant !== c.variant, true, 'variant 應該唔同，否則 A 同 C 會做同一個動作');
});

check('nextDay：未練過 → 由 Day A 開始', function () {
  eq(GymEngine.nextDay({ daysPerWeek: 3 }, []).day, 'A');
});

check('nextDay：做完 A → 下一次係 B', function () {
  var s = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8]])];
  s[0].day = 'A';
  eq(GymEngine.nextDay({ daysPerWeek: 3 }, s).day, 'B');
});

check('nextDay：做完 C → 循環返 A', function () {
  var s = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8]])];
  s[0].day = 'C';
  eq(GymEngine.nextDay({ daysPerWeek: 3 }, s).day, 'A');
});

check('nextDay：跳過一日唔會令循環錯位', function () {
  var s = [
    sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8]]),
    sess('2026-08-20', 'Barbell_Squat', 40, 8, [[40,8],[40,8]])
  ];
  s[0].day = 'A'; s[1].day = 'B';
  eq(GymEngine.nextDay({ daysPerWeek: 3 }, s).day, 'C', '隔咗 9 日照樣接落去 C');
});

check('nextDay：未完成嘅 session 唔算數', function () {
  var s = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8]])];
  s[0].day = 'A'; s[0].done = false;
  eq(GymEngine.nextDay({ daysPerWeek: 3 }, s).day, 'A');
});

check('pickExercise：variant 0 同 1 揀到唔同動作', function () {
  var a = GymEngine.pickExercise({ slot: 'squat', variant: 0 }, EXDB, NOPREFS);
  var b = GymEngine.pickExercise({ slot: 'squat', variant: 1 }, EXDB, NOPREFS);
  eq(a.id !== b.id, true);
});

check('pickExercise：同一輸入永遠揀到同一個（deterministic）', function () {
  var a = GymEngine.pickExercise({ slot: 'squat', variant: 0 }, EXDB, NOPREFS);
  var b = GymEngine.pickExercise({ slot: 'squat', variant: 0 }, EXDB, NOPREFS);
  eq(a.id, b.id);
});

check('pickExercise：swaps 覆蓋預設', function () {
  var prefs = { swaps: { 'squat:0': 'Leg_Press' }, banned: [] };
  eq(GymEngine.pickExercise({ slot: 'squat', variant: 0 }, EXDB, prefs).id, 'Leg_Press');
});

check('pickExercise：banned 嘅動作永不出現', function () {
  var prefs = { swaps: {}, banned: ['Barbell_Squat', 'Front_Barbell_Squat'] };
  eq(GymEngine.pickExercise({ slot: 'squat', variant: 0 }, EXDB, prefs).id, 'Leg_Press');
});

check('pickExercise：banned 咗嘅動作即使喺 swaps 都唔用', function () {
  var prefs = { swaps: { 'squat:0': 'Barbell_Squat' }, banned: ['Barbell_Squat'] };
  eq(GymEngine.pickExercise({ slot: 'squat', variant: 0 }, EXDB, prefs).id !== 'Barbell_Squat', true);
});

check('pickExercise：全部 banned → 回傳 null', function () {
  var prefs = { swaps: {}, banned: ['Barbell_Squat', 'Front_Barbell_Squat', 'Leg_Press'] };
  eq(GymEngine.pickExercise({ slot: 'squat', variant: 0 }, EXDB, prefs), null);
});

check('buildWorkout：每個 slot 都揀到動作，冇空 slot', function () {
  var w = GymEngine.buildWorkout({
    profile: { daysPerWeek: 3, intensity: 'medium', startDate: '2026-08-11',
               increments: { upper: 2.5, lower: 5 } },
    prefs: NOPREFS, exercises: EXDB, sessions: [], today: '2026-08-11'
  });
  eq(w.day, 'A');
  eq(w.entries.every(function (e) { return !!e.exerciseId; }), true);
  eq(w.entries.length > 0, true);
});

check('buildWorkout：第 1 週 medium → 每個動作只出 2 組', function () {
  var w = GymEngine.buildWorkout({
    profile: { daysPerWeek: 3, intensity: 'medium', startDate: '2026-08-11',
               increments: { upper: 2.5, lower: 5 } },
    prefs: NOPREFS, exercises: EXDB, sessions: [], today: '2026-08-11'
  });
  eq(w.entries.every(function (e) { return e.target.sets === 2; }), true);
});

check('buildWorkout：第 2 週 medium → 恢復 3 組', function () {
  var w = GymEngine.buildWorkout({
    profile: { daysPerWeek: 3, intensity: 'medium', startDate: '2026-08-11',
               increments: { upper: 2.5, lower: 5 } },
    prefs: NOPREFS, exercises: EXDB, sessions: [], today: '2026-08-19'
  });
  eq(w.entries.every(function (e) { return e.target.sets === 3; }), true);
});

check('buildWorkout：medium 加 1 個輔助動作', function () {
  var w = GymEngine.buildWorkout({
    profile: { daysPerWeek: 3, intensity: 'medium', startDate: '2026-08-11',
               increments: { upper: 2.5, lower: 5 } },
    prefs: NOPREFS, exercises: EXDB, sessions: [], today: '2026-08-19'
  });
  eq(w.entries.filter(function (e) { return e.slot === 'accessory'; }).length, 1);
});

check('buildWorkout：light 冇輔助動作', function () {
  var w = GymEngine.buildWorkout({
    profile: { daysPerWeek: 3, intensity: 'light', startDate: '2026-08-11',
               increments: { upper: 2.5, lower: 5 } },
    prefs: NOPREFS, exercises: EXDB, sessions: [], today: '2026-08-19'
  });
  eq(w.entries.filter(function (e) { return e.slot === 'accessory'; }).length, 0);
});

check('buildWorkout：ramp-back 期同一區塊內唔加重', function () {
  var prev = sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]]);
  prev.day = 'C';   // 令 nextDay 回到 A
  var w = GymEngine.buildWorkout({
    profile: { daysPerWeek: 3, intensity: 'medium', startDate: '2026-08-11',
               increments: { upper: 2.5, lower: 5 } },
    prefs: NOPREFS, exercises: EXDB, sessions: [prev], today: '2026-08-13'
  });
  var squat = w.entries.filter(function (e) { return e.exerciseId === 'Barbell_Squat'; })[0];
  eq(squat.target.weight, 40, '同一 7 日區塊內唔可以加重');
});

check('buildWorkout：restSec 跟強度', function () {
  var w = GymEngine.buildWorkout({
    profile: { daysPerWeek: 3, intensity: 'medium', startDate: '2026-08-11',
               increments: { upper: 2.5, lower: 5 } },
    prefs: NOPREFS, exercises: EXDB, sessions: [], today: '2026-08-19'
  });
  eq(w.restSec, 120);
});

// ---- canIncrease：ramp-back cap 住喺 nextTarget 入面 ----
check('nextTarget：canIncrease=false 時即使達標都唔加重', function () {
  var sessions = [sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]])];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8, canIncrease: false }), { weight: 40, reps: 8 });
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8, canIncrease: true }), { weight: 45, reps: 8 });
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Barbell_Squat',
       exercise: SQUAT, increments: INC, reps: 8 }), { weight: 45, reps: 8 }, '唔傳等於准許');
});

check('nextTarget：canIncrease=false 對計時動作同樣有效', function () {
  var sessions = [{
    date: '2026-08-11', day: 'A', done: true, note: '',
    entries: [{ slot: 'core', exerciseId: 'Plank',
                target: { sets: 3, reps: 45, weight: 0 },
                actual: [{ w: 0, r: 45 }, { w: 0, r: 45 }, { w: 0, r: 45 }] }]
  }];
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Plank', exercise: PLANK,
       increments: INC, reps: 45, canIncrease: false }), { weight: 0, reps: 45 });
  eq(GymEngine.nextTarget({ sessions: sessions, exerciseId: 'Plank', exercise: PLANK,
       increments: INC, reps: 45, canIncrease: true }), { weight: 0, reps: 50 });
});

check('buildWorkout：輔助動作跟 day 輪換，唔會日日都係同一個', function () {
  var profile = { daysPerWeek: 3, intensity: 'medium', startDate: '2026-08-11',
                  increments: { upper: 2.5, lower: 5 } };
  var seen = [], sessions = [];
  GymEngine.splitFor(3).forEach(function () {
    var w = GymEngine.buildWorkout({ profile: profile, prefs: NOPREFS, exercises: EXDB,
                                     sessions: sessions, today: '2026-08-19' });
    var acc = w.entries.filter(function (e) { return e.slot === 'accessory'; });
    eq(acc.length, 1, '每日應該有一個輔助動作');
    seen.push(acc[0].exerciseId);
    sessions.push({ date: '2026-08-19', day: w.day, done: true, note: '',
                    entries: w.entries.map(function (e) {
                      return { slot: e.slot, variant: e.variant, exerciseId: e.exerciseId,
                               target: e.target, actual: [] };
                    }) });
  });
  eq(seen.length, 3);
  eq(seen[0] !== seen[1] && seen[1] !== seen[2] && seen[0] !== seen[2], true,
     'Day A/B/C 嘅輔助動作應該三個都唔同，實際：' + seen.join('、'));
});

// ---- mergeData ----
function mkData(sessions, updatedAt) {
  return { v: 1, profile: { daysPerWeek: 3, updatedAt: updatedAt || '2026-08-11T00:00:00Z' },
           prefs: { swaps: {}, banned: [] }, sessions: sessions || [] };
}

check('mergeData：遠端獨有嘅 session 會保留', function () {
  var local = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8]])]);
  var remote = mkData([sess('2026-08-14', 'Barbell_Squat', 45, 8, [[45,8]])]);
  remote.sessions[0].day = 'B';
  var m = GymEngine.mergeData(local, remote);
  eq(m.sessions.length, 2);
});

check('mergeData：同 date+day 衝突時本地贏', function () {
  var local = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]])]);
  var remote = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,5]])]);
  var m = GymEngine.mergeData(local, remote);
  eq(m.sessions.length, 1);
  eq(m.sessions[0].entries[0].actual.length, 3, '本地嗰份（3 組）應該贏');
});

check('mergeData：結果按日期排序', function () {
  var local = mkData([sess('2026-08-20', 'Barbell_Squat', 40, 8, [[40,8]])]);
  var remote = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8]])]);
  remote.sessions[0].day = 'B';
  var m = GymEngine.mergeData(local, remote);
  eq(m.sessions.map(function (x) { return x.date; }), ['2026-08-11', '2026-08-20']);
});

check('mergeData：profile 取 updatedAt 較新嗰個', function () {
  var local = mkData([], '2026-08-11T00:00:00Z');
  var remote = mkData([], '2026-08-20T00:00:00Z');
  remote.profile.daysPerWeek = 4;
  eq(GymEngine.mergeData(local, remote).profile.daysPerWeek, 4);
});

check('mergeData：本地 profile 較新就用本地', function () {
  var local = mkData([], '2026-08-20T00:00:00Z');
  local.profile.daysPerWeek = 5;
  var remote = mkData([], '2026-08-11T00:00:00Z');
  eq(GymEngine.mergeData(local, remote).profile.daysPerWeek, 5);
});

check('mergeData：遠端係 null（首次）→ 直接用本地', function () {
  var local = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8]])]);
  eq(GymEngine.mergeData(local, null).sessions.length, 1);
});

check('mergeData：本地 profile 係 null → 用遠端', function () {
  var local = mkData([]);
  local.profile = null;
  var remote = mkData([], '2026-08-11T00:00:00Z');
  eq(GymEngine.mergeData(local, remote).profile.daysPerWeek, 3);
});

check('mergeData：本地未完成唔可以蓋走遠端已完成', function () {
  var local = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,2]])]);
  local.sessions[0].done = false;
  var remote = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,8],[40,8],[40,8]])]);
  var m = GymEngine.mergeData(local, remote);
  eq(m.sessions.length, 1);
  eq(m.sessions[0].done, true, '遠端已完成嗰份應該保住');
  eq(m.sessions[0].entries[0].actual.length, 3);
});

check('mergeData：兩邊都未完成時本地照樣贏', function () {
  var local = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,5],[40,5]])]);
  local.sessions[0].done = false;
  var remote = mkData([sess('2026-08-11', 'Barbell_Squat', 40, 8, [[40,1]])]);
  remote.sessions[0].done = false;
  eq(GymEngine.mergeData(local, remote).sessions[0].entries[0].actual.length, 2);
});
