// 跑法：node yt-prebuffer/test/sabr.test.js
// 用自己砌嘅 SABR 請求／UMP 回應去試 sabr.js：要改嘅改啱，其餘 byte 原封不動，
// 而且點樣切 chunk 都要出同一個結果。
const assert = require('assert');
const path = require('path');
const X = require(path.join(__dirname, '..', 'extension', 'sabr.js'));
const { varintField: vf, lenField: lf, concat } = X;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('✓', name);
}

// ---- 砌訊息嘅小工具 ----
const fixed32 = (no, n) => { const b = new Uint8Array(5); b[0] = no * 8 + 5; new DataView(b.buffer).setFloat32(1, n, true); return b; };
const formatId = itag => concat([vf(1, itag), vf(2, 1700000000000000)]);
const range = (itag, start, dur, seg) => lf(3, concat([lf(1, formatId(itag)), vf(2, start), vf(3, dur), vf(4, seg[0]), vf(5, seg[1])]));
const fieldMap = buf => X.parseFields(buf);
const getVarint = (buf, no) => { const f = fieldMap(buf).find(f => f.no === no && f.wt === 0); return f && f.value; };
const getSub = (buf, no) => { const f = fieldMap(buf).find(f => f.no === no && f.wt === 2); return f && buf.subarray(f.vStart, f.vEnd); };
const part = (type, payload) => concat([X.encodeUmpVar(type), X.encodeUmpVar(payload.length), payload]);

function abrRequest({ playerTime, tracks, ranges, topTime }) {
  const cas = concat([
    vf(21, 4200000),                         // bandwidthEstimate
    playerTime === undefined ? new Uint8Array(0) : vf(28, playerTime),
    fixed32(35, 1.0),                        // playbackRate（float）
    tracks === undefined ? new Uint8Array(0) : vf(40, tracks),
  ]);
  return concat([
    lf(1, cas),
    lf(2, formatId(251)), lf(2, formatId(248)),
    ...ranges,
    topTime === undefined ? new Uint8Array(0) : vf(4, topTime),
    lf(5, Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xFF)),   // ustreamer config
    lf(19, concat([lf(2, Uint8Array.of(9, 8, 7)), vf(5, 3)])),         // streamerContext
  ]);
}

// 將除咗 playerTimeMs 之外嘅欄位攞出嚟比較，確保冇郁到
function stripTime(buf) {
  const cas = getSub(buf, 1);
  const casOther = fieldMap(cas).filter(f => f.no !== 28).map(f => Buffer.from(cas.subarray(f.start, f.end)).toString('hex'));
  const topOther = fieldMap(buf).filter(f => f.no !== 1 && f.no !== 4).map(f => Buffer.from(buf.subarray(f.start, f.end)).toString('hex'));
  return { casOther, topOther };
}

// ---------------------------------------------------------------------------
test('UMP 整數：每種長度都編得返解得返', () => {
  for (const n of [0, 1, 127, 128, 300, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 4294967295]) {
    const b = X.encodeUmpVar(n);
    assert.strictEqual(X.umpVarLen(b[0]), b.length, `長度 ${n}`);
    assert.strictEqual(X.decodeUmpVar(b), n, `數值 ${n}`);
  }
  assert.throws(() => X.encodeUmpVar(2 ** 32));
});

test('protobuf varint：大過 32 bit 都啱', () => {
  for (const n of [0, 1, 300, 2 ** 31, 2 ** 40 + 5, 86400000, Number.MAX_SAFE_INTEGER]) {
    const b = X.encodeVarint(n);
    assert.deepStrictEqual(X.readVarint(b, 0), [n, b.length]);
  }
});

test('請求：playerTime 改做影音兩邊連續預載嘅尾（取細嗰邊）', () => {
  const body = abrRequest({
    playerTime: 30000, tracks: 0,
    ranges: [range(251, 0, 95000, [1, 10]), range(248, 0, 60000, [1, 12]), range(248, 60000, 60000, [13, 24])],
  });
  const r = X.rewriteAbrRequest(body, {});
  assert.ok(r);
  assert.strictEqual(r.fromMs, 30000);
  assert.strictEqual(r.toMs, 95000);
  assert.strictEqual(getVarint(getSub(r.body, 1), 28), 95000);
  assert.deepStrictEqual(stripTime(r.body), stripTime(body), '其他欄位唔可以變');
});

