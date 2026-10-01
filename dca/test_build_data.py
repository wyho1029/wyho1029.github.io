"""build_data.py 嘅數據防護測試（唔使上網）。跑法：python dca/test_build_data.py

check_against_old / check_new_months 係 workflow 入面擋住 Yahoo 走樣數據嘅
最後一道閘。呢度逐個情況確認佢擋啱、亦唔會誤擋正常變化（例如拆股）。
"""
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_data import check_against_old, check_new_months  # noqa: E402


def etf(n=24, start=0):
    return {"i": start,
            "o": [100.0 + i for i in range(n)],
            "c": [101.0 + i for i in range(n)],
            "dv": [[k, 0.5, 0] for k in range(2, n, 3)]}


def raises(fn, *a):
    try:
        fn(*a)
    except RuntimeError:
        return True
    return False


old = {"etfs": {"SPY": etf(), "TQQQ": etf()}}

# 一模一樣 → 過
assert not raises(check_against_old, copy.deepcopy(old["etfs"]), old)

# 拆股：成段價格同股息 ÷3 → 過（唔可以當走樣）
new = copy.deepcopy(old["etfs"])
for k in ("o", "c"):
    new["SPY"][k] = [x / 3 for x in new["SPY"][k]]
new["SPY"]["dv"] = [[a, b / 3, f] for a, b, f in new["SPY"]["dv"]]
assert not raises(check_against_old, new, old), "拆股唔應該擋"

# 加咗一個新月份 → 過
new = copy.deepcopy(old["etfs"])
new["SPY"]["o"].append(130.0); new["SPY"]["c"].append(131.0)
assert not raises(check_against_old, new, old)

# 舊檔最後一個月係月中數據，之後收市價變咗 → 唔應該比（過）
new = copy.deepcopy(old["etfs"])
new["SPY"]["c"][-1] *= 1.2
assert not raises(check_against_old, new, old), "舊檔最後一個月未完，唔拎嚟比"

# 拆股：價格 ÷3 但股息冇跟住調整 → 擋（股息率會無啦啦大 3 倍）
new = copy.deepcopy(old["etfs"])
for k in ("o", "c"):
    new["SPY"][k] = [x / 3 for x in new["SPY"][k]]
assert raises(check_against_old, new, old), "拆股但股息冇調整要擋"

# 少一筆、喺第個月多一筆（總筆數一樣）→ 擋
new = copy.deepcopy(old["etfs"])
new["SPY"]["dv"].pop(0)
new["SPY"]["dv"].append([0, 0.5, 0])
assert raises(check_against_old, new, old), "股息調轉位要擋"

# 同一個月多咗一筆（Yahoo 補返）→ 過
new = copy.deepcopy(old["etfs"])
new["SPY"]["dv"].append([new["SPY"]["dv"][0][0], 0.2, 0])
assert not raises(check_against_old, new, old), "同月補返一筆唔應該擋"

# 舊檔最後一個月嘅開市價走樣 → 擋（首個交易日開市價唔會月中再變）
new = copy.deepcopy(old["etfs"])
new["SPY"]["o"][-1] *= 10
assert raises(check_against_old, new, old), "最新月份開市價走樣要擋"

# 中間一個月價格走樣 10% → 擋
new = copy.deepcopy(old["etfs"])
new["SPY"]["c"][10] *= 1.1
assert raises(check_against_old, new, old), "個別月份走樣要擋"

# 開市價走樣都要擋（唔可以淨係睇收市價）
new = copy.deepcopy(old["etfs"])
new["SPY"]["o"][5] *= 0.9
assert raises(check_against_old, new, old), "開市價走樣要擋"

# 少咗一筆股息 → 擋；多咗一筆（Yahoo 補返）→ 過
new = copy.deepcopy(old["etfs"])
new["SPY"]["dv"].pop(0)
assert raises(check_against_old, new, old), "股息唔見咗要擋"
new = copy.deepcopy(old["etfs"])
new["SPY"]["dv"].append([0, 0.1, 0])
assert not raises(check_against_old, new, old), "補返漏咗嘅股息唔應該擋"

# 數據縮短、成立月變咗、成隻 ETF 唔見咗 → 擋
new = copy.deepcopy(old["etfs"])
new["SPY"]["c"].pop(); new["SPY"]["o"].pop()
assert raises(check_against_old, new, old), "數據縮短要擋"
new = copy.deepcopy(old["etfs"]); new["SPY"]["i"] = 1
assert raises(check_against_old, new, old), "成立月變咗要擋"
new = copy.deepcopy(old["etfs"]); del new["TQQQ"]
assert raises(check_against_old, new, old), "ETF 唔見咗要擋"

# 新月份升跌上限：一倍 ETF 50%、槓桿 85%
def with_last(t, move):
    e = {t: etf()}
    e[t]["c"][-1] = e[t]["c"][-2] * (1 + move)
    return e

assert not raises(check_new_months, with_last("SPY", -0.3)), "跌 30% 係真實可能"
assert raises(check_new_months, with_last("SPY", 9.0)), "價格錯十倍要擋"
assert raises(check_new_months, with_last("SPY", 0.6)), "一倍 ETF 單月 +60% 要擋"
assert not raises(check_new_months, with_last("TQQQ", -0.6)), "槓桿 ETF -60% 係真實可能"
e = {"SPY": etf()}
e["SPY"]["o"][-1] = e["SPY"]["c"][-2] * 10
assert raises(check_new_months, e), "新月份開市價錯十倍要擋（佢決定買到幾多股）"
assert raises(check_new_months, with_last("TQQQ", -0.9)), "槓桿 ETF -90% 要擋"

print("OK build_data guards")
