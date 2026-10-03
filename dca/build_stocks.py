"""個股數據：標普 500 + 納指 100 + 熱門股（dca/stocks.txt），一隻一個檔
dca/stocks/<代號>.json，網頁揀咗先下載；搜尋用嘅索引係 dca/stocks.json。

同 ETF 數據（build_data.py）共用一套月份索引：`i` 係相對 data.json 嘅 m0，
月份唔可以超過 data.json 最後一個月 —— 所以一定要喺 build_data.py 之後跑。

每日只攞最近 3 個月（輕），同舊檔重疊嘅**完整**月份逐月對數；對唔上
（拆股、數據修正、中間缺咗月份）就重新攞嗰隻嘅完整歷史。

一隻失敗唔影響其他：保留舊檔、記低原因。超過 10% 失敗當系統性問題，exit 1。
"""
import datetime as dt
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_data import bar_date, fetch, month_add, monthly, sig, tz_of  # noqa: E402

HERE = Path(__file__).parent
LIST = HERE / "stocks.txt"
OUT_DIR = HERE / "stocks"
INDEX = HERE / "stocks.json"
ETF = HERE / "data.json"
MAX_FAIL = 0.10      # 超過呢個比例失敗 ⇒ 系統性問題
TOL = 0.005          # 重疊月份價格容許差 0.5%（超過當拆股／修正，重新攞完整歷史）
JUMP = 10            # 最新一個月相對上月收市超過 10 倍或者少過十分一 ⇒ 當單位錯
REFRESH_DAYS = 28    # 每隻每 28 日完整重攞一次：增量只睇最近 3 個月，捉唔到更早嘅修正

# 常用中文名：方便香港用戶搜尋（只係搜尋別名，唔影響計算）
ALIASES = {
    "AAPL": "蘋果", "MSFT": "微軟", "NVDA": "英偉達 輝達", "GOOGL": "谷歌 Google",
    "GOOG": "谷歌 Google", "AMZN": "亞馬遜", "META": "Facebook 臉書", "TSLA": "特斯拉",
    "NFLX": "網飛", "AMD": "超微", "INTC": "英特爾", "TSM": "台積電", "BABA": "阿里巴巴",
    "PDD": "拼多多", "JD": "京東", "BIDU": "百度", "NIO": "蔚來", "XPEV": "小鵬",
    "LI": "理想汽車", "NTES": "網易", "TCOM": "攜程", "BILI": "嗶哩嗶哩 B站",
    "FUTU": "富途", "TME": "騰訊音樂", "TIGR": "老虎證券", "BEKE": "貝殼", "ZTO": "中通",
    "VIPS": "唯品會", "MNSO": "名創優品", "YUMC": "百勝中國", "EDU": "新東方",
    "TAL": "好未來", "QFIN": "奇富", "KO": "可口可樂", "MCD": "麥當勞", "SBUX": "星巴克",
    "DIS": "迪士尼", "NKE": "耐克 Nike", "BRK-B": "巴郡 巴菲特 波克夏", "JPM": "摩根大通",
    "GS": "高盛", "MS": "摩根士丹利", "MA": "萬事達", "COST": "好市多 Costco",
    "WMT": "沃爾瑪", "PG": "寶潔", "PEP": "百事", "AVGO": "博通", "ORCL": "甲骨文",
    "QCOM": "高通", "MU": "美光", "ASML": "阿斯麥", "PFE": "輝瑞", "LLY": "禮來",
    "JNJ": "強生", "UNH": "聯合健康", "XOM": "埃克森美孚", "CVX": "雪佛龍", "BA": "波音",
    "CAT": "卡特彼勒", "CSCO": "思科", "MSTR": "微策略 Strategy", "TXN": "德州儀器",
    "GE": "通用電氣", "F": "福特", "GM": "通用汽車", "HD": "家得寶", "SMCI": "超微電腦",
    "ARM": "安謀", "SE": "Sea 冬海",
}
SUFFIXES = (" Common Stock", " Class A Common Stock", " Class A Ordinary Shares",
            " Ordinary Shares", " American Depositary Shares", " ADS")


def month_diff(a: str, b: str) -> int:
    return (int(b[:4]) - int(a[:4])) * 12 + int(b[5:7]) - int(a[5:7])


def clean_name(n: str) -> str:
    n = (n or "").strip()
    for s in SUFFIXES:
        if n.endswith(s):
            n = n[: -len(s)]
    return n.strip().rstrip(",")


