# -*- coding: utf-8 -*-
"""量化 Binance vs Gate 股票永续 gap：基线/开盘放大/收敛半衰期/资金费差
用法: python3 analyze_gap.py <数据目录> <输出目录>
时区: 2026年夏令时 EDT, 美股开盘 13:30 UTC, 收盘 20:00 UTC
"""
import sys, json
import numpy as np
import pandas as pd

DATA = sys.argv[1] if len(sys.argv) > 1 else "/tmp/arbdata"
OUT = sys.argv[2] if len(sys.argv) > 2 else DATA
OPEN_H, OPEN_M, CLOSE_H = 13, 30, 20

def load(path):
    df = pd.read_csv(path)
    df["ts"] = pd.to_datetime(df["ts"], unit="s", utc=True)
    df = df.set_index("ts")[["close"]].astype(float)
    return df[~df.index.duplicated()]

def merged(sym, freq):
    if freq == "1m":
        bn = load(f"{DATA}/{sym}_bn_last.csv") if sym == "TSLA" else load(f"{DATA}/{sym}_bn_last_1m.csv")
        gt = load(f"{DATA}/{sym}_gate_last_1m.csv")
    else:
        if sym == "TSLA":
            bn = load(f"{DATA}/{sym}_bn_last.csv").resample("5min").last().dropna()
        else:
            bn = load(f"{DATA}/{sym}_bn_last_5m.csv")
        gt = load(f"{DATA}/{sym}_gate_last_5m.csv")
    m = bn.join(gt, lsuffix="_bn", rsuffix="_gt", how="inner").dropna()
    m["gap_bps"] = (m["close_gt"] / m["close_bn"] - 1) * 1e4
    idx = m.index
    mins = idx.hour * 60 + idx.minute
    wk = idx.weekday
    m["regime"] = np.where(wk >= 5, "weekend",
                  np.where((mins >= OPEN_H * 60 + OPEN_M) & (mins < CLOSE_H * 60),
                           "session", "closed_wd"))
    return m

def stats(s):
    return {"n": int(len(s)), "mean": round(s.mean(), 2), "median": round(s.median(), 2),
            "std": round(s.std(), 2), "p5": round(s.quantile(.05), 2),
            "p95": round(s.quantile(.95), 2), "abs_median": round(s.abs().median(), 2)}

results = {}
for sym in ("TSLA", "NVDA"):
    r = {}
    m5 = merged(sym, "5m")
    r["window_5m"] = [str(m5.index[0]), str(m5.index[-1])]
    r["baseline_overall"] = stats(m5["gap_bps"])
    r["baseline_by_regime"] = {k: stats(g["gap_bps"]) for k, g in m5.groupby("regime")}
    r["hourly_abs_median"] = {int(h): round(g["gap_bps"].abs().median(), 2)
                              for h, g in m5.groupby(m5.index.hour)}
    r["hourly_median"] = {int(h): round(g["gap_bps"].median(), 2)
                          for h, g in m5.groupby(m5.index.hour)}

    m1 = merged(sym, "1m")
    r["window_1m"] = [str(m1.index[0]), str(m1.index[-1])]
    days = []
    for d, g in m1.groupby(m1.index.date):
        if g["regime"].eq("session").sum() < 60:
            continue
        mins = g.index.hour * 60 + g.index.minute
        pre = g[(mins >= 720) & (mins < 805)]["gap_bps"]
        opn = g[(mins >= 810) & (mins < 870)]["gap_bps"]
        if len(pre) < 20 or len(opn) < 20:
            continue
        base = pre.median()
        dev = (opn - base).abs()
        peak_t = dev.idxmax()
        peak = dev.max()
        after = (g.loc[peak_t:]["gap_bps"] - base).abs()
        half = after[after <= peak / 2]
        ttl = (half.index[0] - peak_t).total_seconds() / 60 if len(half) else None
        days.append({"date": str(d), "pre_open_med": round(base, 2),
                     "open_peak_dev": round(peak, 2),
                     "peak_minute": str(peak_t.time())[:5],
                     "half_life_min": round(ttl, 1) if ttl is not None else None})
    r["open_days"] = days
    devs = [d["open_peak_dev"] for d in days]
    hls = [d["half_life_min"] for d in days if d["half_life_min"] is not None]
    r["open_summary"] = {"avg_peak_dev_bps": round(np.mean(devs), 2) if devs else None,
                         "max_peak_dev_bps": round(np.max(devs), 2) if devs else None,
                         "avg_half_life_min": round(np.mean(hls), 1) if hls else None,
                         "median_half_life_min": round(np.median(hls), 1) if hls else None}

    ses = m1[m1["regime"] == "session"]["gap_bps"]
    dev = ses - ses.rolling(240, min_periods=60).median()
    dev = dev.dropna()
    rho = dev.autocorr(1)
    r["ar1"] = {"rho_1m": round(rho, 4),
                "half_life_min": round(-np.log(2) / np.log(rho), 1) if 0 < rho < 1 else None}

    fb = pd.read_csv(f"{DATA}/{sym}_bn_funding.csv")
    fg = pd.read_csv(f"{DATA}/{sym}_gate_funding.csv")
    for f in (fb, fg):
        f["ts"] = pd.to_datetime(f["ts"], unit="s", utc=True)
    fb = fb[fb["ts"] >= m5.index[0]]
    fg = fg[fg["ts"] >= m5.index[0]]
    wknd_b = fb[fb["ts"].dt.weekday >= 5]["rate"].astype(float)
    wkdy_b = fb[fb["ts"].dt.weekday < 5]["rate"].astype(float)
    r["funding"] = {
        "bn_daily_pct": round(fb["rate"].astype(float).mean() * 3 * 100, 4),
        "gate_daily_pct": round(fg["rate"].astype(float).mean() * 3 * 100, 4),
        "bn_weekend_daily_pct": round(wknd_b.mean() * 3 * 100, 4) if len(wknd_b) else None,
        "bn_weekday_daily_pct": round(wkdy_b.mean() * 3 * 100, 4) if len(wkdy_b) else None,
        "n_bn": int(len(fb)), "n_gate": int(len(fg))}
    m1[["close_bn", "close_gt", "gap_bps", "regime"]].to_csv(f"{OUT}/{sym}_gap_1m.csv")
    m5[["close_bn", "close_gt", "gap_bps", "regime"]].to_csv(f"{OUT}/{sym}_gap_5m.csv")
    results[sym] = r

with open(f"{OUT}/gap_results.json", "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
print(json.dumps(results, ensure_ascii=False, indent=1)[:6000])
