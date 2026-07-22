/**
 * M2 报表：未校正 vs 校正后 PnL 对比、maker 成交率、S1/S2 进 M3 建议。
 */
import type { Config } from '../config.js';
import type { FillMode, Trade } from './types.js';
import { utcDateKey } from '../time.js';

/** 数据窗口内的美股交易日日历（UTC 工作日 Mon–Fri；周末天然缺席，Fri→Mon 视为连续）。 */
export function tradingDaysCalendar(minTs: number, maxTs: number): string[] {
  const out: string[] = [];
  const start = new Date(utcDateKey(minTs) + 'T00:00:00Z').getTime();
  const end = new Date(utcDateKey(maxTs) + 'T00:00:00Z').getTime();
  for (let t = start; t <= end; t += 86400000) {
    const wd = new Date(t).getUTCDay(); // 0=Sun..6=Sat
    if (wd >= 1 && wd <= 5) out.push(utcDateKey(t));
  }
  return out;
}

export interface StratModeSummary {
  strategy: string;
  mode: FillMode;
  nTrades: number;
  nFilled: number;
  captureRatePct: number;
  totalBp: number;
  avgBpPerTrade: number;
  pnl: { priceBp: number; feeBp: number; slipBp: number; carryBp: number };
  dailyBp: Array<{ day: string; bp: number }>;
  maxConsecPosDays: number;
  makerLegs: number;
  makerFilled: number;
  makerFillRatePct: number | null;
}

function makerStats(trades: Trade[]): { attempted: number; filled: number } {
  let attempted = 0;
  let filled = 0;
  for (const t of trades) {
    for (const l of [...t.openLegs, ...t.closeLegs]) {
      if (l.type === 'maker') {
        attempted += 1;
        if (l.filled) filled += 1;
      }
    }
  }
  return { attempted, filled };
}

/**
 * 沿交易日日历数"连续正收益交易日"：日历中每个交易日 PnL=当日成交净额(缺席记0)；
 * 非正（含无交易=0、负收益）的交易日重置连击（审计 H1）。
 */
function maxConsecutivePositiveDays(byDay: Map<string, number>, tradingDays: string[] | null): number {
  const days = tradingDays ?? [...byDay.keys()].sort((a, b) => a.localeCompare(b));
  let best = 0;
  let cur = 0;
  for (const d of days) {
    if ((byDay.get(d) ?? 0) > 0) {
      cur += 1;
      best = Math.max(best, cur);
    } else cur = 0;
  }
  return best;
}

export function summarize(strategy: string, mode: FillMode, all: Trade[], tradingDays: string[] | null = null): StratModeSummary {
  const trades = all.filter((t) => t.strategy === strategy);
  const filled = trades.filter((t) => t.filledOk);
  const totalBp = filled.reduce((s, t) => s + t.pnl.totalBp, 0);
  const byDay = new Map<string, number>();
  for (const t of filled) {
    const day = utcDateKey(t.tsClose);
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl.totalBp);
  }
  const dailyBp = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bp]) => ({ day, bp: Number(bp.toFixed(2)) }));
  const mk = makerStats(trades);
  return {
    strategy,
    mode,
    nTrades: trades.length,
    nFilled: filled.length,
    captureRatePct: trades.length ? Number(((filled.length / trades.length) * 100).toFixed(1)) : 0,
    totalBp: Number(totalBp.toFixed(2)),
    avgBpPerTrade: filled.length ? Number((totalBp / filled.length).toFixed(2)) : 0,
    pnl: {
      priceBp: Number(filled.reduce((s, t) => s + t.pnl.priceBp, 0).toFixed(2)),
      feeBp: Number(filled.reduce((s, t) => s + t.pnl.feeBp, 0).toFixed(2)),
      slipBp: Number(filled.reduce((s, t) => s + t.pnl.slipBp, 0).toFixed(2)),
      carryBp: Number(filled.reduce((s, t) => s + t.pnl.carryBp, 0).toFixed(2)),
    },
    dailyBp,
    maxConsecPosDays: maxConsecutivePositiveDays(byDay, tradingDays),
    makerLegs: mk.attempted,
    makerFilled: mk.filled,
    makerFillRatePct: mk.attempted ? Number(((mk.filled / mk.attempted) * 100).toFixed(1)) : null,
  };
}

export interface M3Verdict {
  strategy: string;
  correctedTotalBp: number;
  naiveTotalBp: number;
  illusionBp: number; // naive − corrected（陈价幻象量）
  correctedConsecPosDays: number;
  requiredDays: number;
  makerFillRatePct: number | null;
  makerWarning: string | null; // maker 成交率<30% 的显式重估提示
  qualifies: boolean;
  recommendation: string;
}

const MAKER_FILL_FLOOR_PCT = 30;

export function m3Verdicts(
  cfg: Config,
  strategies: string[],
  naive: Trade[],
  corrected: Trade[],
  tradingDays: string[] | null = null,
): M3Verdict[] {
  const req = cfg.paper.min_trading_days_for_m3;
  return strategies.map((s) => {
    const n = summarize(s, 'naive', naive, tradingDays);
    const c = summarize(s, 'corrected', corrected, tradingDays);
    const qualifies = c.maxConsecPosDays >= req && c.totalBp > 0;
    let rec: string;
    if (c.nFilled === 0) rec = '数据不足：无完整成交（服务器回流足量 tick 后再判）';
    else if (c.maxConsecPosDays < req) rec = `数据不足：校正后仅 ${c.maxConsecPosDays} 连续正收益交易日 < ${req}，暂不进 M3`;
    else if (!qualifies) rec = '校正后不满足门槛（收益非正）→ 不进 M3';
    else rec = `校正后满足 ≥${req} 连续正收益交易日 → 建议进 M3`;
    // maker 成交率<30% 显式重估提示（S2 依赖 maker 返佣，开发文档 §4.3）
    let makerWarning: string | null = null;
    if (c.makerFillRatePct !== null && c.makerFillRatePct < MAKER_FILL_FLOOR_PCT) {
      makerWarning = `⚠️ ${s} maker 成交率 ${c.makerFillRatePct}% < ${MAKER_FILL_FLOOR_PCT}% → 需重估该策略（返佣假设不成立）`;
    }
    return {
      strategy: s,
      correctedTotalBp: c.totalBp,
      naiveTotalBp: n.totalBp,
      illusionBp: Number((n.totalBp - c.totalBp).toFixed(2)),
      correctedConsecPosDays: c.maxConsecPosDays,
      requiredDays: req,
      makerFillRatePct: c.makerFillRatePct,
      makerWarning,
      qualifies,
      recommendation: rec,
    };
  });
}
