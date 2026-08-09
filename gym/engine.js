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

  return {
    roundToStep: roundToStep,
    weekIndex: weekIndex
  };
})();
