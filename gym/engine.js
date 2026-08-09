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

  return {
    roundToStep: roundToStep,
    weekIndex: weekIndex,
    allHit: allHit,
    lastEntryFor: lastEntryFor,
    failStreak: failStreak,
    nextTarget: nextTarget
  };
})();
