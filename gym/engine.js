/* GymEngine — 純邏輯，唔准掂 DOM / localStorage / fetch。
   Classic script（非 ES module），令 test.html 由 file:// 直接開得到。 */
var GymEngine = (function () {
  'use strict';

  var MS_PER_DAY = 86400000;

  /** 四捨五入到最接近嘅 step 倍數（避免浮點誤差） */
  function roundToStep(x, step) {
    return Math.round(Math.round(x / step) * step * 1000) / 1000;
  }

  /** 由 startDate 起計嘅 7 日區塊編號（0-based）。唔跟星期一至日。 */
  function weekIndex(startDate, date) {
    var a = Date.parse(startDate + 'T00:00:00Z');
    var b = Date.parse(date + 'T00:00:00Z');
    return Math.floor((b - a) / MS_PER_DAY / 7);
  }

  var DELOAD_FACTOR = 0.9;
  var FIRST_TIME_FACTOR = 0.65;
  var NEAR_MISS_RATIO = 0.8;
  var SECONDS_INCREMENT = 5;
  // 最細槓片 1.25kg，左右各一塊 → 槓鈴總重最細變動 2.5kg。
  // 唔對齊就會出 37kg / 38.75kg 呢啲上唔到槓嘅數。
  var PLATE_STEP = 2.5;

  /** 該 entry 係咪全部組都做夠目標次數 */
  function allHit(entry) {
    if (entry.actual.length < entry.target.sets) return false;
    return entry.actual.every(function (s) { return s.r >= entry.target.reps; });
  }

  /** 由新到舊取出已完成 session 入面該動作嘅 entry */
  function historyFor(sessions, exerciseId) {
    var out = [];
    for (var i = sessions.length - 1; i >= 0; i--) {
      if (!sessions[i].done) continue;
      var e = sessions[i].entries.filter(function (x) { return x.exerciseId === exerciseId; });
      for (var j = 0; j < e.length; j++) out.push({ entry: e[j], session: sessions[i] });
    }
    return out;
  }

  function lastEntryFor(sessions, exerciseId) {
    var h = historyFor(sessions, exerciseId);
    return h.length ? h[0] : null;
  }

  /** 連續「未全部達標」次數。遇到重量下降（即嗰次已 deload 過）就停 ——
      冇呢個停止條件，deload 之後再失手一次會即刻再 deload，一路插落去。 */
  function failStreak(sessions, exerciseId) {
    var h = historyFor(sessions, exerciseId);
    var n = 0;
    for (var i = 0; i < h.length; i++) {
      if (allHit(h[i].entry)) break;
      n++;
      var older = h[i + 1];
      if (older && h[i].entry.target.weight < older.entry.target.weight) break;
    }
    return n;
  }

  function deload(weight, exercise) {
    return Math.max(exercise.minWeight, roundToStep(weight * DELOAD_FACTOR, PLATE_STEP));
  }

  /**
   * 計算下次目標。
   * opts = { sessions, exerciseId, exercise, increments, reps, estimate? }
   * 回傳 { weight, reps }
   */
  function nextTarget(opts) {
    var ex = opts.exercise;
    var last = lastEntryFor(opts.sessions, opts.exerciseId);
    var isTimed = ex.metric === 'seconds';

    if (!last) {
      if (isTimed) return { weight: 0, reps: opts.reps };
      var base = opts.estimate
        ? roundToStep(opts.estimate * FIRST_TIME_FACTOR, PLATE_STEP)
        : ex.minWeight;
      return { weight: Math.max(ex.minWeight, base), reps: opts.reps };
    }

    var e = last.entry;
    var hit = allHit(e);

    if (isTimed) {
      return { weight: 0, reps: hit ? e.target.reps + SECONDS_INCREMENT : e.target.reps };
    }

    if (hit) {
      return { weight: e.target.weight + opts.increments[ex.upperLower], reps: opts.reps };
    }

    var targetN = e.target.sets * e.target.reps;
    var actualN = e.actual.reduce(function (a, s) { return a + s.r; }, 0);

    if (actualN < targetN * NEAR_MISS_RATIO) return { weight: deload(e.target.weight, ex), reps: opts.reps };
    if (failStreak(opts.sessions, opts.exerciseId) >= 2) return { weight: deload(e.target.weight, ex), reps: opts.reps };
    return { weight: e.target.weight, reps: opts.reps };
  }

  var INTENSITY = {
    light:  { sets: 2, reps: 12, rpe: '6-7', restSec: 90,  accessories: 0 },
    medium: { sets: 3, reps: 8,  rpe: '7-8', restSec: 120, accessories: 1 },
    heavy:  { sets: 4, reps: 6,  rpe: '8-9', restSec: 180, accessories: 2 }
  };

  var RAMP_WEEKS = 4;          // 頭 4 個 7 日區塊屬 ramp-back 期
  var UNLOCK_WEEKS = 4;
  var UNLOCK_SESSIONS_PER_DAY = 3;   // daysPerWeek × 3

  /** 第 1 個區塊（weekIdx 0）一律封頂 2 組 */
  function setsForWeek(intensity, weekIdx) {
    var base = INTENSITY[intensity].sets;
    return weekIdx === 0 ? Math.min(base, 2) : base;
  }

  /** Ramp-back 期內，同一個 7 日區塊唔准為同一動作加第二次重 */
  function canIncreaseThisWeek(sessions, exerciseId, startDate, today) {
    var wk = weekIndex(startDate, today);
    if (wk >= RAMP_WEEKS) return true;
    var last = lastEntryFor(sessions, exerciseId);
    if (!last) return true;
    return weekIndex(startDate, last.session.date) !== wk;
  }

  /** 「重」強度解鎖狀態。時間管肌腱適應，次數管動作熟練度，兩個都要。 */
  function heavyUnlock(profile, sessions, today) {
    var sessionsDone = sessions.filter(function (s) { return s.done; }).length;
    var weeksDone = weekIndex(profile.startDate, today);
    var sessionsNeeded = profile.daysPerWeek * UNLOCK_SESSIONS_PER_DAY;
    var earned = weeksDone >= UNLOCK_WEEKS && sessionsDone >= sessionsNeeded;
    var forced = !!profile.intensityUnlockForced;
    return {
      unlocked: earned || !!profile.intensityUnlockedAt,
      forced: forced,
      weeksDone: weeksDone,
      weeksNeeded: UNLOCK_WEEKS,
      sessionsDone: sessionsDone,
      sessionsNeeded: sessionsNeeded
    };
  }

  return {
    roundToStep: roundToStep,
    weekIndex: weekIndex,
    allHit: allHit,
    lastEntryFor: lastEntryFor,
    failStreak: failStreak,
    nextTarget: nextTarget,
    INTENSITY: INTENSITY,
    setsForWeek: setsForWeek,
    canIncreaseThisWeek: canIncreaseThisWeek,
    heavyUnlock: heavyUnlock
  };
})();
