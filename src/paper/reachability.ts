/**
 * 可达性分析：机会段时长 vs 总延迟（rtt + 数据滞后）。
 * Boss 实测：SNDK mexc-bn 偏离>10.2bp 段中位仅 ~1 秒；若总延迟>段时长则机会不可达。
 * 这比 PnL 更能解释 taker 类策略（S1）为何抓不到——你还没下到单，机会段已关闭。
 *
 * 口径：机会 = |diff − 中位基线| > 全taker往返成本(该对实时点差)。段时长按引擎 ts_recv 视图测。
 * 总延迟 = 慢腿(MEXC)实测数据滞后中位 + 两腿下单 rtt(config)。可达 = 段时长 > 总延迟。
 */
import type { Config } from '../config.js';
import type { Prod } from '../types.js';
import type { PairEval } from '../engine/netEdge.js';
import { median } from '../engine/baseline.js';

interface PairSeg {
  a: Prod;
  b: Prod;
  durations: number[]; // 每个机会段时长(ms)
  onTs: number | null; // 当前机会段起点
  lastTs: number | null;
  totalMs: number;
  oppMs: number;
  wasOpp: boolean;
}

export interface ReachRow {
  sym: string;
  pair: string;
  nSegments: number;
  oppPct: number; // 机会段占总时长%
  medianDurMs: number | null;
  p95DurMs: number | null;
  totalDelayMs: number; // 慢腿滞后 + 两腿 rtt
  reachablePct: number | null; // 段时长 > 总延迟 的段占比
}

export class ReachabilityTracker {
  private readonly pairs = new Map<string, PairSeg>();

  constructor(private readonly cfg: Config) {}

  observe(ev: PairEval): void {
    if (ev.medianBase === null) return;
    const key = `${ev.sym}|${ev.pair}`;
    let st = this.pairs.get(key);
    if (!st) {
      st = { a: ev.a, b: ev.b, durations: [], onTs: null, lastTs: null, totalMs: 0, oppMs: 0, wasOpp: false };
      this.pairs.set(key, st);
    }
    const cost = this.cfg.roundTripTakerCostBp(ev.a, ev.b, ev.spreadABp + ev.spreadBBp);
    const opp = Math.abs(ev.diffBp - ev.medianBase) > cost;
    if (st.lastTs !== null) {
      const dt = ev.ts - st.lastTs;
      st.totalMs += dt;
      if (st.wasOpp) st.oppMs += dt;
    }
    if (opp && st.onTs === null) st.onTs = ev.ts;
    else if (!opp && st.onTs !== null) {
      st.durations.push(ev.ts - st.onTs);
      st.onTs = null;
    }
    st.lastTs = ev.ts;
    st.wasOpp = opp;
  }

  /** lagByProd: 各 prod 实测数据滞后中位(ms, ts_recv−ts_exch)。 */
  rows(lagByProd: Map<string, number>): ReachRow[] {
    const out: ReachRow[] = [];
    for (const [key, st] of this.pairs) {
      // 收尾未关闭的段
      if (st.onTs !== null && st.lastTs !== null) st.durations.push(st.lastTs - st.onTs);
      const [sym, pair] = key.split('|');
      const durs = [...st.durations].sort((x, y) => x - y);
      const lagA = lagByProd.get(st.a) ?? 0;
      const lagB = lagByProd.get(st.b) ?? 0;
      const totalDelay = Math.max(lagA, lagB) + this.cfg.rttMs(st.a) + this.cfg.rttMs(st.b);
      const reachable = durs.length ? (100 * durs.filter((d) => d > totalDelay).length) / durs.length : null;
      out.push({
        sym: sym!,
        pair: pair!,
        nSegments: durs.length,
        oppPct: st.totalMs > 0 ? Number(((100 * st.oppMs) / st.totalMs).toFixed(2)) : 0,
        medianDurMs: durs.length ? Math.round(median(durs)!) : null,
        p95DurMs: durs.length ? Math.round(durs[Math.min(durs.length - 1, Math.floor(0.95 * durs.length))]!) : null,
        totalDelayMs: Math.round(totalDelay),
        reachablePct: reachable === null ? null : Number(reachable.toFixed(1)),
      });
    }
    return out;
  }
}
