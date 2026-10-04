// sabr.js — YouTube SABR 串流嘅最細解碼／改寫工具（冇任何依賴）
//
// YouTube 網頁播放器而家用 SABR（Server ABR）攞片：播放器 POST 一個 protobuf
// （VideoPlaybackAbrRequest）去 googlevideo.com/videoplayback，話畀伺服器知
// 「我播到邊（playerTimeMs）、已經有咗邊幾段（bufferedRanges）」；伺服器就用 UMP
// 格式回傳下一批片段，另外夾一個 NEXT_REQUEST_POLICY 話畀播放器知「預載到幾遠就停」。
// 伺服器只會按 playerTimeMs 計，送前面一小段（大約一兩分鐘）。
//
// 所以要預載成條片，要改兩樣嘢：
//   1. 請求：將 playerTimeMs 改做「由而家播放位置連續預載到嘅尾」，伺服器就會由嗰度繼續送；
//   2. 回應：將 NEXT_REQUEST_POLICY 嘅目標預載長度調高，播放器先會不停咁再要。
// 欄位編號參考咗開源專案 LuanRT/googlevideo（MIT）整理嘅協定定義，程式係自己寫。
//
// 呢個檔案同時畀 page.js（瀏覽器）同 test/sabr.test.js（node）用。
(function (root) {
  'use strict';

  // UMP part 種類（只列用到嘅）
  const PART = { NEXT_REQUEST_POLICY: 35, FORMAT_INITIALIZATION_METADATA: 42 };

  // ---------------------------------------------------------------------------
  // UMP 變長整數（唔係 protobuf varint）：第一個 byte 開頭有幾多個 1 就代表總長度
  //   0xxxxxxx → 1 byte、10xxxxxx → 2、110xxxxx → 3、1110xxxx → 4、11110000 + 4 byte LE → 5
  // ---------------------------------------------------------------------------
  function umpVarLen(b0) {
    return b0 < 0x80 ? 1 : b0 < 0xC0 ? 2 : b0 < 0xE0 ? 3 : b0 < 0xF0 ? 4 : 5;
  }

  // bytes: 長度啱啱好嘅 array-like
  function decodeUmpVar(bytes) {
    const b = bytes;
    switch (b.length) {
      case 1: return b[0];
      case 2: return (b[0] & 0x3F) + 64 * b[1];
      case 3: return (b[0] & 0x1F) + 32 * (b[1] + 256 * b[2]);
      case 4: return (b[0] & 0x0F) + 16 * (b[1] + 256 * (b[2] + 256 * b[3]));
      default: return b[1] + 256 * (b[2] + 256 * (b[3] + 256 * b[4]));
    }
  }

  function encodeUmpVar(n) {
    if (n < 0 || n > 0xFFFFFFFF || n !== Math.floor(n)) throw new RangeError('UMP 整數超出範圍: ' + n);
    if (n < 0x80) return Uint8Array.of(n);
    if (n < 0x4000) return Uint8Array.of(0x80 | (n & 0x3F), n >>> 6);
    if (n < 0x200000) return Uint8Array.of(0xC0 | (n & 0x1F), (n >>> 5) & 0xFF, n >>> 13);
    if (n < 0x10000000) return Uint8Array.of(0xE0 | (n & 0x0F), (n >>> 4) & 0xFF, (n >>> 12) & 0xFF, n >>> 20);
    return Uint8Array.of(0xF0, n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, n >>> 24);
  }

  // ---------------------------------------------------------------------------
  // protobuf：只做「拆欄位、換某幾個欄位、其餘原封不動」
  // 數值用 Number 計（playerTimeMs 呢類毫秒數遠低過 2^53，夠用）
  // ---------------------------------------------------------------------------
  function readVarint(buf, pos) {
    let result = 0, mul = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) throw new Error('varint 斷咗');
      const b = buf[pos++];
      result += (b & 0x7F) * mul;
      if (b < 0x80) return [result, pos];
      mul *= 128;
    }
    throw new Error('varint 太長');
  }

  function encodeVarint(n) {
    if (n < 0 || n !== Math.floor(n) || n > Number.MAX_SAFE_INTEGER) throw new RangeError('varint 超出範圍: ' + n);
    const out = [];
    while (n >= 0x80) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return Uint8Array.from(out);
  }

  // 回傳 [{no, wt, start, end, vStart, vEnd, value}]；start/end 係成個欄位（連 key），
  // vStart/vEnd 係內容（LEN 欄位唔包長度前綴）。格式唔啱就 throw，叫用方原封不動放行。
  function parseFields(buf, start, end) {
    start = start || 0;
    end = end === undefined ? buf.length : end;
    const fields = [];
    let pos = start;
    while (pos < end) {
      const fStart = pos;
      const kv = readVarint(buf, pos); pos = kv[1];
      const no = Math.floor(kv[0] / 8), wt = kv[0] % 8;
      let value = null, vStart = pos;
      if (wt === 0) { const r = readVarint(buf, pos); value = r[0]; pos = r[1]; }
      else if (wt === 1) pos += 8;
      else if (wt === 5) pos += 4;
      else if (wt === 2) { const r = readVarint(buf, pos); vStart = r[1]; pos = vStart + r[0]; }
      else throw new Error('唔支援嘅 wire type ' + wt);
      if (no === 0 || pos > end) throw new Error('protobuf 格式唔啱');
      fields.push({ no, wt, start: fStart, end: pos, vStart, vEnd: pos, value });
    }
    return fields;
  }

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  const varintField = (no, n) => concat([encodeVarint(no * 8), encodeVarint(n)]);
  const lenField = (no, bytes) => concat([encodeVarint(no * 8 + 2), encodeVarint(bytes.length), bytes]);

  // 用 replace(field) 決定每個欄位：回傳 undefined = 原封不動，Uint8Array = 換成呢段 bytes
  function rebuild(buf, fields, replace, extra) {
    const parts = [];
    for (const f of fields) {
      const r = replace(f);
      parts.push(r === undefined ? buf.subarray(f.start, f.end) : r);
    }
    if (extra) parts.push(...extra);
    return concat(parts);
  }

  const first = (fields, no, wt) => fields.find(f => f.no === no && f.wt === wt);

  // ---------------------------------------------------------------------------
  // 邊啲 itag 係聲音：先用回應入面 FORMAT_INITIALIZATION_METADATA 嘅 mimeType 學返，
  // 未學到就用常見聲音 itag 表頂住
  // ---------------------------------------------------------------------------
  const KNOWN_AUDIO_ITAGS = new Set([139, 140, 141, 171, 172, 233, 234, 249, 250, 251, 256, 258,
    325, 327, 328, 338, 380, 599, 600, 773, 774]);
  const learnedKinds = new Map();   // itag → 'audio' | 'video'

  function isAudioItag(itag) {
    const k = learnedKinds.get(itag);
    return k ? k === 'audio' : KNOWN_AUDIO_ITAGS.has(itag);
  }

  function itagOf(buf, f) {   // FormatId 訊息：field 1 = itag
    const itag = first(parseFields(buf, f.vStart, f.vEnd), 1, 0);
    return itag ? itag.value : -1;
  }

  // FORMAT_INITIALIZATION_METADATA：field 2 = formatId，field 5 = mimeType
  function learnFormat(payload) {
    try {
      const fields = parseFields(payload);
      const fid = first(fields, 2, 2), mime = first(fields, 5, 2);
      if (!fid || !mime) return;
      const itag = itagOf(payload, fid);
      const m = new TextDecoder().decode(payload.subarray(mime.vStart, mime.vEnd));
      if (itag >= 0 && /^(audio|video)\//.test(m)) learnedKinds.set(itag, m.slice(0, 5));
    } catch (e) { /* 學唔到就算 */ }
  }

  // BufferedRange：1 formatId、2 startTimeMs、3 durationMs、6 timeRange{1 startTicks, 2 durationTicks, 3 timescale}
  function readBufferedRange(buf, f) {
    const fs = parseFields(buf, f.vStart, f.vEnd);
    const fid = first(fs, 1, 2);
    let start = (first(fs, 2, 0) || {}).value || 0;
    let dur = (first(fs, 3, 0) || {}).value || 0;
    const tr = first(fs, 6, 2);
    if (!dur && tr) {
      const t = parseFields(buf, tr.vStart, tr.vEnd);
      const scale = (first(t, 3, 0) || {}).value || 0;
      if (scale) {
        start = ((first(t, 1, 0) || {}).value || 0) * 1000 / scale;
        dur = ((first(t, 2, 0) || {}).value || 0) * 1000 / scale;
      }
    }
    return { itag: fid ? itagOf(buf, fid) : -1, start, end: start + dur };
  }

  // 由 t 開始一路連住嘅預載去到幾遠；t 唔喺任何一段入面就回傳 null
  const GAP_MS = 50;
  function contiguousEnd(ranges, t) {
    const rs = ranges.slice().sort((a, b) => a.start - b.start);
    let end = null;
    for (const r of rs) {
      if (end === null) {
        if (r.start <= t + GAP_MS && r.end > t) end = r.end;
      } else if (r.start <= end + GAP_MS) {
        end = Math.max(end, r.end);
      } else {
        break;
      }
    }
    return end;
  }

  // ---------------------------------------------------------------------------
  // 改請求：VideoPlaybackAbrRequest
  //   1 clientAbrState{28 playerTimeMs, 40 enabledTrackTypesBitfield}
  //   2 selectedFormatIds、3 bufferedRanges、4 playerTimeMs（舊版位置）
  // opts.maxAheadMs：最多預載幾遠（由真正播放位置計）
  // 回傳 {body, fromMs, toMs}；唔使改就回傳 null
  // ---------------------------------------------------------------------------
  function rewriteAbrRequest(body, opts) {
    const top = parseFields(body);
    const cas = first(top, 1, 2);
    if (!cas) return null;
    const casFields = parseFields(body, cas.vStart, cas.vEnd);
    const ptField = first(casFields, 28, 0);
    const playerTime = ptField ? ptField.value : 0;

    const ranges = top.filter(f => f.no === 3 && f.wt === 2).map(f => readBufferedRange(body, f));
    if (!ranges.length) return null;

    // 0 = 影音都要、1 = 只要聲、2 = 只要畫面
    const tracksField = first(casFields, 40, 0);
    const tracks = tracksField ? tracksField.value : 0;
    const want = [];
    if (tracks !== 2) want.push(true);    // 聲音
    if (tracks !== 1) want.push(false);   // 畫面

    let newTime = Infinity;
    for (const audio of want) {
      const own = ranges.filter(r => r.itag >= 0 && isAudioItag(r.itag) === audio);
      const end = contiguousEnd(own, playerTime);
      if (end === null) return null;      // 有一邊喺播放位置都未有嘢：照原本咁問（例如啱啱跳咗去新位置）
      newTime = Math.min(newTime, end);
    }
    newTime = Math.floor(newTime);
    const maxAhead = opts && opts.maxAheadMs > 0 ? opts.maxAheadMs : Infinity;
    if (!(newTime > playerTime + 1000) || newTime - playerTime >= maxAhead) return null;

    const newCas = rebuild(body, casFields,
      f => (f === ptField ? varintField(28, newTime) : undefined),
      ptField ? null : [varintField(28, newTime)]);
    const out = rebuild(body, top, f => {
      if (f === cas) return lenField(1, newCas);
      if (f.no === 4 && f.wt === 0) return varintField(4, newTime);
      return undefined;
    });
    return { body: out, fromMs: playerTime, toMs: newTime };
  }

  // ---------------------------------------------------------------------------
  // 改回應：NEXT_REQUEST_POLICY 1 targetAudioReadaheadMs、2 targetVideoReadaheadMs
  // 只會調高，唔會調低伺服器原本畀嘅數
  // ---------------------------------------------------------------------------
  function rewriteNextRequestPolicy(payload, targetMs) {
    const fields = parseFields(payload);
    const target = Math.min(Math.floor(targetMs), 0x7FFFFFFF);
    const isTarget = f => (f.no === 1 || f.no === 2) && f.wt === 0;
    const missing = [1, 2].filter(no => !fields.some(f => isTarget(f) && f.no === no));
    if (!missing.length && !fields.some(f => isTarget(f) && f.value < target)) return null;
    return rebuild(payload, fields,
      f => (isTarget(f) && f.value < target ? varintField(f.no, target) : undefined),
      missing.map(no => varintField(no, target)));
  }

  function readPolicy(payload) {
    const fields = parseFields(payload);
    const get = no => { const f = first(fields, no, 0); return f ? f.value : undefined; };
    return { targetAudioMs: get(1), targetVideoMs: get(2), backoffMs: get(4) };
  }

  // ---------------------------------------------------------------------------
  // UMP 串流改寫器：一邊收一邊放，只會攔低 wants(type, size) 嘅 part（細細個嘅控制訊息），
  // 片段資料原封不動直接放行。rewrite(type, payload) 回傳 Uint8Array 就換，否則照舊。
  // push(chunk) / flush() 回傳要輸出嘅 Uint8Array 陣列；成個 chunk 冇改就原個回傳。
  // ---------------------------------------------------------------------------
  function UmpRewriter(wants, rewrite) {
    this.wants = wants;
    this.rewrite = rewrite;
    this.hdr = [];        // 跨 chunk 未讀齊嘅 header bytes
    this.mode = 0;        // 0 = 讀 header、1 = 放行 payload、2 = 收集 payload
    this.left = 0;
    this.type = 0;
    this.origHdr = null;
    this.cap = null;
    this.capLen = 0;
  }

  UmpRewriter.prototype.push = function (chunk) {
    const out = [];
    let i = 0, runStart = 0;
    const flushRun = to => { if (to > runStart) out.push(chunk.subarray(runStart, to)); runStart = to; };

    while (i < chunk.length) {
      if (this.mode === 1) {
        const n = Math.min(this.left, chunk.length - i);
        i += n; this.left -= n;
        if (this.left === 0) this.mode = 0;
        continue;
      }
      if (this.mode === 2) {
        const n = Math.min(this.left, chunk.length - i);
        this.cap.set(chunk.subarray(i, i + n), this.capLen);
        this.capLen += n; i += n; this.left -= n;
        runStart = i;
        if (this.left === 0) { out.push(...this._finishCapture()); this.mode = 0; }
        continue;
      }

      // mode 0：讀 header（type + size 兩個 UMP 整數），可能有一截喺上一個 chunk
      const h = this.hdr.length;
      const avail = h + chunk.length - i;
      const at = k => (k < h ? this.hdr[k] : chunk[i + k - h]);
      const typeLen = umpVarLen(at(0));
      const sizeLen = avail > typeLen ? umpVarLen(at(typeLen)) : 0;
      if (!sizeLen || avail < typeLen + sizeLen) {
        // header 未齊：留低等下一個 chunk
        flushRun(i);
        for (let k = i; k < chunk.length; k++) this.hdr.push(chunk[k]);
        i = runStart = chunk.length;
        break;
      }
      const hdrBytes = [];
      for (let k = 0; k < typeLen + sizeLen; k++) hdrBytes.push(at(k));
      const type = decodeUmpVar(hdrBytes.slice(0, typeLen));
      const size = decodeUmpVar(hdrBytes.slice(typeLen));
      const consumed = typeLen + sizeLen - h;   // 今個 chunk 用咗幾多 byte 做 header

      if (this.wants(type, size)) {
        flushRun(i);
        this.hdr = [];
        i += consumed; runStart = i;
        this.type = type;
        this.origHdr = Uint8Array.from(hdrBytes);
        this.cap = new Uint8Array(size);
        this.capLen = 0;
        this.left = size;
        if (size === 0) out.push(...this._finishCapture());
        else this.mode = 2;
      } else {
        if (h) { flushRun(i); out.push(Uint8Array.from(this.hdr)); this.hdr = []; }
        i += consumed;
        this.left = size;
        this.mode = size ? 1 : 0;
      }
    }
    if (out.length === 0 && runStart === 0 && i > 0) return [chunk];
    flushRun(chunk.length);
    return out;
  };

  // 串流完咗：未完成嘅 part 原樣吐返出去（同原本一樣斷，等播放器自己處理）
  UmpRewriter.prototype.flush = function () {
    const out = [];
    if (this.mode === 2) out.push(this.origHdr, this.cap.subarray(0, this.capLen));
    if (this.hdr.length) out.push(Uint8Array.from(this.hdr));
    this.hdr = []; this.mode = 0; this.cap = null;
    return out;
  };

  UmpRewriter.prototype._finishCapture = function () {
    const payload = this.cap;
    this.cap = null;
    let next = null;
    try { next = this.rewrite(this.type, payload); } catch (e) { next = null; }
    if (!(next instanceof Uint8Array)) return [this.origHdr, payload];
    return [encodeUmpVar(this.type), encodeUmpVar(next.length), next];
  };

  const api = {
    PART, umpVarLen, decodeUmpVar, encodeUmpVar, readVarint, encodeVarint, parseFields, concat,
    varintField, lenField, isAudioItag, learnFormat, learnedKinds, contiguousEnd,
    rewriteAbrRequest, rewriteNextRequestPolicy, readPolicy, UmpRewriter,
  };

  if (typeof window === 'undefined' && typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, '__ytpbSabr', { value: api, configurable: true });
})(typeof globalThis !== 'undefined' ? globalThis : this);
