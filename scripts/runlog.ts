/**
 * 每日完整率快照 → RUNLOG.jsonl（追加一行）。配 cron 每日一次。
 * 用途：留存"数据时钟从起跑起算、完整率守住>99%"的可审计逐日证据（裁决资格依据）。
 *   npm run runlog        （读 data/live/completeness-latest.json）
 * cron: 5 0 * * *  cd /path && npx tsx scripts/runlog.ts   # 每日 UTC 00:05
 */
import { readFileSync, appendFileSync, statfsSync } from 'node:fs';

const REPORT = process.env.HEALTH_REPORT ?? 'data/live/completeness-latest.json';
const OUT = process.env.RUNLOG ?? 'data/live/RUNLOG.jsonl';

function freeGB(dir = 'data'): number | null {
  try {
    const s = statfsSync(dir);
    return Number(((Number(s.bavail) * Number(s.bsize)) / 1e9).toFixed(1));
  } catch {
    return null;
  }
}

interface FeedRow { name: string; status: string; uptimePct: number | null; tickCoveragePct: number | null; reconnects: number; skew: { medianMs: number | null; p95Ms: number | null } }
interface Report { reportTs: number; windowMinutes: number; overallUptimePct: number | null; overallTickCoveragePct: number | null; feeds: FeedRow[] }

function main(): void {
  let rep: Report;
  try {
    rep = JSON.parse(readFileSync(REPORT, 'utf8')) as Report;
  } catch {
    console.error(`读不到 ${REPORT}（collector 未产出？）`);
    process.exit(1);
  }
  if (!Number.isFinite(rep.reportTs) || !Array.isArray(rep.feeds)) {
    console.error(`${REPORT} 格式异常（缺 reportTs/feeds），跳过本次快照`);
    process.exit(1);
  }
  const line = {
    ts: rep.reportTs,
    date_utc: new Date(rep.reportTs).toISOString().slice(0, 10),
    window_min: rep.windowMinutes,
    uptime_pct: rep.overallUptimePct,
    tick_cov_pct: rep.overallTickCoveragePct,
    free_gb: freeGB(),
    // 逐 feed 精简：名字→在线率，及 MEXC-FUT 滞后（裁决关注）
    feeds: rep.feeds.map((f) => ({ n: f.name, up: f.uptimePct, rc: f.reconnects })),
    mexc_fut_skew: rep.feeds.find((f) => f.name === 'MEXC-FUT')?.skew ?? null,
  };
  appendFileSync(OUT, JSON.stringify(line) + '\n');
  const worst = rep.feeds.filter((f) => f.uptimePct !== null).sort((a, b) => (a.uptimePct ?? 0) - (b.uptimePct ?? 0))[0];
  console.log(`RUNLOG += ${line.date_utc}: 在线率 ${rep.overallUptimePct}% (最低 ${worst?.name} ${worst?.uptimePct}%), 磁盘 ${line.free_gb}GB → ${OUT}`);
  process.exit(0);
}

main();
