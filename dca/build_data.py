"""月供回測器嘅數據：每隻 ETF 每月「第一個交易日開市價」「月底收市價」同股息。

由 GitHub Actions 每日跑（.github/workflows/dca.yml），亦可以本機跑：
    python dca/build_data.py

數據源：Yahoo chart API（同 CBBI/mstr.json 同一個，已經證明喺 Actions 用得）。
價格同股息都係**已按拆股調整**、**未按股息調整** —— 股息由回測器自己
處理（扣稅、再投資），所以唔可以用 adjclose，否則股息會計兩次。

失敗就整個唔寫（exit 1），舊 data.json 原封不動。寧願數據舊一日，都唔可以
寫一份缺咗幾隻 ETF 嘅檔上線。
"""
import datetime as dt
import json
import sys
import time
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

OUT = Path(__file__).with_name("data.json")

# (代號, 名, 分組)。全部係美國上市、有 10 年以上歷史嘅大型 ETF。
ETFS = [
    ("SPY", "SPDR 標普 500", "美股大盤"),
    ("VOO", "Vanguard 標普 500", "美股大盤"),
    ("IVV", "iShares 標普 500", "美股大盤"),
    ("VTI", "Vanguard 美股全市場", "美股大盤"),
    ("DIA", "SPDR 道瓊斯 30", "美股大盤"),
    ("RSP", "Invesco 標普 500 等權重", "美股大盤"),
    ("QQQ", "Invesco 納指 100", "增長科技"),
    ("VGT", "Vanguard 資訊科技", "增長科技"),
    ("XLK", "SPDR 科技精選", "增長科技"),
    ("VUG", "Vanguard 美股增長", "增長科技"),
    ("SMH", "VanEck 半導體", "增長科技"),
    ("SOXX", "iShares 半導體", "增長科技"),
    ("SCHD", "Schwab 美股高息", "收息價值"),
    ("VYM", "Vanguard 高股息", "收息價值"),
    ("VIG", "Vanguard 股息增長", "收息價值"),
    ("VTV", "Vanguard 美股價值", "收息價值"),
    ("IWM", "iShares 羅素 2000 小型股", "中小型"),
    ("VB", "Vanguard 小型股", "中小型"),
    ("MDY", "SPDR 標普中型股 400", "中小型"),
    ("VT", "Vanguard 全球股票", "國際"),
    ("VXUS", "Vanguard 美國以外全球", "國際"),
    ("VEA", "Vanguard 已發展市場", "國際"),
    ("VWO", "Vanguard 新興市場", "國際"),
    ("EWH", "iShares 香港", "國際"),
    ("FXI", "iShares 中國大型股", "國際"),
    ("XLF", "SPDR 金融", "行業"),
    ("XLV", "SPDR 醫療", "行業"),
    ("XLE", "SPDR 能源", "行業"),
    ("BND", "Vanguard 美國債券總體", "債券"),
    ("TLT", "iShares 20 年以上美債", "債券"),
    ("SHY", "iShares 1-3 年美債", "債券"),
    ("GLD", "SPDR 黃金", "黃金白銀"),
    ("SLV", "iShares 白銀", "黃金白銀"),
    ("TQQQ", "ProShares 3 倍納指 100", "槓桿"),
    ("UPRO", "ProShares 3 倍標普 500", "槓桿"),
    ("QLD", "ProShares 2 倍納指 100", "槓桿"),
    ("SSO", "ProShares 2 倍標普 500", "槓桿"),
]
FX_PEG = 7.8        # 聯繫匯率；只用喺 Yahoo 開始有匯率數據（2001-07）之前
MAX_LAG_DAYS = 0    # 全部 ETF 都要更新到同一日；有一隻落後 ⇒ Yahoo 數據唔齊，今日唔寫
MAX_FX_LAG_DAYS = 4 # 匯率最後報價可以早過 ETF 幾多日（週末＋假期）
LEVERAGED = {"TQQQ", "UPRO", "QLD", "SSO"}
MAX_MONTH_MOVE = 0.5       # 新增月份單月升跌上限（一倍 ETF）；超過當數據走樣
MAX_MONTH_MOVE_LEV = 0.85  # 槓桿 ETF
MAX_STALE_DAYS = 7  # 最新數據舊過今日呢個日數 ⇒ 疑似舊快照，唔寫


