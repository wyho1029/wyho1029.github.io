// page.js — 喺 YouTube 頁面本身（MAIN world）運行，要喺 YouTube 自己啲 script 之前裝好鈎
//
// 做三件事：
//   1. 攔 fetch / XHR 去 googlevideo 嘅 SABR 請求，用 sabr.js 改請求同回應，令播放器一路預載落去；
//   2. 攔 SourceBuffer.remove：播放器想刪走「已經睇過」嘅片段時保留返，倒後就唔使再下載；
//   3. 喺播放器角落顯示預載進度。
// 任何一步出錯都會原封不動放行，最多係冇效，唔會搞到條片播唔到。
(function () {
  'use strict';
  const SABR = globalThis.__ytpbSabr;
  if (!SABR || window.__ytpbInstalled) return;
  delete globalThis.__ytpbSabr;
  Object.defineProperty(window, '__ytpbInstalled', { value: true });

  const VERSION = '1.1.0';
  const WHOLE_MS = 12 * 3600 * 1000;   // 「成條片」= 目標 12 個鐘，播放器去到片尾自然會停
  const KEEP_MARGIN_S = 10;            // 播放位置前 10 秒以內嘅刪除照做，唔好阻住播放器
  const S = { enabled: true, aheadMin: 0, keepWatched: true, overlay: true };   // aheadMin 0 = 成條片

  let DEBUG = false;
  try { DEBUG = localStorage.getItem('ytpbDebug') === '1'; } catch (e) { /* 冇 localStorage 就算 */ }
  const log = (...a) => { if (DEBUG) console.log('[YT預載]', ...a); };

  const stats = { sabrRequests: 0, spoofed: 0, policies: 0, keptRemoves: 0, quotaHits: 0, errors: 0 };
  let quotaCapMs = Infinity;   // 撞到 SourceBuffer 記憶體上限之後，自動將預載長度收細

  // ---------------------------------------------------------------------------
  // 設定：由 bridge.js（擴充功能嗰邊）用 CustomEvent 傳過嚟
  // ---------------------------------------------------------------------------
  function applySettings(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of ['enabled', 'keepWatched', 'overlay']) if (typeof o[k] === 'boolean') S[k] = o[k];
    if (typeof o.aheadMin === 'number' && o.aheadMin >= 0 && o.aheadMin <= 720) S.aheadMin = o.aheadMin;
  }
  // chrome.storage 係非同步，所以先用上次記低嘅設定頂住；fetch 會等真設定到咗先決定（最多等 0.5 秒）
  const CACHE_KEY = 'ytpb:settings';
  try { applySettings(JSON.parse(localStorage.getItem(CACHE_KEY))); } catch (e) { /* 冇就用預設 */ }
  let markReady;
  const settingsReady = new Promise(r => { markReady = r; });
  document.addEventListener('ytpb:settings', e => {
    try {
      applySettings(JSON.parse(e.detail));
      localStorage.setItem(CACHE_KEY, e.detail);
      log('設定', S);
    } catch (err) { /* 唔理 */ }
    markReady();
  });
  document.dispatchEvent(new CustomEvent('ytpb:hello'));

  const aheadLimitMs = () => Math.min(S.aheadMin > 0 ? S.aheadMin * 60000 : WHOLE_MS, quotaCapMs);

  // 只喺睇片嘅頁面做（首頁啲滑鼠停留預覽唔好幫佢預載成條片）
  const onWatchPage = () => /^\/(watch|embed\/|live\/)/.test(location.pathname);

  function mainVideo() {
    return document.querySelector('#movie_player video, .html5-video-player video');
  }

  function isSabrUrl(u) {
    if (typeof u !== 'string' || u.indexOf('/videoplayback') < 0) return false;
    try {
      const x = new URL(u, location.href);
      if (!/(^|\.)googlevideo\.com$/.test(x.hostname) || x.pathname !== '/videoplayback') return false;
      const q = x.searchParams;
      if (q.get('sabr') !== '1') return false;
      return q.get('source') !== 'yt_live_broadcast' && q.get('live') !== '1';   // 直播唔郁
    } catch (e) { return false; }
  }

  function shouldRewrite() {
    if (!S.enabled || !onWatchPage()) return false;
    const v = mainVideo();
    return !(v && v.duration === Infinity);   // 直播（duration 無限）唔郁
  }

  function toU8(body) {
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }

  // 診斷記錄：最近 80 件事（請求／回應），喺 Console 打 copy(__ytpbDump()) 就可以複製出嚟
  const events = [];
  let skippedLogged = 0;   // 唔係 SABR 嘅 videoplayback／initplayback 請求，記低頭 10 個方便診斷
  const sec = ms => (ms === undefined || ms === null ? '-' : (ms / 1000).toFixed(1));
  function note(o) {
    o.t = performance.now() / 1000;
    const v = mainVideo();
    if (v) { o.ct = v.currentTime; o.ahead = bufferedAhead(v); o.paused = v.paused; }
    events.push(o);
    if (events.length > 80) events.shift();
  }

  // 改請求 body；唔使改或者改唔到就回傳 null
  function rewriteRequestBody(u8, via) {
    stats.sabrRequests++;
    if (!u8) { note({ k: 'req', via, reason: 'body-not-binary' }); return null; }
    if (!shouldRewrite()) { note({ k: 'req', via, reason: 'off-or-not-watch' }); return null; }
    const info = {};
    try {
      const r = SABR.rewriteAbrRequest(u8, { maxAheadMs: aheadLimitMs() }, info);
      note(Object.assign({ k: 'req', via, bytes: u8.byteLength, sent: r ? r.toMs : null }, info));
      if (!r) return null;
      stats.spoofed++;
      log(`請求：播放位置 ${(r.fromMs / 1000).toFixed(1)}s，改為由 ${(r.toMs / 1000).toFixed(1)}s 繼續要`);
      return r.body;
    } catch (e) {
      stats.errors++;
      note({ k: 'req', via, reason: 'error: ' + e.message });
      log('改請求失敗，照原本送出', e);
      return null;
    }
  }

  const MAX_CAPTURE = 1 << 20;   // 控制訊息好細；超過 1MB 嘅 part 一定唔係，直接放行
  // sum：記低今個回應有咩 part、送咗邊段片、policy 原本係幾多（診斷用）
  function makeRewriter(sum) {
    const P = SABR.PART;
    const watched = t => t === P.NEXT_REQUEST_POLICY || t === P.FORMAT_INITIALIZATION_METADATA || t === P.MEDIA_HEADER || t === P.SABR_SEEK;
    return new SABR.UmpRewriter(
      (type, size) => {
        sum.parts[type] = (sum.parts[type] || 0) + 1;
        return size <= MAX_CAPTURE && watched(type);
      },
      (type, payload) => {
        if (type === P.FORMAT_INITIALIZATION_METADATA) { SABR.learnFormat(payload); return null; }
        if (type === P.MEDIA_HEADER) {
          const h = SABR.readMediaHeader(payload);
          if (!h.init && h.startMs !== undefined) {
            const m = sum.media[h.itag] || (sum.media[h.itag] = { from: Infinity, to: 0, n: 0 });
            m.from = Math.min(m.from, h.startMs);
            m.to = Math.max(m.to, h.startMs + (h.durMs || 0));
            m.n++;
          }
          return null;
        }
        if (type === P.SABR_SEEK) { sum.seek = true; return null; }
        sum.policy = SABR.readPolicyFull(payload);
        if (!shouldRewrite()) return null;
        const out = SABR.rewriteNextRequestPolicy(payload, aheadLimitMs());
        if (out) {
          stats.policies++;
          log('伺服器預載目標', SABR.readPolicy(payload), '→ 調高到', aheadLimitMs() / 1000, '秒');
        }
        return out;
      });
  }
  const newSummary = via => ({ k: 'res', via, parts: {}, media: {}, policy: null, seek: false });

  // 成個回應一次過改（XHR 用）
  function rewriteWhole(buf) {
    const sum = newSummary('xhr');
    const rw = makeRewriter(sum);
    const pieces = rw.push(new Uint8Array(buf)).concat(rw.flush());
    note(sum);
    if (pieces.length === 1 && pieces[0].byteLength === buf.byteLength) return buf;
    return SABR.concat(pieces).buffer;
  }

  // 串流回應（fetch 用）：一邊收一邊改，保持 byte stream（播放器可能用 BYOB reader）
  function wrapBody(stream) {
    const reader = stream.getReader();
    const sum = newSummary('fetch');
    const rw = makeRewriter(sum);
    const emit = (ctrl, pieces) => {
      const out = pieces.length === 1 ? pieces[0] : SABR.concat(pieces);
      if (!out.byteLength) return false;
      ctrl.enqueue(out);
      return true;
    };
    return new ReadableStream({
      type: 'bytes',
      async pull(ctrl) {
        // 一定要 enqueue 到嘢或者完結先好返回，否則個 stream 會停喺度
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            note(sum);
            emit(ctrl, rw.flush());
            ctrl.close();
            if (ctrl.byobRequest) ctrl.byobRequest.respond(0);   // BYOB reader 等緊嘅話要話佢知完咗
            return;
          }
          if (emit(ctrl, rw.push(value))) return;
        }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
  }

  function wrapResponse(res) {
    if (!res || !res.body || res.status !== 200) return res;
    if (/text\/|json/i.test(res.headers.get('content-type') || '')) return res;
    const out = new Response(wrapBody(res.body), { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperties(out, {
      url: { value: res.url }, redirected: { value: res.redirected }, type: { value: res.type },
    });
    return out;
  }

  // 用 Proxy 包原生函數：toString 仲係 [native code]，唔會嚇親 YouTube 自己嘅檢查
  const hook = (obj, name, apply) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = new Proxy(orig, { apply: (target, self, args) => apply(target, self, args) });
  };

  // ---------------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------------
  hook(window, 'fetch', (orig, self, args) => {
    const [input, init] = args;
    let url = null;
    try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url; } catch (e) { /* 唔理 */ }
    if (!isSabrUrl(url)) {
      if (typeof url === 'string' && /\/(videoplayback|initplayback)\?/.test(url) && skippedLogged < 10) {
        skippedLogged++;
        try { const x = new URL(url, location.href); note({ k: 'skip', host: x.hostname, path: x.pathname, sabr: x.searchParams.get('sabr') }); } catch (e) { /* 唔理 */ }
      }
      return Reflect.apply(orig, self, args);
    }
    return (async () => {
      await Promise.race([settingsReady, new Promise(r => setTimeout(r, 500))]);
      if (!S.enabled) return Reflect.apply(orig, self, args);
      let a = args;
      try {
        const body = init && init.body !== undefined ? toU8(init.body) : null;
        if (body) {
          const nb = rewriteRequestBody(body, 'fetch');
          if (nb) a = [input, Object.assign({}, init, { body: nb })];
        } else if (init && init.body != null) {
          rewriteRequestBody(null, 'fetch:' + Object.prototype.toString.call(init.body));
        } else if (input instanceof Request && input.method === 'POST' && !(init && 'body' in init)) {
          const nb = rewriteRequestBody(new Uint8Array(await input.clone().arrayBuffer()), 'fetch-req');
          if (nb) a = [new Request(input, { body: nb })].concat(args.slice(1));
        }
      } catch (e) { stats.errors++; a = args; }
      const res = await Reflect.apply(orig, self, a);
      try { return wrapResponse(res); } catch (e) { stats.errors++; return res; }
    })();
  });

  // ---------------------------------------------------------------------------
  // XMLHttpRequest（舊版播放器可能用）
  // ---------------------------------------------------------------------------
  const XHR = XMLHttpRequest.prototype;
  const xhrUrl = new WeakMap();
  const responseGetter = Object.getOwnPropertyDescriptor(XHR, 'response').get;
  hook(XHR, 'open', (orig, self, args) => {
    try { xhrUrl.set(self, String(args[1])); } catch (e) { /* 唔理 */ }
    return Reflect.apply(orig, self, args);
  });
  hook(XHR, 'send', (orig, self, args) => {
    if (!S.enabled || !isSabrUrl(xhrUrl.get(self))) return Reflect.apply(orig, self, args);
    let a = args;
    try {
      const nb = rewriteRequestBody(toU8(args[0]), 'xhr');
      if (nb) a = [nb];
      let from = null, cached = null;
      Object.defineProperty(self, 'response', {
        configurable: true,
        get() {
          const r = responseGetter.call(this);
          if (this.readyState !== 4 || !(r instanceof ArrayBuffer)) return r;
          if (from !== r) {
            from = r;
            try { cached = rewriteWhole(r); } catch (e) { stats.errors++; cached = r; }
          }
          return cached;
        },
      });
    } catch (e) { stats.errors++; a = args; }
    return Reflect.apply(orig, self, a);
  });

  // ---------------------------------------------------------------------------
  // Media Source：記住 SourceBuffer 屬於邊條片，攔 remove 同留意記憶體上限
  // ---------------------------------------------------------------------------
  const msOfSb = new WeakMap();
  const urlOfMs = new WeakMap();
  const quotaSb = new WeakSet();

  if (window.MediaSource && window.SourceBuffer) {
    hook(MediaSource.prototype, 'addSourceBuffer', (orig, self, args) => {
      const sb = Reflect.apply(orig, self, args);
      msOfSb.set(sb, self);
      return sb;
    });
    hook(URL, 'createObjectURL', (orig, self, args) => {
      const u = Reflect.apply(orig, self, args);
      if (args[0] instanceof MediaSource) {
        urlOfMs.set(args[0], u);
        quotaCapMs = Infinity;   // 新一條片，記憶體上限重新計
      }
      return u;
    });

    const SB = SourceBuffer.prototype;
    hook(SB, 'appendBuffer', (orig, self, args) => {
      try {
        return Reflect.apply(orig, self, args);
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') onQuota(self);
        throw e;
      }
    });

    hook(SB, 'remove', (orig, self, args) => {
      try {
        const [start, end] = args;
        const ms = msOfSb.get(self);
        const v = ms && videoOf(ms);
        if (S.enabled && S.keepWatched && v && !quotaSb.has(self) && !self.updating &&
            ms.readyState === 'open' && !v.seeking && isFinite(v.duration) && onWatchPage()) {
          const keepUntil = v.currentTime - KEEP_MARGIN_S;
          if (keepUntil > 0 && start < keepUntil) {
            stats.keptRemoves++;
            if (end <= keepUntil) {
              log(`保留已睇部分 ${start.toFixed(1)}–${end.toFixed(1)}s`);
              fakeUpdateEvents(self);
              return undefined;
            }
            log(`保留已睇部分 ${start.toFixed(1)}–${keepUntil.toFixed(1)}s，只刪後面`);
            return Reflect.apply(orig, self, [keepUntil, end]);
          }
        }
      } catch (e) { stats.errors++; }
      return Reflect.apply(orig, self, args);
    });
  }

  function videoOf(ms) {
    const u = urlOfMs.get(ms);
    for (const v of document.getElementsByTagName('video')) {
      if ((u && v.src === u) || v.srcObject === ms) return v;
    }
    return null;
  }

  // 冇真正刪嘢，但播放器等緊 updateend，要照樣發返啲事件畀佢
  function fakeUpdateEvents(sb) {
    setTimeout(() => {
      for (const t of ['updatestart', 'update', 'updateend']) sb.dispatchEvent(new Event(t));
    }, 0);
  }

  function onQuota(sb) {
    stats.quotaHits++;
    lastQuotaAt = performance.now();
    quotaSb.add(sb);   // 呢個 SourceBuffer 以後由得播放器自己刪嘢騰位
    const ms = msOfSb.get(sb), v = ms && videoOf(ms);
    const aheadMs = v ? bufferedAhead(v) * 1000 : 0;
    quotaCapMs = Math.min(quotaCapMs, Math.max(60000, Math.floor(aheadMs * 0.8)));
    log(`撞到記憶體上限（前面已有 ${(aheadMs / 1000).toFixed(0)}s），預載長度收細到 ${quotaCapMs / 1000}s`);
  }

  function bufferedAhead(v) {
    const t = v.currentTime, b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.3 && b.end(i) > t) return b.end(i) - t;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // 播放器自己嘅預載上限（詳見 sabr.js findReadaheadNames）
  // 播放器每次決定使唔使再要片之前，都會讀設定物件入面「預算 bytes」同「上限秒數」。
  // 我哋喺 base.js 原始碼搵返呢幾個變數名，喺設定物件建立嗰陣換成 getter：
  //   開咗預載 → 回傳大數；熄咗、唔係睇片頁或者直播 → 回傳播放器原本嘅數。
  // 播放器撞到記憶體上限會自己將呢啲數 ×0.8，呢種改動照收，等佢可以自己退返。
  // 搵唔到變數名就乜都唔做（即係同 1.0 版一樣，只係冇效）。
  // ---------------------------------------------------------------------------
  const BIG_VIDEO_BYTES = 4000 * 1048576;   // 同 Brave 參數上限一樣；記憶體唔夠時播放器會自己收細
  const BIG_AUDIO_BYTES = 300 * 1048576;
  const PLAYER_JS_RE = /\/s\/player\/([\w-]+)\/[^?#]*base\.js/;
  let lastQuotaAt = -1e9;
  const capState = { player: '', names: null, policies: 0, scope: '' };

  const capActive = () => {
    if (!S.enabled || !onWatchPage()) return false;
    const v = mainVideo();
    return !(v && v.duration === Infinity);
  };

  function defineCap(obj, name, bigFn) {
    let orig, reduced = null, last = null;
    Object.defineProperty(obj, name, {
      configurable: true, enumerable: true,
      get() {
        let v;
        if (capActive()) v = reduced !== null ? Math.min(reduced, bigFn()) : bigFn();
        else v = reduced !== null && reduced < orig ? reduced : orig;
        last = v;
        return v;
      },
      set(v) {
        // 播放器撞到記憶體上限之後會寫返「而家個數 ×0.8」：照收；其他（建立時嘅預設、高畫質調整）只記低做原本數值
        if (typeof v === 'number' && last !== null && v === Math.floor(last * 0.8) && performance.now() - lastQuotaAt < 10000) reduced = v;
        else orig = v;
      },
    });
  }

  function installCapTraps(names) {
    const list = [names.video, names.audio].concat(names.seconds ? [names.seconds] : []);
    const OP = Object.prototype;
    if (list.some(n => Object.prototype.hasOwnProperty.call(OP, n))) return;
    capState.names = names;
    capState.scope = 'Object.prototype';
    let proto = null;

    const adopt = obj => {
      capState.policies++;
      defineCap(obj, names.video, () => BIG_VIDEO_BYTES);
      defineCap(obj, names.audio, () => BIG_AUDIO_BYTES);
      if (names.seconds) defineCap(obj, names.seconds, () => aheadLimitMs() / 1000);
      if (proto) return;
      // 搵到設定物件嘅 class 之後，陷阱搬去佢自己個 prototype，唔再掛喺 Object.prototype 影響其他物件
      const p = Object.getPrototypeOf(obj);
      if (p && p !== OP && !list.some(n => Object.prototype.hasOwnProperty.call(p, n))) {
        proto = p;
        for (const n of list) Object.defineProperty(p, n, trap(n));
        for (const n of list) delete OP[n];
        capState.scope = 'class';
      }
    };
    // 第一次寫入呢個名嘅時候會經過呢度：預算 = 20MiB 嘅就係設定物件；其他物件照普通屬性處理
    const trap = name => ({
      configurable: true, enumerable: false,
      get() { return undefined; },
      set(v) {
        if (name === names.video && v === 20971520) { adopt(this); this[name] = v; return; }
        try { Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true }); } catch (e) { /* 唔理 */ }
      },
    });
    for (const n of list) Object.defineProperty(OP, n, trap(n));
    log('播放器預載上限變數', names);
  }

  function onPlayerScript(src) {
    const m = PLAYER_JS_RE.exec(src || '');
    if (!m || capState.player) return;
    capState.player = m[1];
    const key = 'ytpb:names:' + m[1];
    let names = null;
    try { names = JSON.parse(localStorage.getItem(key)); } catch (e) { /* 冇記錄 */ }
    if (!names) {
      try {
        // 同步攞：一定要喺播放器建立設定物件之前裝好；base.js 通常喺瀏覽器 cache，好快
        const x = new XMLHttpRequest();
        x.open('GET', src, false);
        x.send();
        names = (x.status === 200 && SABR.findReadaheadNames(x.responseText)) || { miss: true };
        localStorage.setItem(key, JSON.stringify(names));
      } catch (e) { names = null; }
    }
    if (names && names.video) installCapTraps(names);
  }

  const scriptWatcher = new MutationObserver(muts => {
    for (const mu of muts) for (const n of mu.addedNodes) {
      if (n.nodeName === 'SCRIPT' && n.src) onPlayerScript(n.src);
    }
    if (capState.player) scriptWatcher.disconnect();
  });
  scriptWatcher.observe(document, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // 預載進度顯示
  // ---------------------------------------------------------------------------
  let box = null;
  const fmt = sec => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  };

  function makeBox() {
    const el = document.createElement('div');
    el.id = 'ytpb-overlay';
    Object.assign(el.style, {
      position: 'absolute', left: '12px', bottom: '64px', zIndex: '61', pointerEvents: 'none',
      padding: '3px 9px', borderRadius: '6px', background: 'rgba(0,0,0,.62)', color: '#fff',
      font: '500 12px/1.6 -apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif',
      letterSpacing: '.2px', whiteSpace: 'nowrap',
    });
    return el;
  }

  function tick() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    const v = player && player.querySelector('video');
    const show = S.enabled && S.overlay && v && isFinite(v.duration) && v.duration > 0 && onWatchPage();
    if (!show) { if (box) box.style.display = 'none'; return; }
    if (!box) box = makeBox();
    if (box.parentNode !== player) player.appendChild(box);

    const b = v.buffered;
    let total = 0;
    for (let i = 0; i < b.length; i++) total += b.end(i) - b.start(i);
    const pct = Math.min(100, Math.round((total / v.duration) * 100));
    const reach = Math.min(v.duration, v.currentTime + bufferedAhead(v));
    let text = reach >= v.duration - 1
      ? `✅ 已預載到片尾 · 記憶體有全片 ${pct}%`
      : `⬇ 已預載到 ${fmt(reach)} / ${fmt(v.duration)} · 記憶體有全片 ${pct}%`;
    if (quotaCapMs < Infinity) text += ' · ⚠️ 到咗 Brave 記憶體上限';
    box.textContent = text;
    // 控制列收埋（播緊片冇郁滑鼠）嘅時候一齊收埋
    box.style.display = player.classList.contains('ytp-autohide') && !v.paused ? 'none' : 'block';
  }
  setInterval(() => { try { tick(); } catch (e) { /* 唔理 */ } }, 1000);

  // 喺 Console 打 __ytpbStats() 睇運作情況
  Object.defineProperty(window, '__ytpbStats', {
    value: () => Object.assign({ settings: Object.assign({}, S), aheadLimitSec: aheadLimitMs() / 1000 }, stats,
      { capPlayer: capState.player, capNames: capState.names, capPolicies: capState.policies, capScope: capState.scope }),
  });

  // 喺 Console 打 copy(__ytpbDump()) 會將最近嘅請求／回應記錄複製去剪貼簿，貼返出嚟就睇到每一步
  Object.defineProperty(window, '__ytpbDump', {
    value: () => {
      const v = mainVideo();
      const head = [
        'ytpb ' + VERSION + ' ' + navigator.userAgent.replace(/^.*(Chrome\/[\d.]+).*$/, '$1'),
        'stats ' + JSON.stringify(window.__ytpbStats()),
        'video ' + (v ? `t=${v.currentTime.toFixed(1)} dur=${v.duration.toFixed(1)} ahead=${bufferedAhead(v).toFixed(1)} paused=${v.paused}` : 'none'),
        'learned ' + JSON.stringify(Array.from(SABR.learnedKinds)),
      ];
      const lines = events.map(e => {
        const pre = `[${e.t.toFixed(1)}s ▶${e.ct === undefined ? '-' : e.ct.toFixed(1)} +${e.ahead === undefined ? '-' : e.ahead.toFixed(1)}${e.paused ? ' ⏸' : ''}]`;
        if (e.k === 'skip') return `${pre} SKIP ${e.host}${e.path} sabr=${e.sabr}`;
        if (e.k === 'req') {
          const ends = `a=${sec(e.audioEnd)} v=${sec(e.videoEnd)}`;
          return `${pre} REQ ${e.via} ${e.bytes || 0}B real=${sec(e.playerTime)} ` +
            (e.sent ? `→ sent=${sec(e.sent)}` : `keep (${e.reason})`) + ` ${ends} ranges=${(e.ranges || []).join(',')}`;
        }
        const media = Object.keys(e.media).map(k => `${k}:${e.media[k].n}x ${sec(e.media[k].from)}-${sec(e.media[k].to)}`).join(' ');
        const p = e.policy;
        const pol = p ? `tgtA=${sec(p.tgtA)} tgtV=${sec(p.tgtV)} minA=${sec(p.minA)} minV=${sec(p.minV)} backoff=${sec(p.backoff)} maxSince=${sec(p.maxSince)}` : 'none';
        return `${pre} RES ${e.via} media[${media}] policy[${pol}] parts=${JSON.stringify(e.parts)}${e.seek ? ' SABR_SEEK' : ''}`;
      });
      return head.concat(lines).join('\n');
    },
  });
})();
