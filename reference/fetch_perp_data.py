# -*- coding: utf-8 -*-
"""拉取 Binance 与 Gate 股票永续 1m K线(最新价+标记价)与资金费率, 保存CSV.
用法: python3 fetch_perp_data.py <输出目录> [天数=30] [任务]
注意: Gate K线仅保留最近10,000根 → 1m最多约6.9天; 更长周期请用5m(约34天)。
Binance 1m 无此限制。合约代码: Binance TSLAUSDT/NVDAUSDT, Gate TSLAX_USDT/NVDAX_USDT。
"""
import json, sys, time, urllib.request, csv, os

OUT = sys.argv[1] if len(sys.argv) > 1 else "./data"
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
os.makedirs(OUT, exist_ok=True)
NOW = int(time.time())
START = NOW - DAYS * 86400
PAIRS = {"TSLA": ("TSLAUSDT", "TSLAX_USDT"), "NVDA": ("NVDAUSDT", "NVDAX_USDT")}

def get(url, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(1.5 * (i + 1))

def save(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"saved {path} rows={len(rows)}", flush=True)

def binance_klines(symbol, endpoint):
    rows, start = [], START * 1000
    while start < NOW * 1000:
        url = (f"https://fapi.binance.com/fapi/v1/{endpoint}?symbol={symbol}"
               f"&interval=1m&startTime={start}&limit=1500")
        data = get(url)
        if not data:
            break
        for k in data:
            rows.append([k[0] // 1000, k[1], k[2], k[3], k[4], k[5]])
        start = data[-1][0] + 60000
        time.sleep(0.12)
    return rows

def gate_candles(contract):
    rows, frm = [], START
    while frm < NOW:
        to = min(frm + 1999 * 60, NOW)
        url = (f"https://api.gateio.ws/api/v4/futures/usdt/candlesticks"
               f"?contract={contract}&interval=1m&from={frm}&to={to}")
        data = get(url)
        if not data:
            frm = to + 60
            continue
        for k in data:
            rows.append([int(k["t"]), k["o"], k["h"], k["l"], k["c"],
                         k.get("v", "")])
        frm = int(data[-1]["t"]) + 60
        time.sleep(0.12)
    return rows

def binance_funding(symbol):
    rows, start = [], START * 1000
    while True:
        url = (f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={symbol}"
               f"&startTime={start}&limit=1000")
        data = get(url)
        if not data:
            break
        for d in data:
            rows.append([d["fundingTime"] // 1000, d["fundingRate"]])
        if len(data) < 1000:
            break
        start = data[-1]["fundingTime"] + 1
        time.sleep(0.3)
    return rows

def gate_funding(contract):
    data = get(f"https://api.gateio.ws/api/v4/futures/usdt/funding_rate"
               f"?contract={contract}&limit=1000")
    return [[int(d["t"]), d["r"]] for d in data if int(d["t"]) >= START]

H = ["ts", "open", "high", "low", "close", "volume"]
JOB = sys.argv[3] if len(sys.argv) > 3 else "all"
for name, (bn, gt) in PAIRS.items():
    if JOB != "all" and not JOB.startswith(name):
        continue
    venue = JOB.split(":")[1] if ":" in JOB else "both"
    if venue in ("bn", "both"):
        save(f"{OUT}/{name}_bn_last.csv", H, binance_klines(bn, "klines"))
        save(f"{OUT}/{name}_bn_mark.csv", H, binance_klines(bn, "markPriceKlines"))
        save(f"{OUT}/{name}_bn_funding.csv", ["ts", "rate"], binance_funding(bn))
    if venue in ("gate", "both"):
        save(f"{OUT}/{name}_gate_last.csv", H, gate_candles(gt))
        save(f"{OUT}/{name}_gate_mark.csv", H, gate_candles("mark_" + gt))
        save(f"{OUT}/{name}_gate_funding.csv", ["ts", "rate"], gate_funding(gt))
print("JOB DONE:", JOB, flush=True)
