/**
 * 参数扫描 harness（只框架、不调参）。网格跑批 → 结果表。
 * ⚠️ 禁止在合成数据上据此选"最优参数"——那是过拟合噪声。范围由用户在**真实数据**上定。
 *
 * 维度（预留）：入场阈值(entry_cost_mult) / 基线窗口(baseline_window_min) /
 *   对冲(maker)超时(maker_timeout_ms) / maker挂单偏移(maker_offset_bp)。
 * 用法：LANDING=data/synth_live npm run sweep
 * 网格可用 env 覆盖（逗号分隔）：ENTRY_MULT / BASE_WIN / MAKER_TO_MS / MAKER_OFF_BP
 */
import { Config } from '../src/config.js';
import { Replay } from '../src/paper/replay.js';
import { FundingHistory } from '../src/paper/fundingHistory.js';
import { runPaperPipeline } from '../src/paper/run.js';
import { summarize } from '../src/paper/report.js';

function grid(envName: string, dflt: number[]): number[] {
  const v = process.env[envName];
  return v ? v.split(',').map(Number) : dflt;
}

function main(): void {
  const baseCfg = Config.load(process.env.CONFIG ?? 'monitor_config.json');
  const replay = Replay.load(process.env.LANDING ?? 'data/live');
  if (replay.events.length === 0) {
    console.log('❌ 数据不足：无 tick 落盘数据。sweep 需 tick 数据（服务器回流后再跑）。');
    process.exit(0);
  }
  const fh = FundingHistory.fromMinuteData(process.env.FUNDING ?? 'data/minute_data_v3.json');

  // 默认小网格（仅演示 harness；真实范围由用户定）
  const ENTRY_MULT = grid('ENTRY_MULT', [1.0, 1.5]);
  const BASE_WIN = grid('BASE_WIN', [240]);
  const MAKER_TO_MS = grid('MAKER_TO_MS', [60000]);
  const MAKER_OFF_BP = grid('MAKER_OFF_BP', [0, 1]);

  const combos = ENTRY_MULT.length * BASE_WIN.length * MAKER_TO_MS.length * MAKER_OFF_BP.length;
  console.log(`参数扫描 harness：${combos} 组合（entry×${ENTRY_MULT.length} base×${BASE_WIN.length} to×${MAKER_TO_MS.length} off×${MAKER_OFF_BP.length}）`);
  console.log('⚠️ 只列结果、不选最优；合成数据上的"最优"是过拟合噪声。真实数据回流后由用户定范围。\n');

  const rows: Array<Record<string, unknown>> = [];
  for (const em of ENTRY_MULT) {
    for (const bw of BASE_WIN) {
      for (const to of MAKER_TO_MS) {
        for (const off of MAKER_OFF_BP) {
          const cfg = baseCfg.override({
            engine: { baseline_window_min: bw },
            paper: { entry_cost_mult: em, maker_timeout_ms: to, maker_offset_bp: off },
          });
          const res = runPaperPipeline(cfg, replay, fh);
          const row: Record<string, unknown> = { entryMult: em, baseWin: bw, makerToS: to / 1000, makerOffBp: off };
          for (const s of res.strats) {
            const c = summarize(s, 'corrected', res.correctedTrades, res.tradingDays);
            row[`${s}_bp`] = c.totalBp;
            row[`${s}_posD`] = c.maxConsecPosDays;
            if (c.makerFillRatePct !== null) row[`${s}_mkFill%`] = c.makerFillRatePct;
          }
          rows.push(row);
        }
      }
    }
  }
  console.table(rows);
  console.log('\n（各列：<策略>_bp=校正后总PnL(bp)，_posD=连续正收益交易日，_mkFill%=maker成交率）');
  process.exit(0);
}

main();
