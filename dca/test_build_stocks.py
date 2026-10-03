"""build_stocks.py 嘅合併同防護測試（唔使上網）。跑法：python dca/test_build_stocks.py"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_stocks import (REFRESH_DAYS, from_entry, full_refresh_today, guard,  # noqa: E402
                          merge, parse, since_of, to_entry)

M0, LAST = "2020-01", "2020-12"


def res(days, divs=()):
    """合成 Yahoo 回應。days = [(YYYY-MM-DD, open, close)]，時間戳 = 紐約開市 13:30 UTC。"""
    ts = [int(dt.datetime.fromisoformat(d + "T13:30:00+00:00").timestamp()) for d, *_ in days]
    ev = {str(int(dt.datetime.fromisoformat(d + "T13:30:00+00:00").timestamp())): {"amount": a}
          for d, a in divs}
    return {"meta": {"exchangeTimezoneName": "America/New_York", "symbol": "X"},
            "timestamp": ts,
            "indicators": {"quote": [{"open": [o for _, o, _ in days],
                                      "close": [c for *_, c in days]}]},
            "events": {"dividends": ev}}


def raises(fn, *a):
    try:
        fn(*a)
    except RuntimeError:
        return True
    return False


# 1 月至 4 月月中：每月兩個交易日，開市價 = 月份 × 10，收市價 = 月份 × 10 + 1
full_days = [("2020-01-02", 10, 10.5), ("2020-01-30", 10.2, 11),
             ("2020-02-03", 20, 20.5), ("2020-02-27", 20.2, 21),
             ("2020-03-02", 30, 30.5), ("2020-03-30", 30.2, 31),
             ("2020-04-01", 40, 40.5), ("2020-04-15", 40.2, 40.8)]   # 4 月未完
full = parse(res(full_days, divs=[("2020-02-03", 0.5), ("2020-03-16", 0.6)]), M0, LAST)

# parse：首個交易日開市、月底收市、除息日係供款日要標記、ld
assert full["months"] == ["2020-01", "2020-02", "2020-03", "2020-04"]
assert full["o"] == [10, 20, 30, 40] and full["c"] == [11, 21, 31, 40.8]
assert full["dv"] == [("2020-02", 0.5, 1), ("2020-03", 0.6, 0)], full["dv"]
assert full["ld"] == "2020-04-15" and full["d0"] == 2
# 範圍外嘅月份要剪走
assert parse(res(full_days), "2020-02", "2020-03")["months"] == ["2020-02", "2020-03"]

# 存檔再讀返，要一模一樣
old = from_entry(to_entry(full, M0, "X"), M0)
assert old["months"] == full["months"] and old["dv"] == full["dv"]
assert since_of(old) == "2020-02"

# 增量：由 2 月開始，4 月行完、5 月月中
inc_days = full_days[2:6] + [("2020-04-01", 40, 40.5), ("2020-04-29", 40.3, 42),
                             ("2020-05-01", 50, 50.5), ("2020-05-08", 50.1, 51)]
inc = parse(res(inc_days, divs=[("2020-02-03", 0.5), ("2020-03-16", 0.6), ("2020-05-04", 0.7)]),
            M0, LAST)
m = merge(old, inc)
assert m["months"] == ["2020-01", "2020-02", "2020-03", "2020-04", "2020-05"]
assert m["c"][3] == 42, "舊檔 4 月係月中收市價，要用增量嘅完整月份蓋過"
assert m["c"][4] == 51 and m["ld"] == "2020-05-08"
assert ("2020-05", 0.7, 0) in m["dv"] and len(m["dv"]) == 3

# 拆股：重疊月份價格成半 → 要重攞完整歷史
split = [(d, o / 2, c / 2) for d, o, c in inc_days]
assert merge(old, parse(res(split, divs=[("2020-02-03", 0.25), ("2020-03-16", 0.3)]),
                        M0, LAST)) is None

# 重疊完整月份嘅股息唔見咗 → 重攞
assert merge(old, parse(res(inc_days, divs=[("2020-02-03", 0.5)]), M0, LAST)) is None

# 增量冇由指定月份開始（Yahoo 漏咗前面）→ 重攞
assert merge(old, parse(res(inc_days[2:]), M0, LAST)) is None

# 舊檔最後一個月（月中）同之後嘅價格變咗係正常，唔應該重攞
ok_days = list(inc_days)
ok_days[4] = ("2020-04-01", 40, 40.5)
assert merge(old, inc) is not None

# 防護：最新月份價格錯十倍 → 擋；正常 → 過；數據縮短 → 擋
bad = dict(m, c=m["c"][:-1] + [m["c"][-2] * 20])
assert raises(guard, bad, old)
assert not raises(guard, m, old)
assert raises(guard, full | {"months": full["months"][:2], "c": full["c"][:2], "o": full["o"][:2]}, old)

# 個股唔可以新過 ETF：max_date 之後嘅日線同股息都要剪走
cut = parse(res(inc_days, divs=[("2020-05-04", 0.7)]), M0, LAST, max_date="2020-05-01")
assert cut["months"][-1] == "2020-05" and cut["c"][-1] == 50.5 and cut["ld"] == "2020-05-01"
assert cut["dv"] == [], "max_date 之後嘅股息未發生，唔應該計"

# 開始月份後移（總長度唔變）→ 擋
shifted = dict(m, months=m["months"][1:] + ["2020-06"])
assert raises(guard, shifted, old), "開頭月份唔見咗要擋，就算總長度一樣"

# 首個交易日冇開市價、第二日先買：第一日除息，新股冇份（flag 1）
days = [("2020-07-01", None, 70.5), ("2020-07-02", 70, 70.8), ("2020-07-30", 70.2, 71)]
p7 = parse(res(days, divs=[("2020-07-01", 0.3), ("2020-07-15", 0.4)]), M0, LAST)
assert p7["o"] == [70], "用第一個有效開市價"
assert p7["dv"] == [("2020-07", 0.3, 1), ("2020-07", 0.4, 0)], p7["dv"]

# 輪流完整重攞：連續 28 日入面，每隻啱啱好一次（唔理跨唔跨月）
start = dt.date(2026, 1, 20).toordinal()           # 故意跨月
for t in ("AAPL", "TSLA", "BRK-B", "A"):
    hits = [d for d in range(start, start + REFRESH_DAYS) if full_refresh_today(t, d)]
    assert len(hits) == 1, (t, hits)
    assert full_refresh_today(t, hits[0] + REFRESH_DAYS), "之後每 28 日一次"

print("OK build_stocks merge/guards")
