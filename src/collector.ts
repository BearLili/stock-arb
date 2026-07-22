/**
 * M0 collector 入口：9 路 feed → 归一化 → 全量 JSONL 落盘 + 完整率/健康统计。
 *
 * 环境变量：
 *   CONFIG        配置路径（默认 monitor_config.json）
 *   REPORT_EVERY  健康报表间隔秒（默认 30）
 *   RUN_SECONDS   跑多少秒后自动停（默认 0=不限，Ctrl-C 停）
 *   NO_RECORD     =1 时不落盘（仅联通性/健康冒烟）
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from './config.js';
import { Bus } from './bus.js';
import { Health } from './health.js';
import { Normalizer } from './normalizer.js';
import { Recorder } from './recorder.js';
import { RunState } from './runstate.js';
import { startAllFeeds } from './feeds/index.js';
import type { FeedContext } from './feeds/runner.js';
import type { BboEvent } from './types.js';
import { buildHealthReport, formatHealthTable, writeHealthReport } from './report.js';
import { log } from './log.js';

async function main(): Promise<void> {
  const configPath = process.env.CONFIG ?? 'monitor_config.json';
  const reportEvery = Number(process.env.REPORT_EVERY ?? 30) * 1000;
  const runSeconds = Number(process.env.RUN_SECONDS ?? 0);
  const record = process.env.NO_RECORD !== '1';

  const cfg = Config.load(configPath);
  const startTs = Date.now();
  const bus = new Bus();
  const health = new Health(startTs);
  const norm = new Normalizer(bus, health);
  const recorder = record ? new Recorder('data/live') : null;
  const runState = new RunState('run-state.db');
  const runId = runState.startRun(record ? 'collector' : 'collector-smoke', startTs);

  const onBbo = (e: BboEvent): void => recorder?.write(e);
  if (recorder) bus.onBbo(onBbo);

  const ac = new AbortController();
  const ctx: FeedContext = { cfg, norm, health, signal: ac.signal, enableTrades: false };

  log.info(
    { symbols: cfg.symbolsList, feeds: 9, record, configPath },
    'M0 collector 启动',
  );

  mkdirSync(join('data', 'live'), { recursive: true });

  const emitReport = (final: boolean): void => {
    const now = Date.now();
    const rep = buildHealthReport(health.report(now), startTs, now);
    runState.snapshot(runId, now, rep.feeds);
    // 控制台
    // eslint-disable-next-line no-console
    console.log('\n' + formatHealthTable(rep));
    if (recorder) console.log(`落盘累计 ${recorder.lineCount} 行`);
    // 落盘一份 JSON 样例
    const path = final ? 'data/live/completeness-report.json' : 'data/live/completeness-latest.json';
    writeHealthReport(path, rep);
  };

  const reportTimer = setInterval(() => emitReport(false), reportEvery);

  let shutdownPromise: Promise<void> | null = null;
  const doShutdown = async (reason: string): Promise<void> => {
    log.info({ reason }, '关停中…');
    clearInterval(reportTimer);
    if (runTimer) clearTimeout(runTimer);
    ac.abort();
    // 停止落盘写入：先解绑监听 + 置 recorder.closed，再等 feed 退出
    if (recorder) bus.off('bbo', onBbo);
    await new Promise((r) => setTimeout(r, 800));
    if (recorder) await recorder.close();
    emitReport(true);
    runState.stopRun(runId, Date.now());
    runState.close();
    log.info('已停止。完整率报表：data/live/completeness-report.json');
  };
  // 重入：第二个信号 await 同一次关停后再退出，避免中断 gzip 归档（审计 M2）
  const shutdown = (reason: string): Promise<void> => {
    if (!shutdownPromise) shutdownPromise = doShutdown(reason);
    return shutdownPromise;
  };

  process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));

  let runTimer: NodeJS.Timeout | null = null;
  if (runSeconds > 0) {
    runTimer = setTimeout(() => void shutdown('RUN_SECONDS').then(() => process.exit(0)), runSeconds * 1000);
  }

  await startAllFeeds(ctx);
}

main().catch((e) => {
  log.error({ err: (e as Error).stack ?? String(e) }, 'collector 崩溃');
  process.exit(1);
});
