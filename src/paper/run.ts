/**
 * 纸面撮合流水线（paperRun 与 sweep 共用）：
 *   replay 事件流(ts_recv视图) → 引擎驱动策略收集信号 → 两口径撮合 → 交易集。
 */
import type { Config } from '../config.js';
import type { Replay } from './replay.js';
import type { FundingHistory } from './fundingHistory.js';
import { NetEdgeEngine } from '../engine/netEdge.js';
import { silentSink } from '../engine/alerts.js';
import { buildStrategies } from './strategies.js';
import { runBook, type CarryFn } from './portfolio.js';
import { tradingDaysCalendar } from './report.js';
import { median } from '../engine/baseline.js';
import { ReachabilityTracker, type ReachRow } from './reachability.js';
import type { Trade, TradeSignal } from './types.js';

export interface PaperResult {
  strats: string[];
  signals: number;
  naiveTrades: Trade[];
  correctedTrades: Trade[];
  tradingDays: string[];
  utcDays: number;
  ticks: number;
  reachRows: ReachRow[];
}

/** 各 prod 实测数据滞后中位(ms, ts_recv−ts_exch)。 */
function lagByProd(replay: Replay): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const e of replay.events) {
    if (e.tsExch === null) continue;
    (acc.get(e.prod) ?? acc.set(e.prod, []).get(e.prod)!).push(e.tsRecv - e.tsExch);
  }
  const out = new Map<string, number>();
  for (const [prod, arr] of acc) out.set(prod, median(arr) ?? 0);
  return out;
}

export function runPaperPipeline(cfg: Config, replay: Replay, fh: FundingHistory): PaperResult {
  const carry: CarryFn = (sym, prod, dir, tsOpen, tsClose) => fh.legCarryBp(sym, prod, dir, tsOpen, tsClose);
  const strategies = buildStrategies(cfg, (sym, prod, ts) => fh.dailyBpAt(sym, prod, ts));
  const strats = [...new Set(strategies.map((s) => s.name))];
  const reach = new ReachabilityTracker(cfg);

  const signals: TradeSignal[] = [];
  let clock = 0;
  const engine = new NetEdgeEngine({
    cfg,
    alerts: silentSink,
    now: () => clock,
    onEval: (ev) => {
      reach.observe(ev);
      for (const s of strategies) signals.push(...s.onEval(ev));
    },
  });
  for (const e of replay.events) {
    clock = e.tsRecv;
    engine.onBbo(e);
  }
  const eodTs = Math.max(replay.events[0]!.tsRecv, replay.events[replay.events.length - 1]!.tsRecv - 10000);
  for (const s of strategies) signals.push(...s.forceClose(eodTs));

  const naive = runBook(signals, replay, cfg, 'naive', carry);
  const corrected = runBook(signals, replay, cfg, 'corrected', carry);

  const days = new Set(replay.events.map((e) => new Date(e.tsRecv).toISOString().slice(0, 10)));
  const tradingDays = tradingDaysCalendar(replay.events[0]!.tsRecv, replay.events[replay.events.length - 1]!.tsRecv);

  return {
    strats,
    signals: signals.length,
    naiveTrades: naive.trades,
    correctedTrades: corrected.trades,
    tradingDays,
    utcDays: days.size,
    ticks: replay.events.length,
    reachRows: reach.rows(lagByProd(replay)),
  };
}
