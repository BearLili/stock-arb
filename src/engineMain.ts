/**
 * M1 引擎入口：9 路 feed → 归一化 → [全量落盘] + 净edge引擎(告警) + 资金费轮询。
 * 是 M0 collector 的超集（多了 engine + funding + alerts），单进程跑通 M1。
 *
 * 环境变量：
 *   CONFIG / REPORT_EVERY / RUN_SECONDS 同 collector
 *   RECORD=0     关闭落盘（仅告警/联通冒烟）
 *   ALERT_WEBHOOK 告警 webhook 端点（可选）
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from './config.js';
import { Bus } from './bus.js';
import { Health } from './health.js';
import { Normalizer } from './normalizer.js';
import { Recorder } from './recorder.js';
import { RunState } from './runstate.js';
import { startAllFeeds } from './feeds/index.js';
import type { FeedContext } from './feeds/runner.js';
import { NetEdgeEngine } from './engine/netEdge.js';
import { Alerts } from './engine/alerts.js';
import { FundingPoller } from './engine/funding.js';
import { buildHealthReport, formatHealthTable, writeHealthReport } from './report.js';
import type { BboEvent } from './types.js';
import { log } from './log.js';

function ensureCsvHeader(path: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, 'ts,sym,pair,kind,side,edge_bp,dev_bp,baseline,carry_bp_day,stale_downgrade\n');
  }
}

async function main(): Promise<void> {
  const configPath = process.env.CONFIG ?? 'monitor_config.json';
  const reportEvery = Number(process.env.REPORT_EVERY ?? 30) * 1000;
  const runSeconds = Number(process.env.RUN_SECONDS ?? 0);
  const record = process.env.RECORD !== '0';

  const cfg = Config.load(configPath);
  const startTs = Date.now();
  const bus = new Bus();
  const health = new Health(startTs);
  const norm = new Normalizer(bus, health);
  const recorder = record ? new Recorder('data/live') : null;
  const runState = new RunState('run-state.db');
  const runId = runState.startRun('engine', startTs);

  ensureCsvHeader(cfg.alertCsv);
  const alerts = new Alerts(cfg.alertCsv, cfg.engine.alert_cooldown_ms);
  const funding = new FundingPoller(cfg);
  const engine = new NetEdgeEngine({ cfg, alerts, carry: funding.carry });

  const onBbo = (e: BboEvent): void => {
    recorder?.write(e);
    engine.onBbo(e);
  };
  bus.onBbo(onBbo);

  const ac = new AbortController();
  const ctx: FeedContext = { cfg, norm, health, signal: ac.signal, enableTrades: false };

  log.info({ symbols: cfg.symbolsList, record, edgeThr: cfg.edgeThresholdBp, devThr: cfg.devThresholdBp }, 'M1 引擎启动');
  mkdirSync(join('data', 'live'), { recursive: true });

  const emitReport = (final: boolean): void => {
    const now = Date.now();
    const rep = buildHealthReport(health.report(now), startTs, now);
    runState.snapshot(runId, now, rep.feeds);
    // eslint-disable-next-line no-console
    console.log('\n' + formatHealthTable(rep));
    const fund = funding.snapshot();
    if (fund.length) {
      console.log(
        '资金费(日化bp): ' +
          fund
            .sort((a, b) => (a.sym + a.prod).localeCompare(b.sym + b.prod))
            .map((f) => `${f.sym}/${f.prod}=${f.dailyBp.toFixed(3)}`)
            .join('  '),
      );
    }
    writeHealthReport(final ? 'data/live/completeness-report.json' : 'data/live/completeness-latest.json', rep);
  };
  const reportTimer = setInterval(() => emitReport(false), reportEvery);

  let runTimer: NodeJS.Timeout | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const doShutdown = async (reason: string): Promise<void> => {
    log.info({ reason }, '关停中…');
    clearInterval(reportTimer);
    if (runTimer) clearTimeout(runTimer);
    ac.abort();
    bus.off('bbo', onBbo);
    await new Promise((r) => setTimeout(r, 800));
    if (recorder) await recorder.close();
    emitReport(true);
    runState.stopRun(runId, Date.now());
    runState.close();
    log.info('已停止。');
  };
  const shutdown = (reason: string): Promise<void> => {
    if (!shutdownPromise) shutdownPromise = doShutdown(reason);
    return shutdownPromise;
  };
  process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  if (runSeconds > 0) {
    runTimer = setTimeout(() => void shutdown('RUN_SECONDS').then(() => process.exit(0)), runSeconds * 1000);
  }

  // 资金费轮询后台跑
  void funding.run(ac.signal);
  await startAllFeeds(ctx);
}

main().catch((e) => {
  log.error({ err: (e as Error).stack ?? String(e) }, 'engine 崩溃');
  process.exit(1);
});
