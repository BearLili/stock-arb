# -*- coding: utf-8 -*-
"""
多交易所股票代币/永续 实时价差监控
====================================
订阅各所 WebSocket bookTicker，实时计算产品对的"可执行净edge"(扣taker费+吃点差)，
超过阈值时告警(控制台+CSV日志，可配webhook)。

依赖: pip install websockets
运行: python3 ws_monitor.py [config.json]

可执行净edge定义(方向1: 在A卖出/在B买入):
  edge1_bp = (bidA - askB) / mid × 1e4 - feeA_taker_bp - feeB_taker_bp
方向2对称。edge>0 即扣费吃点差后立刻锁定的毛利(未计资金费与划转)。
同时维护每对的EWMA基线，报告"偏离基线"事件(适合均值回归型交易)。

注意:
- MEXC 现货WS为protobuf,此处用REST轮询替代(2s)
- Hyperliquid 计价USDC,与USDT有微小基差
- 永续对之间还需叠加资金费差(config.funding_note)
"""
import asyncio, json, ssl, sys, time, csv, urllib.request
try:
    import websockets
except ImportError:
    sys.exit("请先: pip install websockets")

CFG = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "monitor_config.json"))
FEES = CFG["taker_fee_bp"]
STATE = {}   # key=(sym,prod) -> {"bid":..,"ask":..,"t":..}
BASE = {}    # pair-key -> EWMA of mid-diff
ALERTS = csv.writer(open(CFG.get("alert_csv", "alerts.csv"), "a", newline=""))
SSL = ssl.create_default_context()

def now(): return time.strftime("%H:%M:%S", time.gmtime())

def upd(sym, prod, bid, ask):
    if bid <= 0 or ask <= 0: return
    STATE[(sym, prod)] = {"bid": bid, "ask": ask, "t": time.time()}
    check(sym)

def check(sym):
    for a, b in CFG["pairs"]:
        ka, kb = (sym, a), (sym, b)
        if ka not in STATE or kb not in STATE: continue
        A, B = STATE[ka], STATE[kb]
        if time.time() - A["t"] > 10 or time.time() - B["t"] > 10: continue
        mid = (A["bid"] + A["ask"] + B["bid"] + B["ask"]) / 4
        fee = FEES.get(a, 10) + FEES.get(b, 10)
        e1 = (A["bid"] - B["ask"]) / mid * 1e4 - fee   # 卖A买B
        e2 = (B["bid"] - A["ask"]) / mid * 1e4 - fee   # 卖B买A
        pk = f"{sym}|{a}-{b}"
        d = (A["bid"]+A["ask"]-B["bid"]-B["ask"])/2/mid*1e4
        BASE[pk] = d if pk not in BASE else BASE[pk]*0.999 + d*0.001
        dev = d - BASE[pk]
        thr = CFG.get("edge_threshold_bp", 3)
        if e1 > thr or e2 > thr:
            side = f"卖{a}买{b}" if e1 > e2 else f"卖{b}买{a}"
            edge = max(e1, e2)
            msg = f"[{now()}] EDGE {sym} {a}-{b} {side} 净{edge:.1f}bp (基线偏离{dev:+.1f}bp)"
            print(msg)
            ALERTS.writerow([int(time.time()), sym, f"{a}-{b}", side, round(edge,1), round(dev,1)])
        elif abs(dev) > CFG.get("dev_threshold_bp", 15):
            print(f"[{now()}] DEV  {sym} {a}-{b} 偏离基线{dev:+.1f}bp (taker净edge {max(e1,e2):.1f}bp)")

async def reconnecting(name, coro):
    while True:
        try:
            await coro()
        except Exception as e:
            print(f"[{now()}] {name} 断线: {str(e)[:80]} — 5s后重连")
            await asyncio.sleep(5)

