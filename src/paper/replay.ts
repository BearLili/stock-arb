/**
 * 回放：把落盘 JSONL(含 gz) 载入内存，提供
 *  - 全局 ts_recv 有序事件流（喂引擎/策略，= 实盘真实视图，含陈价）
 *  - quoteAt(决策时观测价，naive)
 *  - fillQuote(订单到达时刻 event-time 对齐的真实价，corrected taker)
 *  - firstCross(maker 对侧穿越判定)
 * 有效事件时间 e(q)=tsExch ?? tsRecv（无 ts_exch 的腿以 ts_recv 近似）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { Prod, BboEvent } from '../types.js';
import type { Quote, Side } from './types.js';

function eventTime(q: Quote): number {
  return q.tsExch ?? q.tsRecv;
}

interface KeySeries {
  byRecv: Quote[]; // 按 tsRecv 升序
  byEvent: Quote[]; // 按有效事件时间升序
}

export class Replay {
  private readonly series = new Map<string, KeySeries>();
  readonly events: BboEvent[] = []; // 全局 ts_recv 升序

  private static key(sym: string, prod: Prod): string {
    return `${sym}|${prod}`;
  }

  /** 从 data/live 目录（或指定根）载入全部 JSONL/gz */
  static load(root = 'data/live'): Replay {
    const r = new Replay();
    if (!existsSync(root)) return r;
    const perKey = new Map<string, Quote[]>();
    for (const day of readdirSync(root)) {
      const dir = join(root, day);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue; // 非目录（如 completeness-*.json）
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl') && !f.endsWith('.jsonl.gz')) continue;
        const path = join(dir, f);
        const buf = readFileSync(path);
        const text = f.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          let d: { ts_exch: number | null; ts_recv: number; sym: string; prod: Prod; bid: number; ask: number };
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          const q: Quote = { bid: d.bid, ask: d.ask, tsExch: d.ts_exch, tsRecv: d.ts_recv };
          const k = Replay.key(d.sym, d.prod);
          (perKey.get(k) ?? perKey.set(k, []).get(k)!).push(q);
          r.events.push({ sym: d.sym, prod: d.prod, bid: d.bid, ask: d.ask, tsExch: d.ts_exch, tsRecv: d.ts_recv });
        }
      }
    }
    for (const [k, arr] of perKey) {
      const byRecv = [...arr].sort((a, b) => a.tsRecv - b.tsRecv);
      const byEvent = [...arr].sort((a, b) => eventTime(a) - eventTime(b));
      r.series.set(k, { byRecv, byEvent });
    }
    r.events.sort((a, b) => a.tsRecv - b.tsRecv);
    return r;
  }

  /** 内存直建（单测/合成数据用） */
  static fromQuotes(rows: Array<{ sym: string; prod: Prod } & Quote>): Replay {
    const r = new Replay();
    const perKey = new Map<string, Quote[]>();
    for (const d of rows) {
      const q: Quote = { bid: d.bid, ask: d.ask, tsExch: d.tsExch, tsRecv: d.tsRecv };
      const k = Replay.key(d.sym, d.prod);
      (perKey.get(k) ?? perKey.set(k, []).get(k)!).push(q);
      r.events.push({ sym: d.sym, prod: d.prod, bid: d.bid, ask: d.ask, tsExch: d.tsExch, tsRecv: d.tsRecv });
    }
    for (const [k, arr] of perKey) {
      r.series.set(k, {
        byRecv: [...arr].sort((a, b) => a.tsRecv - b.tsRecv),
        byEvent: [...arr].sort((a, b) => eventTime(a) - eventTime(b)),
      });
    }
    r.events.sort((a, b) => a.tsRecv - b.tsRecv);
    return r;
  }

  get symbolsProds(): string[] {
    return [...this.series.keys()];
  }

  /** 决策时观测价：最新 tsRecv ≤ ts 的报价（naive 视图） */
  quoteAt(sym: string, prod: Prod, ts: number): Quote | null {
    const s = this.series.get(Replay.key(sym, prod));
    if (!s) return null;
    const a = s.byRecv;
    let lo = 0;
    let hi = a.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid]!.tsRecv <= ts) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 ? a[ans]! : null;
  }

  /** 订单到达时刻 arrival 的真实成交报价：第一条 e(q) ≥ arrival（corrected taker） */
  fillQuote(sym: string, prod: Prod, arrival: number): Quote | null {
    const s = this.series.get(Replay.key(sym, prod));
    if (!s) return null;
    const a = s.byEvent;
    let lo = 0;
    let hi = a.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (eventTime(a[mid]!) >= arrival) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans >= 0 ? a[ans]! : null;
  }

  /**
   * maker 对侧穿越判定：挂单价 P，从 fromTs（event-time）起，timeoutMs 内
   * 首个对侧价穿越 P 的报价。买单挂 bid=P → 等 ask≤P；卖单挂 ask=P → 等 bid≥P。
   * 返回穿越报价（成交价=P）；无则 null。
   */
  firstCross(sym: string, prod: Prod, fromTs: number, side: Side, price: number, timeoutMs: number): Quote | null {
    const s = this.series.get(Replay.key(sym, prod));
    if (!s) return null;
    const a = s.byEvent;
    // 定位第一个 e(q) ≥ fromTs
    let lo = 0;
    let hi = a.length - 1;
    let start = a.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (eventTime(a[mid]!) >= fromTs) {
        start = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    for (let i = start; i < a.length; i += 1) {
      const q = a[i]!;
      if (eventTime(q) > fromTs + timeoutMs) return null;
      if (side === 'buy' && q.ask <= price) return q; // 挂 bid，被 ask 打穿
      if (side === 'sell' && q.bid >= price) return q; // 挂 ask，被 bid 打穿
    }
    return null;
  }
}