def trim(res: dict, max_date: str) -> dict:
    """剪走 max_date 之後嘅日線。個股數據唔可以新過 ETF：全站要同一個估值日。"""
    tz = tz_of(res)
    keep = [i for i, ts in enumerate(res["timestamp"]) if bar_date(ts, tz) <= max_date]
    q = res["indicators"]["quote"][0]
    return dict(res, timestamp=[res["timestamp"][i] for i in keep],
                indicators={"quote": [{k: [q[k][i] for i in keep] for k in ("open", "close")}]})


def parse(res: dict, m0: str, last_m: str, max_date: str | None = None) -> dict:
    """Yahoo 回應 → 月度數據，只留 [m0, last_m] 範圍、max_date（含）之前。"""
    if max_date:
        res = trim(res, max_date)
    tz = tz_of(res)
    months, o, c, fd, _ = monthly(res)
    last_close_day = {}
    for ts, cl in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]):
        if cl is not None and cl > 0:
            d = bar_date(ts, tz)
            last_close_day[d[:7]] = d
    keep = [k for k, m in enumerate(months) if m0 <= m <= last_m]
    if not keep:
        raise RuntimeError("範圍內冇數據")
    ms = [months[k] for k in keep]
    for a, b in zip(ms, ms[1:]):
        if month_add(a, 1) != b:
            raise RuntimeError(f"月份有缺口：{a} → {b}")
    mset = set(ms)
    dv = []
    for k, v in sorted(((res.get("events") or {}).get("dividends") or {}).items(),
                       key=lambda kv: int(kv[0])):
        d = bar_date(int(k), tz)
        if d[:7] in mset and v.get("amount", 0) > 0 and (not max_date or d <= max_date):
            dv.append((d[:7], sig(v["amount"]), 1 if d <= fd[d[:7]] else 0))
    return {"months": ms, "o": [sig(o[k]) for k in keep], "c": [sig(c[k]) for k in keep],
            "d0": int(fd[ms[0]][8:]), "dv": dv, "ld": last_close_day[ms[-1]]}


def from_entry(e: dict, m0: str) -> dict:
    first = month_add(m0, e["i"])
    return {"months": [month_add(first, k) for k in range(len(e["c"]))],
            "o": e["o"], "c": e["c"], "d0": e["d0"], "ld": e["ld"],
            "dv": [(month_add(first, k), a, f) for k, a, f in e["dv"]]}


def to_entry(p: dict, m0: str, name: str) -> dict:
    first = p["months"][0]
    return {"n": name, "g": "個股", "i": month_diff(m0, first), "d0": p["d0"], "ld": p["ld"],
            "o": p["o"], "c": p["c"],
            "dv": [[month_diff(first, m), a, f] for m, a, f in p["dv"]]}


def merge(old: dict, inc: dict):
    """舊數據（from_entry 格式）＋ 增量 → 新數據；對唔上就回 None（要重攞完整歷史）。

    增量由 `since_of(old)` 開始。舊檔最後一個月可能係月中數據，所以佢同之後
    嘅月份一律用增量蓋過；**佢之前**嘅重疊月份係完整嘅，價格同股息都要對得上。
    """
    om, last = old["months"], old["months"][-1]
    if not inc["months"] or inc["months"][0] != since_of(old):
        return None                                  # Yahoo 冇由指定月份開始畀數
    if inc["months"][-1] < last:
        return None                                  # 新數據反而短過舊檔
    for k, m in enumerate(inc["months"]):
        if m >= last:
            break
        j = om.index(m)
        if (abs(inc["o"][k] / old["o"][j] - 1) > TOL or
                abs(inc["c"][k] / old["c"][j] - 1) > TOL):
            return None                              # 拆股或者修正
        a = sorted(x for mm, x, _ in old["dv"] if mm == m)
        b = sorted(x for mm, x, _ in inc["dv"] if mm == m)
        if len(a) != len(b) or any(abs(y / x - 1) > 0.01 for x, y in zip(a, b)):
            return None                              # 股息對唔上
    cut = om.index(last)
    k0 = inc["months"].index(last)
    return {"months": om[:cut] + inc["months"][k0:],
            "o": old["o"][:cut] + inc["o"][k0:], "c": old["c"][:cut] + inc["c"][k0:],
            "d0": old["d0"], "ld": inc["ld"],
            "dv": [d for d in old["dv"] if d[0] < last] + [d for d in inc["dv"] if d[0] >= last]}


def since_of(old: dict) -> str:
    om = old["months"]
    return om[max(0, len(om) - 3)]                   # 最尾 3 個月：2 個完整重疊 + 舊檔最後一個