# ---------- Binance ----------
async def binance_fut():
    syms = [s for s, m in CFG["symbols"].items() if "bnperp" in m]
    streams = "/".join(f"{m['bnperp'].lower()}@bookTicker" for s, m in CFG["symbols"].items() if "bnperp" in m)
    rev = {m["bnperp"]: s for s, m in CFG["symbols"].items() if "bnperp" in m}
    async with websockets.connect(f"wss://fstream.binance.com/stream?streams={streams}", ssl=SSL) as ws:
        print(f"[{now()}] Binance futures 已连接 ({len(syms)})")
        async for raw in ws:
            d = json.loads(raw).get("data", {})
            if d.get("s") in rev:
                upd(rev[d["s"]], "bnperp", float(d["b"]), float(d["a"]))

async def binance_spot():
    entries = [(s, m["bstocks"]) for s, m in CFG["symbols"].items() if "bstocks" in m]
    if not entries: return
    streams = "/".join(f"{v.lower()}@bookTicker" for _, v in entries)
    rev = {v: s for s, v in entries}
    async with websockets.connect(f"wss://stream.binance.com:9443/stream?streams={streams}", ssl=SSL) as ws:
        print(f"[{now()}] Binance spot 已连接")
        async for raw in ws:
            d = json.loads(raw).get("data", {})
            if d.get("s") in rev:
                upd(rev[d["s"]], "bstocks", float(d["b"]), float(d["a"]))

# ---------- Gate ----------
async def gate_fut():
    entries = [(s, m["gateperp"]) for s, m in CFG["symbols"].items() if "gateperp" in m]
    rev = {v: s for s, v in entries}
    async with websockets.connect("wss://fx-ws.gateio.ws/v4/ws/usdt", ssl=SSL) as ws:
        await ws.send(json.dumps({"time": int(time.time()), "channel": "futures.book_ticker",
                                  "event": "subscribe", "payload": [v for _, v in entries]}))
        print(f"[{now()}] Gate futures 已连接")
        async for raw in ws:
            d = json.loads(raw)
            r = d.get("result", {})
            if d.get("channel") == "futures.book_ticker" and isinstance(r, dict) and r.get("s") in rev:
                upd(rev[r["s"]], "gateperp", float(r["b"]), float(r["a"]))

async def gate_spot():
    entries = [(s, p, m[p]) for s, m in CFG["symbols"].items() for p in ("gstocks", "xstocks") if p in m]
    if not entries: return
    rev = {v: (s, p) for s, p, v in entries}
    async with websockets.connect("wss://api.gateio.ws/ws/v4/", ssl=SSL) as ws:
        await ws.send(json.dumps({"time": int(time.time()), "channel": "spot.book_ticker",
                                  "event": "subscribe", "payload": [v for _, _, v in entries]}))
        print(f"[{now()}] Gate spot 已连接")
        async for raw in ws:
            d = json.loads(raw)
            r = d.get("result", {})
            if d.get("channel") == "spot.book_ticker" and isinstance(r, dict) and r.get("s") in rev:
                s, p = rev[r["s"]]
                upd(s, p, float(r["b"]), float(r["a"]))

# ---------- Bybit ----------
async def bybit():
    entries = [(s, m["bybitx"]) for s, m in CFG["symbols"].items() if "bybitx" in m]
    if not entries: return
    rev = {v: s for s, v in entries}
    async with websockets.connect("wss://stream.bybit.com/v5/public/spot", ssl=SSL) as ws:
        await ws.send(json.dumps({"op": "subscribe", "args": [f"orderbook.1.{v}" for _, v in entries]}))
        print(f"[{now()}] Bybit spot 已连接")
        book = {}
        async for raw in ws:
            d = json.loads(raw)
            if "topic" not in d: continue
            symv = d["topic"].split(".")[-1]
            if symv not in rev: continue
            dd = d["data"]
            bk = book.setdefault(symv, {"b": None, "a": None})
            if dd.get("b"): bk["b"] = float(dd["b"][0][0])
            if dd.get("a"): bk["a"] = float(dd["a"][0][0])
            if bk["b"] and bk["a"]:
                upd(rev[symv], "bybitx", bk["b"], bk["a"])

