/* 加插「每月所得金額」+「每日所得金額」兩個欄位。
   每日 = (最終金額 - 本金) / 總日數；每月 = 每日 × 365 / 12。
   計算機係會不停重繪嘅 React app，會反覆移除外來節點。
   對策：造持久節點 hold 住，每 150ms 寫入快取值 + 保持次序（每月 → 每日 排最尾）。 */
(function () {
  var UNIT_DAYS = { "年": 365, "月": 30, "週": 7, "周": 7, "日": 1, "天": 1, "季": 91 };
  var lastDaily = "", lastMonthly = "";
  var monthlyNode = null, monthlyInput = null;
  var dailyNode = null, dailyInput = null;

  function num(el) { return el ? (parseFloat(el.value) || 0) : 0; }

  function unitDays() {
    var labels = document.querySelectorAll("#app label");
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.indexOf("單位") !== -1) {
        var sel = labels[i].parentElement.querySelector("select");
        if (sel && sel.selectedIndex >= 0) {
          return UNIT_DAYS[sel.options[sel.selectedIndex].text.trim()] || 365;
        }
      }
    }
    return 365;
  }

  function fmt(x) { return x.toLocaleString("en-US", { maximumFractionDigits: 2 }); }

  function compute() {
    var pv = document.querySelector('#app input[name="pv"]');
    var fv = document.querySelector('#app input[name="fv"]');
    var nper = document.querySelector('#app input[name="nper"]');
    if (!pv || !fv || !nper) return null;
    if (pv.value === "" || fv.value === "" || nper.value === "") return null;
    var days = num(nper) * unitDays();
    if (days <= 0) return null;
    var daily = (num(fv) - num(pv)) / days;
    if (!isFinite(daily)) return null;
    return { daily: fmt(daily), monthly: fmt(daily * 365 / 12) };
  }

  // 由「最終金額」欄位 clone 出一個唯讀顯示欄位
  function makeField(fvDiv, labelText) {
    var node = fvDiv.cloneNode(true);
    node.removeAttribute("id");
    var label = node.querySelector("label");
    if (label) { label.textContent = labelText; label.removeAttribute("for"); }
    var input = node.querySelector("input");
    if (input) {
      input.type = "text";            // number input 唔收逗號，改 text 先顯示到 "8,219.18"
      input.readOnly = true;
      input.removeAttribute("name");
      input.removeAttribute("id");
      input.style.backgroundColor = "#f4f5f7";
    }
    return { node: node, input: input };
  }

  function tick() {
    var fv = document.querySelector('#app input[name="fv"]');
    var pv = document.querySelector('#app input[name="pv"]');
    if (!fv || !pv) return;

    var val = compute();
    if (val) { lastDaily = val.daily; lastMonthly = val.monthly; }

    if (!monthlyNode) { var m = makeField(fv.closest("div"), "每月所得金額"); monthlyNode = m.node; monthlyInput = m.input; }
    if (!dailyNode)   { var d = makeField(fv.closest("div"), "每日所得金額"); dailyNode = d.node; dailyInput = d.input; }
    if (monthlyInput) monthlyInput.value = lastMonthly;
    if (dailyInput)   dailyInput.value = lastDaily;

    // 保持次序：每月 → 每日，兩個永遠排喺 grid 最尾
    var grid = pv.closest("div").parentElement;
    if (grid) {
      var ok = monthlyNode.parentElement === grid && dailyNode.parentElement === grid
            && monthlyNode.nextElementSibling === dailyNode
            && dailyNode.nextElementSibling === null;
      if (!ok) { grid.appendChild(monthlyNode); grid.appendChild(dailyNode); }
    }
  }

  // ---- 一次性設定開頁預設：算最終金額 tab、報酬率 10%、投資期間 1 ----
  // React 受控 input：用原生 setter + input event；全程 try/catch，
  // 就算喺 Apps Script 沙盒失敗都唔會拖冧下面個每日所得欄位。
  function setVal(el, v) {
    try {
      var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      if (d && d.set) d.set.call(el, v); else el.value = v;
    } catch (e) { try { el.value = v; } catch (e2) {} }
    try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
  }
  function findTab(name) {
    var all = document.querySelectorAll("#app *");
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length === 0 && all[i].textContent.trim() === name) return all[i];
    }
    return null;
  }
  var dTries = 0, dDone = false;
  function applyDefaults() {                 // 有上限重試，成功即停；失敗都唔會 throw 出去
    if (dDone) return;
    dTries++;
    try {
      var tab = findTab("算最終金額");
      if (tab) tab.click();                  // 切到「算最終金額」，報酬率喺呢度先當輸入
      var rate = document.querySelector('#app input[name="rate"]');
      var nper = document.querySelector('#app input[name="nper"]');
      if (rate && nper) {
        setVal(rate, "10");
        setVal(nper, "1");
        dDone = true;
        return;
      }
    } catch (e) {}
    if (dTries < 40) setTimeout(applyDefaults, 200);
  }

  function start() {
    if (!document.getElementById("app")) { setTimeout(start, 300); return; }
    setInterval(tick, 150);                  // 每日所得欄位獨立運作，唔靠設預設
    tick();
    applyDefaults();                         // 盡力設預設；成功一次後唔再覆寫用戶輸入
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
