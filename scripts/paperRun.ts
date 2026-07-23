/**
 * M2 纸面撮合运行器：读落盘 tick JSONL → 引擎(ts_recv视图)驱动 S1/S2 → 两口径撮合 → 报表。
 * 用法：npm run paper           （读 data/live）
 *      LANDING=<dir> npm run paper
 * 无 tick 数据时如实输出"数据不足"，不出伪结论（服务器回流后再跑）。data/ 只读。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Config } from '../src/config.js';
import { Replay } from '../src/paper/replay.js';
import { FundingHistory } from '../src/paper/fundingHistory.js';
import { runPaperPipeline } from '../src/paper/run.js';
import { summarize, m3Verdicts, funnel, type StratModeSummary } from '../src/paper/report.js';

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

  // carry / S3 决策都用资金费历史(minute_data_v3 的 per-sym funding，%/settle)
  const fh = FundingHistory.fromMinuteData(process.env.FUNDING ?? 'data/minute_data_v3.json');
  const res = runPaperPipeline(cfg, replay, fh);
  const { strats: STRATS, naiveTrades, correctedTrades, tradingDays } = res;

  const summaries: StratModeSummary[] = [];
  for (const s of STRATS) {
    summaries.push(summarize(s, 'naive', naiveTrades, tradingDays));
    summaries.push(summarize(s, 'corrected', correctedTrades, tradingDays));
  }
  const verdicts = m3Verdicts(cfg, STRATS, naiveTrades, correctedTrades, tradingDays);

  // ---- 控制台 ----
  console.log('===== M2 纸面撮合报告 =====');
  console.log(`落盘覆盖：${res.utcDays} 个 UTC 日（其中交易日 ${tradingDays.length}），${res.ticks} 条 tick，${res.signals} 条开/平信号`);
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

  // S3 回本天数 = 现货一次性费(bp) / 永续日化 carry(bp/天)（PRD §3.3 口径）
  const s3variants = [
    { name: 'S3bn', spot: 'bstocks', perp: 'bnperp' },
    { name: 'S3gate', spot: 'gstocks', perp: 'gateperp' },
  ] as const;
  const paybackRows: Array<Record<string, unknown>> = [];
  for (const v of s3variants) {
    for (const sym of ['SNDK', 'CRCL', 'MU']) {
      const spotFee = cfg.takerFeeBp(v.spot);
      const dc = fh.dailyBp(sym, v.perp);
      paybackRows.push({
        变体: v.name, sym, 现货费bp: spotFee,
        日carry_bp: dc === null ? 'n/a' : dc.toFixed(2),
        回本天数: dc !== null && dc > 0 ? (spotFee / dc).toFixed(1) : 'n/a',
      });
    }
  }
  console.log('\n[S3 回本天数] 现货一次性费 / 永续日化carry（越小越快回本）:');
  console.table(paybackRows);

  // S2 意图→成交漏斗（maker 未穿越流失分解）
  // v1 vs v2 成交漏斗对比（v2 应急对冲预期消除"开仓单腿"这一环）
  console.log('\n[成交漏斗 v1 vs v2] 非成交源于 maker 对侧超时未穿越；v2 hedge 腿仅在 primary 成交后下 → 无单腿:');
  const funnelRows: Array<Record<string, unknown>> = [];
  for (const s of STRATS.filter((n) => n === 'S2' || n === 'S2v2')) {
    const f = funnel(s, 'corrected', correctedTrades);
    const pc = (n: number): string => (f.total ? `${((n / f.total) * 100).toFixed(1)}%` : '0');
    funnelRows.push({
      策略: s, 尝试: f.total, 完整成交: f.complete, 完整率: `${f.completePct}%`,
      '②平仓卡住': pc(f.openBothClosePartial), '③开仓单腿(需撤退)': pc(f.openPartial), '④未入场': pc(f.openNone),
    });
  }
  console.table(funnelRows);
  const s2v2 = funnel('S2v2', 'corrected', correctedTrades);
  if (s2v2.total > 0) {
    console.log(`→ S2v2 单腿(需撤退)占比 = ${s2v2.total ? ((s2v2.openPartial / s2v2.total) * 100).toFixed(1) : '0'}%（应≈0，应急对冲设计）；完整成交率 ${s2v2.completePct}% vs S2 ${funnel('S2', 'corrected', correctedTrades).completePct}%`);
  }

  mkdirSync('docs/samples', { recursive: true });
  writeFileSync(
    'docs/samples/M2_paper_report.json',
    JSON.stringify(
      {
        dataSource: process.env.LANDING ?? 'data/live',
        sufficient: tradingDays.length >= cfg.paper.min_trading_days_for_m3,
        coverage: { utcDays: res.utcDays, tradingDays: tradingDays.length, ticks: res.ticks, signals: res.signals },
        notes: [
          'carry=资金费历史(minute_data_v3, %/settle)按持仓期离散结算累计；短持仓(S1/S2分钟级)少跨结算→carry小属正常，S3长持仓才显著',
          'maker 滑点=逆向选择成本(fill-time mid 基准)，非挂价改善；总 PnL 自洽',
          '连续正收益交易日按美股交易日日历计数（无交易/负收益日重置）',
          '真实 S1/S2 进 M3 裁决数字需服务器回流足量真实 tick 后重跑',
        ],
        summaries,
        verdicts,
        s3Payback: paybackRows,
        funnels: { S2: funnel('S2', 'corrected', correctedTrades), S2v2: funnel('S2v2', 'corrected', correctedTrades), S1v2: funnel('S1v2', 'corrected', correctedTrades) },
      },
      null,
      2,
    ),
  );
  console.log('\n报告已写入 docs/samples/M2_paper_report.json');
  process.exit(0);
}

main();
