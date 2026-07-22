/** 健康/完整率报表格式化（控制台表格 + JSON 落盘）。 */
import { writeFileSync } from 'node:fs';
import type { FeedReport } from './health.js';

export interface HealthReport {
  runStartedTs: number;
  reportTs: number;
  windowMinutes: number;
  feeds: FeedReport[];
  /** 主指标：连接在线率（等权平均） */
  overallUptimePct: number | null;
  /** 次指标：tick 覆盖率（等权平均，闭市期偏低属正常） */
  overallTickCoveragePct: number | null;
}

function avg(vals: Array<number | null>): number | null {
  const xs = vals.filter((v): v is number => v !== null);
  return xs.length ? Number((xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(2)) : null;
}

export function buildHealthReport(
  reports: FeedReport[],
  runStartedTs: number,
  reportTs: number,
): HealthReport {
  return {
    runStartedTs,
    reportTs,
    windowMinutes: Math.round((reportTs - runStartedTs) / 60000),
    feeds: reports,
    overallUptimePct: avg(reports.map((r) => r.uptimePct)),
    overallTickCoveragePct: avg(reports.map((r) => r.tickCoveragePct)),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

export function formatHealthTable(rep: HealthReport): string {
  const lines: string[] = [];
  lines.push(
    `完整率报表 | 窗口 ${rep.windowMinutes}min | 在线率(主) ${rep.overallUptimePct ?? 'n/a'}% | tick覆盖(次) ${rep.overallTickCoveragePct ?? 'n/a'}%`,
  );
  lines.push(
    `${pad('feed', 10)} ${pad('status', 12)} ${padL('msgs', 9)} ${padL('accept', 9)} ${padL('reject', 7)} ${padL('recon', 6)} ${padL('uptime%', 8)} ${padL('tick%', 7)} ${padL('skew_med', 9)} ${padL('skew_p95', 9)}`,
  );
  for (const f of rep.feeds) {
    lines.push(
      `${pad(f.name, 10)} ${pad(f.status, 12)} ${padL(String(f.messages), 9)} ${padL(String(f.ticksAccepted), 9)} ${padL(String(f.ticksRejected), 7)} ${padL(String(f.reconnects), 6)} ${padL(f.uptimePct === null ? 'n/a' : f.uptimePct.toFixed(1), 8)} ${padL(f.tickCoveragePct === null ? 'n/a' : f.tickCoveragePct.toFixed(1), 7)} ${padL(f.skew.medianMs === null ? 'n/a' : `${f.skew.medianMs}ms`, 9)} ${padL(f.skew.p95Ms === null ? 'n/a' : `${f.skew.p95Ms}ms`, 9)}`,
    );
  }
  return lines.join('\n');
}

export function writeHealthReport(path: string, rep: HealthReport): void {
  writeFileSync(path, JSON.stringify(rep, null, 2));
}