def guard(p: dict, old: dict | None) -> None:
    c, o = p["c"], p["o"]
    if len(c) >= 2:
        for what, px in (("收市", c[-1]), ("開市", o[-1])):
            r = px / c[-2]
            if not 1 / JUMP < r < JUMP:
                raise RuntimeError(f"最新月份{what}價係上月收市嘅 {r:.3g} 倍，當數據走樣")
    if old and len(p["months"]) < len(old["months"]):
        raise RuntimeError("新數據短過舊檔")
    if old and p["months"][0] != old["months"][0]:
        # 長度一樣都唔得：Yahoo 漏咗第一個月、同時多咗最新一個月，會靜靜刪走最早歷史
        raise RuntimeError(f"開始月份變咗（{old['months'][0]} → {p['months'][0]}）")


def full_refresh_today(t: str, day: int) -> bool:
    """輪流完整重攞：每日大約 1/28 隻，每隻準時每 28 日一次。

    `day` 要係**連續**日數（date.toordinal()），唔可以係每月日號 —— 日號每月
    重設，會變成隔 31 日、或者一個月兩次。用字元和，唔用 hash()（每次跑唔同）。
    """
    return sum(map(ord, t)) % REFRESH_DAYS == day % REFRESH_DAYS


def write_json(path: Path, obj) -> bool:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    if path.exists() and path.read_text(encoding="utf-8") == s:
        return False
    tmp = path.with_suffix(".tmp")
    tmp.write_text(s, encoding="utf-8")
    tmp.replace(path)
    return True


def load_list() -> list:
    out = []
    for line in LIST.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            t, _, n = line.partition("\t")
            out.append((t.strip(), n.strip()))
    return out


def main() -> int:
    etf = json.loads(ETF.read_text(encoding="utf-8"))
    m0 = etf["m0"]
    last_m = month_add(m0, len(etf["fxb"]) - 1)
    OUT_DIR.mkdir(exist_ok=True)
    rows, fails, staged, mode = [], [], {}, {"增量": 0, "完整": 0}
    tickers = load_list()
    day = dt.date.today().toordinal()
    for t, listed in tickers:
        path = OUT_DIR / f"{t}.json"
        old_e = old = None
        try:
            old_e = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
            old = from_entry(old_e, m0) if old_e else None   # 欄位唔齊會喺度拋
            p, res = None, None
            if old and not full_refresh_today(t, day):
                res = fetch(t, since=since_of(old), min_days=1)
                p = merge(old, parse(res, m0, last_m, etf["asof"]))
                how = "增量"
            if p is None:
                res = fetch(t, min_days=5)
                p = parse(res, m0, last_m, etf["asof"])
                how = "完整"
            guard(p, old)
            meta = res["meta"]
            name = (old_e or {}).get("n") or clean_name(listed) or \
                clean_name(meta.get("longName") or meta.get("shortName") or t)
            e = to_entry(p, m0, name)
            staged[path] = e                          # 先放喺記憶體，最後先一次過寫
            mode[how] += 1
            rows.append([t, e["n"], ALIASES.get(t, ""), e["i"], e["ld"]])
        except Exception as ex:                       # noqa: BLE001
            fails.append(f"{t}: {ex}")
            if old is not None and old_e.get("n"):   # 舊檔通過驗證先保留，網頁照用
                rows.append([t, old_e["n"], ALIASES.get(t, ""), old_e["i"], old_e["ld"]])
        time.sleep(0.3)

    print(f"個股 {len(rows)}/{len(tickers)}：增量 {mode['增量']}、完整重攞 {mode['完整']}、"
          f"失敗 {len(fails)}")
    for f in fails[:20]:
        print("  失敗", f)
    if len(fails) > MAX_FAIL * len(tickers):
        # 系統性問題（例如 Yahoo 限流）：乜都唔寫，網站成套用返舊數據，唔會半新半舊
        print(f"::error::個股失敗 {len(fails)} 隻，超過 {MAX_FAIL:.0%}，今日唔更新任何個股")
        return 1
    changed = sum(write_json(path, e) for path, e in staged.items())
    write_json(INDEX, {"asof": etf["asof"], "m0": m0, "s": rows})
    print(f"OK 寫咗 {changed} 隻有變嘅個股檔")
    if fails:
        print(f"::warning::個股有 {len(fails)} 隻今日更新唔到，網頁用返舊數據")
    return 0


if __name__ == "__main__":
    sys.exit(main())