test('請求：畫面中間有窿就停喺窿前面', () => {
  const body = abrRequest({
    playerTime: 30000,
    ranges: [range(251, 0, 95000, [1, 10]), range(248, 0, 60000, [1, 12]), range(248, 61000, 59000, [13, 24])],
  });
  assert.strictEqual(X.rewriteAbrRequest(body, {}).toMs, 60000);
});

test('請求：唔同畫質嘅片段接得住都當連續', () => {
  const body = abrRequest({
    playerTime: 5000,
    ranges: [range(251, 0, 200000, [1, 20]), range(248, 0, 60000, [1, 12]), range(247, 60000, 40000, [13, 20])],
  });
  assert.strictEqual(X.rewriteAbrRequest(body, {}).toMs, 100000);
});

test('請求：跳咗去未預載嘅位置就照原本咁問', () => {
  const body = abrRequest({ playerTime: 200000, ranges: [range(251, 0, 95000, [1, 10]), range(248, 0, 120000, [1, 24])] });
  assert.strictEqual(X.rewriteAbrRequest(body, {}), null);
});

test('請求：已經夠 maxAheadMs 就唔再推', () => {
  const body = abrRequest({ playerTime: 30000, ranges: [range(251, 0, 95000, [1, 10]), range(248, 0, 120000, [1, 24])] });
  assert.strictEqual(X.rewriteAbrRequest(body, { maxAheadMs: 60000 }), null);
  assert.strictEqual(X.rewriteAbrRequest(body, { maxAheadMs: 70000 }).toMs, 95000);
});

test('請求：只要聲（tracks=1）就唔理畫面', () => {
  const body = abrRequest({ playerTime: 1000, tracks: 1, ranges: [range(251, 0, 95000, [1, 10])] });
  assert.strictEqual(X.rewriteAbrRequest(body, {}).toMs, 95000);
});

test('請求：冇 playerTime（啱啱開始）都識加返欄位；舊版 field 4 一齊改', () => {
  const body = abrRequest({ topTime: 0, ranges: [range(251, 0, 20000, [1, 2]), range(248, 0, 15000, [1, 3])] });
  const r = X.rewriteAbrRequest(body, {});
  assert.strictEqual(getVarint(getSub(r.body, 1), 28), 15000);
  assert.strictEqual(getVarint(r.body, 4), 15000);
  assert.deepStrictEqual(stripTime(r.body), stripTime(body));
});

test('請求：只有 timeRange（ticks）都計得到', () => {
  const tr = (itag, startTicks, durTicks) => lf(3, concat([lf(1, formatId(itag)),
    lf(6, concat([vf(1, startTicks), vf(2, durTicks), vf(3, 90000)]))]));
  const body = abrRequest({ playerTime: 1000, ranges: [tr(251, 0, 90000 * 50), tr(248, 0, 90000 * 40)] });
  assert.strictEqual(X.rewriteAbrRequest(body, {}).toMs, 40000);
});

test('請求：未知 itag 由 FORMAT_INITIALIZATION_METADATA 學返係聲定畫面', () => {
  const body = abrRequest({ playerTime: 1000, ranges: [range(901, 0, 50000, [1, 5]), range(902, 0, 70000, [1, 7])] });
  assert.strictEqual(X.rewriteAbrRequest(body, {}), null, '未學之前兩個都當畫面，冇聲 → 唔改');
  const fim = (itag, mime) => concat([lf(1, new TextEncoder().encode('abc')), lf(2, formatId(itag)), vf(3, 600000),
    lf(5, new TextEncoder().encode(mime))]);
  X.learnFormat(fim(901, 'audio/webm; codecs="opus"'));
  X.learnFormat(fim(902, 'video/webm; codecs="vp9"'));
  assert.strictEqual(X.rewriteAbrRequest(body, {}).toMs, 50000);
});

test('請求：亂碼會 throw（page.js 會接住照原本送）', () => {
  assert.throws(() => X.rewriteAbrRequest(Uint8Array.of(0x0A, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 1, 2), {}));
});