def fetch(ticker: str, since: str | None = None, min_days: int = 200) -> dict:
    """攞日線。`since`（'YYYY-MM'）＝ 由嗰個月 1 號開始；冇就攞全部歷史。"""
    p1 = 0
    if since:
        p1 = int(dt.datetime(int(since[:4]), int(since[5:7]), 1,
                             tzinfo=dt.timezone.utc).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?period1={p1}&period2=9999999999&interval=1d&events=div%2Csplit")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                res = json.load(r)["chart"]["result"][0]
            n = len(res.get("timestamp") or [])
            if n < min_days:
                raise ValueError(f"得 {n} 日數據")
            return res
        except Exception as e:                       # noqa: BLE001
            if attempt == 3:
                raise RuntimeError(f"{ticker} 攞唔到：{e}") from e
            time.sleep(15 * (attempt + 1))


def bar_date(ts: int, tz: str) -> str:
    """日線 timestamp → 交易所當地日期。

    ⚠️ 唔可以一刀切「減幾粒鐘」：美股日線係紐約開市時間（UTC 13:30／14:30），
    但 HKD=X 係倫敦午夜（UTC 23:00 或 00:00）。之前一律減 5 粒鐘，令**每一個**
    匯率報價都變咗前一日 —— 每月 1 號嘅匯率被放咗入上個月。
    """
    return dt.datetime.fromtimestamp(ts, ZoneInfo(tz)).strftime("%Y-%m-%d")


def tz_of(res: dict, default: str | None = "America/New_York") -> str:
    tz = res["meta"].get("exchangeTimezoneName") or default
    if not tz:
        raise RuntimeError(f"{res['meta'].get('symbol')} 冇時區資料，唔可以估")
    return tz


def sig(x: float) -> float:
    return float(f"{x:.6g}")


def monthly(res: dict):
    """回 (月份, 開市價, 收市價, {月份: 首個交易日}, 最後一個有效收市日)。

    開市價同收市價**分開**追：一支 bar 淨係缺 close 唔應該連佢有效嘅 open
    都丟埋（反之亦然）。
    """
    q, tz = res["indicators"]["quote"][0], tz_of(res)
    first, last, last_d = {}, {}, {}
    for ts, o, c in zip(res["timestamp"], q["open"], q["close"]):
        d = bar_date(ts, tz)
        m = d[:7]
        if o is not None and o > 0 and m not in first:
            first[m] = (d, o)
        if c is not None and c > 0:
            last[m] = c
            last_d[m] = d
    months = sorted(set(first) & set(last))
    # 最新嗰個月只有開市價或者只有收市價 ⇒ 數據唔完整，唔可以靜靜咁截走
    if max(set(first) | set(last)) != months[-1]:
        raise RuntimeError(f"{res['meta'].get('symbol')} 最新月份數據唔完整")
    return (months, [first[m][1] for m in months], [last[m] for m in months],
            {m: first[m][0] for m in months}, last_d[months[-1]])


def check_against_old(etfs: dict, old: dict) -> None:
    """同上一份 data.json 逐月比，捉 Yahoo 數據走樣。

    參考答案測試（engine.test.js）只覆蓋 13 隻 ETF 嘅固定時段，其餘 24 隻同埋
    新月份冇人驗。呢度補：
      - 歷史價格只可以**全段按同一比例**變（今期拆股／合股會咁），個別月份走樣即停
      - 每一筆舊股息都要搵到配對：同一個月、金額 ≈ 舊金額 × 同一個比例
        （拆股時股息要同價格一齊調整；Yahoo 補返漏咗嘅可以多出嚟，唔見咗唔得）
      - 數據唔可以縮短、成立月唔可以變
    比較範圍：
      - 收市價：舊檔最後一個月唔比（月中更新嗰陣佢只係「暫時」收市價）
      - 開市價：**全部月份都比**。當月首個交易日嘅開市價一攞到就唔會再變，
        唔可以同收市價共用排除範圍 —— 否則最新月份開市價錯十倍都會上線，
        之後仲會變成下次比較嘅基準，永遠捉唔返。

    ⚠️ 已知會誤擋（安全方向）：Yahoo 事後**補記歷史中段**嘅拆股，嗰陣只有拆股
    日前嘅月份會變比例。症狀係每日 workflow 報「歷史價格走樣」。處理：人手核實
    確係補記拆股之後，刪咗 dca/data.json 再跑一次（等於重新起底，冇舊檔可比）。
    """
    for t, o in old.get("etfs", {}).items():
        new = etfs.get(t)
        if new is None:
            raise RuntimeError(f"{t} 喺舊檔有、新數據冇")
        if new["i"] != o["i"]:
            raise RuntimeError(f"{t} 成立月變咗（{o['i']} → {new['i']}）")
        if len(new["c"]) < len(o["c"]):
            raise RuntimeError(f"{t} 數據比舊檔短（{len(new['c'])} < {len(o['c'])}）")
        n_c, n_o = len(o["c"]) - 1, len(o["o"])
        pts = ([("收市", i, new["c"][i] / o["c"][i]) for i in range(n_c)] +
               [("開市", i, new["o"][i] / o["o"][i]) for i in range(n_o)])
        med = sorted(r for *_, r in pts)[len(pts) // 2]
        bad = [(k, i) for k, i, r in pts if abs(r / med - 1) > 0.02]
        if bad:
            raise RuntimeError(f"{t} 有 {len(bad)} 個歷史價格走樣（例如第 {bad[0][1]} 個月"
                               f"{bad[0][0]}價），唔係拆股嗰種全段變化")
        # 股息：逐筆配對（同一個月、金額 ≈ 舊 × med）。新數據可以多、唔可以少
        pool = {}
        for k, a, _ in new["dv"]:
            pool.setdefault(k, []).append(a)
        for k, a, _ in o["dv"]:
            want = a * med
            hit = next((b for b in pool.get(k, []) if abs(b / want - 1) <= 0.02), None)
            if hit is None:
                raise RuntimeError(f"{t} 第 {k} 個月嘅股息 {a} 搵唔到配對"
                                   f"（拆股比例 {med:.4g}，新數據：{pool.get(k, [])}）")
            pool[k].remove(hit)


def check_new_months(etfs: dict) -> None:
    """最新一個月嘅開市價同收市價，相對上一個月收市價唔可以離譜
    （例如單位錯、價格錯十倍）。開市價都要驗 —— 佢決定當月供款買到幾多股。"""
    for t, e in etfs.items():
        c, o = e["c"], e["o"]
        if len(c) < 2:
            continue
        lim = MAX_MONTH_MOVE_LEV if t in LEVERAGED else MAX_MONTH_MOVE
        for what, px in (("收市", c[-1]), ("開市", o[-1])):
            move = px / c[-2] - 1
            if abs(move) > lim:
                raise RuntimeError(f"{t} 最新一個月{what}價相對上月收市 {move:+.0%}，"
                                   f"超過 {lim:.0%} 上限，當數據走樣")


def month_add(m: str, k: int) -> str:
    y, mo = int(m[:4]), int(m[5:7]) - 1 + k
    return f"{y + mo // 12:04d}-{mo % 12 + 1:02d}"


def main() -> int:
    raw = {}
    for t, *_ in ETFS:
        raw[t] = fetch(t)
        time.sleep(0.6)
    fx_raw = fetch("HKD=X")

    per = {t: monthly(raw[t]) for t in raw}
    m0 = min(v[0][0] for v in per.values())
    m_last = max(v[0][-1] for v in per.values())
    gm = [m0]
    while gm[-1] != m_last:
        gm.append(month_add(gm[-1], 1))
    idx = {m: i for i, m in enumerate(gm)}

    # 匯率：每月第一個／最後一個報價。
    #  - 2001-07（Yahoo 有數據）之前：聯繫匯率 7.8
    #  - 之後中途缺月（實測 2003-05 至 11）：沿用上個月最後一個報價
    #  - **最新一個月**冇報價：唔寫 —— 嗰個就係用嚟換算而家市值嘅匯率
    fx_first, fx_last, fx_day = {}, {}, None
    fx_tz = tz_of(fx_raw, default=None)     # 外匯唔准用紐約時區估
    for ts, v in zip(fx_raw["timestamp"], fx_raw["indicators"]["quote"][0]["close"]):
        if v is None or not 7.0 < v < 8.5:          # 剔走 Yahoo 偶爾嘅爛報價
            continue
        d = bar_date(ts, fx_tz)
        m = d[:7]
        fx_first.setdefault(m, v)
        fx_last[m] = v
        fx_day = d
    fx_from = min(fx_first)
    if gm[-1] not in fx_last:
        raise RuntimeError(f"{gm[-1]} 冇港元匯率報價 —— 而家市值換唔到港元")
    fxb, fxc, carry = [], [], FX_PEG
    for m in gm:
        if m >= fx_from and m in fx_first:
            fxb.append(round(fx_first[m], 4))
            fxc.append(round(fx_last[m], 4))
            carry = fx_last[m]
        else:
            fxb.append(round(carry, 4))
            fxc.append(round(carry, 4))

    # 每月首個交易日（XIRR 用真日期，唔係一律當 1 號）。SPY 由 1993-01 起日日有交易
    spy_first = per["SPY"][3]
    fd = [int(spy_first[m][8:]) if m in spy_first else 1 for m in gm]

    # 每隻 ETF 嘅最後有效收市日：唔齊就唔寫（例如 Yahoo 某隻停咗喺幾日前）
    last_days = {t: per[t][4] for t in per}
    newest = max(last_days.values())
    for t, d in last_days.items():
        lag = (dt.date.fromisoformat(newest) - dt.date.fromisoformat(d)).days
        if lag > MAX_LAG_DAYS:
            raise RuntimeError(f"{t} 數據停喺 {d}，落後最新 {newest} {lag} 日")
    stale = (dt.date.today() - dt.date.fromisoformat(newest)).days
    if stale > MAX_STALE_DAYS:
        raise RuntimeError(f"最新數據係 {newest}，已經舊咗 {stale} 日，疑似 Yahoo 回咗舊快照")
    # 「本月有報價」唔等於「用緊最新報價」：匯率要貼得住 ETF 嘅最新日期
    fx_lag = (dt.date.fromisoformat(newest) - dt.date.fromisoformat(fx_day)).days
    if fx_lag > MAX_FX_LAG_DAYS:
        raise RuntimeError(f"港元匯率停喺 {fx_day}，比 ETF 最新 {newest} 舊 {fx_lag} 日")

    etfs = {}
    for t, name, grp in ETFS:
        months, o, c, first_day, last_day = per[t]
        start = idx[months[0]]
        # 中途有冇交易嘅月份（停牌）就會錯位；寧願即刻停
        if len(months) != idx[months[-1]] - start + 1:
            raise RuntimeError(f"{t} 月份有缺口：{len(months)} 個月對唔上")
        dv = []
        events = (raw[t].get("events") or {}).get("dividends", {})
        for k, v in sorted(events.items(), key=lambda kv: int(kv[0])):
            d = bar_date(int(k), tz_of(raw[t]))
            m = d[:7]
            if m not in first_day or v.get("amount", 0) <= 0:
                continue
            # flag 1 ＝ 除息日喺實際買入日（當月首個有開市價嘅交易日）或之前
            # ⇒ 當月新買嘅股冇得收。用 <= 唔用 ==：首個交易日冇開市價、要第二日
            # 先買嗰陣，第一日除息都唔關新股事。
            dv.append([idx[m] - start, sig(v["amount"]), 1 if d <= first_day[m] else 0])
        etfs[t] = {"n": name, "g": grp, "i": start,
                   "d0": int(first_day[months[0]][8:]),   # 成立月嘅首個交易日
                   "ld": last_day,                         # 最後有效收市日（XIRR 終值日）
                   "o": [sig(x) for x in o], "c": [sig(x) for x in c], "dv": dv}

    data = {"asof": newest, "m0": m0, "fx_from": fx_from, "fd": fd,
            "fxb": fxb, "fxc": fxc, "etfs": etfs}

    # 寫之前驗
    if "SPY" not in etfs or len(etfs) != len(ETFS):
        raise RuntimeError("ETF 唔齊")
    check_new_months(etfs)
    if OUT.exists():
        check_against_old(etfs, json.loads(OUT.read_text(encoding="utf-8")))

    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    tmp.replace(OUT)
    print(f"OK {len(etfs)} ETFs, {gm[0]} -> {gm[-1]}, asof {newest}, "
          f"fx from {fx_from}, {OUT.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