# ---------- OKX ----------
async def okx():
    entries = [(s, m["okxx"]) for s, m in CFG["symbols"].items() if "okxx" in m]
    if not entries: return
    rev = {v: s for s, v in entries}
    async with websockets.connect("wss://ws.okx.com:8443/ws/v5/public", ssl=SSL) as ws:
        await ws.send(json.dumps({"op": "subscribe",
                                  "args": [{"channel": "books5", "instId": v} for _, v in entries]}))
        print(f"[{now()}] OKX 已连接")
        async for raw in ws:
            d = json.loads(raw)
            if d.get("arg", {}).get("channel") != "books5" or "data" not in d: continue
            inst = d["arg"]["instId"]
            if inst not in rev: continue
            r = d["data"][0]
            if r["bids"] and r["asks"]:
                upd(rev[inst], "okxx", float(r["bids"][0][0]), float(r["asks"][0][0]))

# ---------- MEXC ----------
async def mexc_fut():
    entries = [(s, m["mexcperp"]) for s, m in CFG["symbols"].items() if "mexcperp" in m]
    if not entries: return
    rev = {v: s for s, v in entries}
    async with websockets.connect("wss://contract.mexc.com/edge", ssl=SSL) as ws:
        for _, v in entries:
            await ws.send(json.dumps({"method": "sub.ticker", "param": {"symbol": v}}))
        print(f"[{now()}] MEXC futures 已连接")
        async def ping():
            while True:
                await ws.send(json.dumps({"method": "ping"})); await asyncio.sleep(15)
        asyncio.ensure_future(ping())
        async for raw in ws:
            d = json.loads(raw)
            if d.get("channel") == "push.ticker" and d.get("data", {}).get("symbol") in rev:
                r = d["data"]
                upd(rev[r["symbol"]], "mexcperp", float(r["bid1"]), float(r["ask1"]))

async def mexc_spot_poll():
    entries = [(s, m["mexcon"]) for s, m in CFG["symbols"].items() if "mexcon" in m]
    if not entries: return
    print(f"[{now()}] MEXC spot REST轮询启动 (2s)")
    loop = asyncio.get_event_loop()
    while True:
        for s, v in entries:
            try:
                d = await loop.run_in_executor(None, lambda v=v: json.loads(urllib.request.urlopen(
                    f"https://api.mexc.com/api/v3/ticker/bookTicker?symbol={v}", timeout=5).read()))
                upd(s, "mexcon", float(d["bidPrice"]), float(d["askPrice"]))
            except Exception:
                pass
        await asyncio.sleep(2)

# ---------- Hyperliquid ----------
async def hyperliquid():
    entries = [(s, m["hlperp"]) for s, m in CFG["symbols"].items() if "hlperp" in m]
    if not entries: return
    rev = {v: s for s, v in entries}
    async with websockets.connect("wss://api.hyperliquid.xyz/ws", ssl=SSL) as ws:
        for _, v in entries:
            await ws.send(json.dumps({"method": "subscribe", "subscription": {"type": "l2Book", "coin": v}}))
        print(f"[{now()}] Hyperliquid 已连接")
        async for raw in ws:
            d = json.loads(raw)
            if d.get("channel") != "l2Book": continue
            r = d["data"]
            if r.get("coin") in rev and r["levels"][0] and r["levels"][1]:
                upd(rev[r["coin"]], "hlperp",
                    float(r["levels"][0][0]["px"]), float(r["levels"][1][0]["px"]))

async def main():
    feeds = [("BN-FUT", binance_fut), ("BN-SPOT", binance_spot), ("GATE-FUT", gate_fut),
             ("GATE-SPOT", gate_spot), ("BYBIT", bybit), ("OKX", okx),
             ("MEXC-FUT", mexc_fut), ("MEXC-SPOT", mexc_spot_poll), ("HL", hyperliquid)]
    await asyncio.gather(*(reconnecting(n, f) for n, f in feeds))

if __name__ == "__main__":
    print("== 股票代币/永续 跨所监控 ==  Ctrl-C退出")
    asyncio.run(main())
