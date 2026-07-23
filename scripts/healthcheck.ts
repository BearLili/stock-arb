/**
 * 健康检查：读最近一次完整率报表(data/live/completeness-latest.json)，
 * 任一 feed 在线率 < 阈值 或 报表过旧 则退出码 1（供 cron/监控告警）。
 * 用法：npx tsx scripts/healthcheck.ts   （或 pm2/systemd 侧挂 cron）
 * 环境：MIN_UPTIME_PCT(默认95)、MAX_REPORT_AGE_SEC(默认180)
 */
import { readFileSync, statfsSync } from 'node:fs';

const MIN_UPTIME = Number(process.env.MIN_UPTIME_PCT ?? 95);
// 报表每 REPORT_EVERY 刷新，正常最大年龄=该间隔。阈值默认 = max(180, 3×REPORT_EVERY)：
// 与采集器同读 REPORT_EVERY（30s→180s 灵敏，300s→900s 不误报）；真卡死年龄无上限仍被抓。
const REPORT_EVERY = Number(process.env.REPORT_EVERY ?? 60);
const MAX_AGE_SEC = Number(process.env.MAX_REPORT_AGE_SEC ?? Math.max(180, 3 * REPORT_EVERY));
const MIN_FREE_GB = Number(process.env.MIN_FREE_GB ?? 5);
const path = process.env.HEALTH_REPORT ?? 'data/live/completeness-latest.json';

/** 落盘目录可用空间(GB)；取不到返回 null */
function freeGB(dir = 'data'): number | null {
  try {
    const s = statfsSync(dir);
    return (Number(s.bavail) * Number(s.bsize)) / 1e9;
  } catch {
    return null;
  }
}

interface Feed {
  name: string;
  status: string;
  uptimePct: number | null;
}
interface Report {
  reportTs: number;
  feeds: Feed[];
}

function main(): void {
  let rep: Report;
  try {
    rep = JSON.parse(readFileSync(path, 'utf8')) as Report;
  } catch {
    console.error(`UNHEALTHY: 读不到报表 ${path}（进程可能未启动/未产出）`);
    process.exit(1);
  }
  const problems: string[] = [];
  const free = freeGB();
  if (free !== null && free < MIN_FREE_GB) {
    problems.push(`磁盘余量 ${free.toFixed(1)}GB < ${MIN_FREE_GB}GB（落盘将受阻）`);
  }
  if (!Number.isFinite(rep.reportTs)) {
    problems.push('报表缺 reportTs（格式异常）');
  } else {
    const ageSec = (Date.now() - rep.reportTs) / 1000;
    if (ageSec > MAX_AGE_SEC) problems.push(`报表过旧 ${ageSec.toFixed(0)}s > ${MAX_AGE_SEC}s（进程可能卡死）`);
  }
  if (!Array.isArray(rep.feeds) || rep.feeds.length === 0) {
    problems.push('报表无 feeds 字段');
  } else {
    for (const f of rep.feeds) {
      if (f.status === 'disconnected') {
        problems.push(`${f.name} 已断开 (status=disconnected)`);
      } else if (f.uptimePct !== null && f.uptimePct < MIN_UPTIME) {
        problems.push(`${f.name} 在线率 ${f.uptimePct}% < ${MIN_UPTIME}% (status=${f.status})`);
      }
    }
  }
  if (problems.length) {
    console.error('UNHEALTHY:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  const ageSec = Number.isFinite(rep.reportTs) ? (Date.now() - rep.reportTs) / 1000 : NaN;
  console.log(`HEALTHY: ${rep.feeds.length} feeds，报表 ${ageSec.toFixed(0)}s 前，全部在线率 ≥${MIN_UPTIME}%，磁盘余量 ${free === null ? 'n/a' : free.toFixed(1) + 'GB'}`);
  process.exit(0);
}

main();
