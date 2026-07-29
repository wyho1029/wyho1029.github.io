/* 修正原引擎浮點數 bug：100000000*1.1 = 110000000.00000001，
   引擎用 Math.ceil 就變 110000001（多 1 蚊）。
   對策：ceil 前先食走微細浮點雜訊 —— 距整數 < 1e-6 就當整數，
   真正有小數（如 .5）照舊向上取整。必須喺 calc.js 之前載入。 */
(function () {
  var _ceil = Math.ceil;
  Math.ceil = function (x) {
    var r = Math.round(x);
    return Math.abs(x - r) < 1e-6 ? r : _ceil(x);
  };
})();
