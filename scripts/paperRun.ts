/**
 * M2 纸面撮合运行器：读落盘 tick JSONL → 引擎(ts_recv视图)驱动 S1/S2 → 两口径撮合 → 报表。
 * 用法：npm run paper           （读 data/live）
 *      LANDING=<dir> npm run paper
 * 无 tick 数据时如实输出"数据不足"，不出伪结论（服务器回流后再跑）。data/ 只读。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Config } from '../src/config.js';
import { Replay } from '../src/paper/replay.js';
import { NetEdgeEngine } from '../src/engine/netEdge.js';
import { silentSink } from '../src/engine/alerts.js';
import { buildStrategies } from '../src/paper/strategies.js';
import { runBook, type CarryFn } from '../src/paper/portfolio.js';
import { summarize, m3Verdicts, tradingDaysCalendar, type StratModeSummary } from '../src/paper/report.js';
import type { TradeSignal } from '../src/paper/types.js';
import { utcDateKey } from '../src/time.js';

const STRATS = ['S1', 'S2'];

function main(): void {
  const cfg = Config.load(process.env.CONFIG ?? 'monitor_config.json');
  const replay = Replay.load(process.env.LANDING ?? 'data/live');

  if (replay.events.length === 0) {
    console.log('❌ 数据不足：data/live 下无 tick JSONL。M2 撮合需服务器回流的 tick 数据后再跑。');
    console.log('   （工程已就绪：npm run collector 采集 → 回流 JSONL → npm run paper）');
    mkdirSync('docs/samples', { recursive: true });
    writeFileSync('docs/samples/M2_paper_report.json', JSON.stringify({ sufficient: false, reason: '无 tick 落盘数据', note: '服务器采集回流后重跑' }, null, 2));
    process.exit(0);
  }

  // 引擎以 replay 时钟驱动（now=当前事件 ts_recv），onEval 路由到策略收集信号
  const strategies = buildStrategies(cfg);
  const signals: TradeSignal[] = [];
  let clock = 0;
  const engine = new NetEdgeEngine({
    cfg,
    alerts: silentSink,
    now: () => clock,
    onEval: (ev) => {
      for (const s of strategies) signals.push(...s.onEval(ev));
    },
  });
  for (const e of replay.events) {
    clock = e.tsRecv;
    engine.onBbo(e);
  }

  // carry：本期未接资金费历史 → 记 0（S2 basis+carry 的 carry 待接入 FundingPoller 快照/历史）
  const carry: CarryFn = () => null;

  const naive = runBook(signals, replay, cfg, 'naive', carry);
  const corrected = runBook(signals, replay, cfg, 'corrected', carry);

  const days = new Set(replay.events.map((e) => utcDateKey(e.tsRecv)));
  const minTs = replay.events[0]!.tsRecv;
  const maxTs = replay.events[replay.events.length - 1]!.tsRecv;
  const tradingDays = tradingDaysCalendar(minTs, maxTs);
  const summaries: StratModeSummary[] = [];
  for (const s of STRATS) {
    summaries.push(summarize(s, 'naive', naive.trades, tradingDays));
    summaries.push(summarize(s, 'corrected', corrected.trades, tradingDays));
  }
  const verdicts = m3Verdicts(cfg, STRATS, naive.trades, corrected.trades, tradingDays);

  // ---- 控制台 ----
  console.log('===== M2 纸面撮合报告 =====');
  console.log(`落盘覆盖：${days.size} 个 UTC 日（其中交易日 ${tradingDays.length}），${replay.events.length} 条 tick，${signals.length} 条开/平信号`);
  console.log('\n[未校正 vs 校正后] 每策略汇总:');
  console.table(
    summaries.map((s) => ({
      策略: s.strategy, 口径: s.mode, 笔数: s.nTrades, 成交完整: s.nFilled, 成交完整率: `${s.captureRatePct}%`,
      总PnL_bp: s.totalBp, 均PnL_bp: s.avgBpPerTrade, maker成交率: s.makerFillRatePct === null ? '—' : `${s.makerFillRatePct}%`,
    })),
  );
  console.log('\n[PnL 四项归因] 校正后（滑点：taker≈半点差+1bp；maker=逆向选择成本，非挂价改善）:');
  console.table(
    summaries.filter((s) => s.mode === 'corrected').map((s) => ({ 策略: s.strategy, 价差: s.pnl.priceBp, 手续费: s.pnl.feeBp, 滑点: s.pnl.slipBp, 资金费: s.pnl.carryBp, 合计: s.totalBp })),
  );
  console.log('\n[S1/S2 是否进 M3] 门槛=校正后连续≥%d 交易日纸面正收益:', cfg.paper.min_trading_days_for_m3);
  console.table(
    verdicts.map((v) => ({ 策略: v.strategy, 校正后总bp: v.correctedTotalBp, 未校正总bp: v.naiveTotalBp, 陈价幻象bp: v.illusionBp, 连续正日: v.correctedConsecPosDays, 建议: v.recommendation })),
  );
  for (const v of verdicts) if (v.makerWarning) console.log(v.makerWarning);

  mkdirSync('docs/samples', { recursive: true });
  writeFileSync(
    'docs/samples/M2_paper_report.json',
    JSON.stringify(
      {
        sufficient: tradingDays.length >= cfg.paper.min_trading_days_for_m3,
        coverage: { utcDays: days.size, tradingDays: tradingDays.length, ticks: replay.events.length, signals: signals.length },
        notes: [
          'carry 本期记0（资金费历史待接入 FundingPoller 快照/历史）',
          'maker 滑点=逆向选择成本(fill-time mid 基准)，非挂价改善；总 PnL 自洽',
          '连续正收益交易日按美股交易日日历计数（无交易/负收益日重置）',
          '真实 S1/S2 进 M3 裁决数字需服务器回流足量真实 tick 后重跑',
        ],
        summaries,
        verdicts,
      },
      null,
      2,
    ),
  );
  console.log('\n报告已写入 docs/samples/M2_paper_report.json');
  process.exit(0);
}

main();