test('回應 policy：只調高目標預載，其餘照舊', () => {
  const cookie = lf(7, Uint8Array.of(1, 2, 3, 4));
  const payload = concat([vf(1, 30000), vf(2, 45000), vf(4, 0), cookie, lf(8, new TextEncoder().encode('vid'))]);
  const out = X.rewriteNextRequestPolicy(payload, 600000);
  assert.deepStrictEqual(X.readPolicy(out), { targetAudioMs: 600000, targetVideoMs: 600000, backoffMs: 0 });
  assert.ok(Buffer.from(out).includes(Buffer.from(cookie)));
  assert.strictEqual(X.rewriteNextRequestPolicy(concat([vf(1, 900000), vf(2, 900000)]), 600000), null, '原本已經大過就唔郁');
  const added = X.rewriteNextRequestPolicy(cookie, 600000);
  assert.deepStrictEqual(X.readPolicy(added), { targetAudioMs: 600000, targetVideoMs: 600000, backoffMs: undefined });
});

// ---------------------------------------------------------------------------
// UMP 串流
// ---------------------------------------------------------------------------
let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
const bytes = n => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));

const policyIn = concat([vf(1, 30000), vf(2, 30000), vf(4, 0)]);
const policyOut = X.rewriteNextRequestPolicy(policyIn, 3600000);
const fimPayload = concat([lf(2, formatId(251)), lf(5, new TextEncoder().encode('audio/webm'))]);
const media1 = bytes(5000), media2 = bytes(300000);
const input = concat([
  part(20, bytes(12)), part(21, media1), part(22, Uint8Array.of(1)),
  part(35, policyIn), part(42, fimPayload),
  part(20, bytes(12)), part(21, media2), part(22, Uint8Array.of(2)),
  part(58, new Uint8Array(0)), part(35, policyIn),
]);
const expected = concat([
  part(20, input.subarray(2, 14)), part(21, media1), part(22, Uint8Array.of(1)),
  part(35, policyOut), part(42, fimPayload),
]);

function runChunks(chunkSizes) {
  const rw = new X.UmpRewriter(
    (t, size) => (t === 35 || t === 42) && size <= 1 << 20,
    (t, p) => (t === 35 ? X.rewriteNextRequestPolicy(p, 3600000) : null));
  const out = [];
  let pos = 0, k = 0;
  while (pos < input.length) {
    const n = Math.max(1, chunkSizes(k++));
    out.push(...rw.push(input.slice(pos, pos + n)));
    pos += n;
  }
  out.push(...rw.flush());
  return concat(out);
}

test('UMP：一次過、逐個 byte、亂切 chunk 都出同一個結果', () => {
  const whole = runChunks(() => input.length);
  assert.ok(Buffer.from(whole).subarray(0, expected.length).equals(Buffer.from(expected)), '前半段要同預期一樣');
  assert.ok(Buffer.from(runChunks(() => 1)).equals(Buffer.from(whole)), '逐個 byte');
  for (let i = 0; i < 20; i++) {
    assert.ok(Buffer.from(runChunks(() => Math.floor(rand() * 9000))).equals(Buffer.from(whole)), `亂切 #${i}`);
  }
  // 片段資料一個 byte 都唔可以變
  assert.ok(Buffer.from(whole).includes(Buffer.from(media2)));
  assert.strictEqual(whole.length, input.length + 2 * (policyOut.length - policyIn.length));
});

test('UMP：成個 chunk 都係片段資料就原個交返出去（唔使 copy）', () => {
  const rw = new X.UmpRewriter(t => t === 35, () => null);
  rw.push(concat([X.encodeUmpVar(21), X.encodeUmpVar(100000)]));
  const chunk = bytes(4096);
  const out = rw.push(chunk);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0], chunk);
});

test('UMP：串流中途斷咗，吐返已收嘅 bytes（同原本一樣斷）', () => {
  const policyAt = part(20, bytes(12)).length + part(21, media1).length + part(22, Uint8Array.of(1)).length;
  const cut = input.subarray(0, policyAt + 5);   // 斷喺 policy part 中間
  const rw = new X.UmpRewriter(t => t === 35, (t, p) => X.rewriteNextRequestPolicy(p, 3600000));
  const out = concat([...rw.push(cut.slice(0, 1234)), ...rw.push(cut.slice(1234)), ...rw.flush()]);
  assert.ok(Buffer.from(out).equals(Buffer.from(cut)));
});

test('UMP：超過上限嘅「policy」當普通資料放行，唔會開巨型 buffer', () => {
  const big = part(35, bytes(2 << 20));
  const rw = new X.UmpRewriter((t, size) => t === 35 && size <= 1 << 20, () => { throw new Error('唔應該叫到'); });
  const out = concat([...rw.push(big), ...rw.flush()]);
  assert.ok(Buffer.from(out).equals(Buffer.from(big)));
});

console.log(`\n全部 ${passed} 個測試通過`);
