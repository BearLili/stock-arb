/**
 * 时间与市场日历工具。
 *
 * 两套时区口径，刻意分开：
 *  - HL tradeXYZ 休市窗口：ET（America/New_York, DST 感知）—— 开发文档 §3.2/§6 明确用 ET。
 *  - 美股 session regime：UTC 13:30–20:00 —— 与 analyze_gap.py 回测口径一致（2026 夏令时）。
 *  - JSONL 落盘按日分区：UTC 日期（与回测数据一致）。
 */

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface EtParts {
  weekday: number; // 0=Sun … 6=Sat
  hour: number; // 0..23
  minute: number;
  dateKey: string; // YYYY-MM-DD in ET
}

export function etParts(ms: number): EtParts {
  const parts = ET_FMT.formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
  return { weekday, hour, minute, dateKey };
}

/**
 * HL tradeXYZ 休市：周五 20:00 ET → 周日 20:00 ET（无行情推送）。
 * 休市期含 HL 的对需：暂停告警 + 冻结基线（EWMA & 滚动中位），防重开陈价污染。
 */
export function isHlClosed(ms: number): boolean {
  const { weekday, hour } = etParts(ms);
  if (weekday === 6) return true; // 周六全天
  if (weekday === 5 && hour >= 20) return true; // 周五 20:00 起
  if (weekday === 0 && hour < 20) return true; // 周日 20:00 前
  return false;
}

export type Regime = 'session' | 'closed_wd' | 'weekend';

/**
 * 美股 regime（UTC 口径，与 analyze_gap.py 一致）：
 *  - weekend: UTC 周六/周日
 *  - session: UTC 工作日 13:30–20:00
 *  - closed_wd: 其余工作日时段
 */
export function utcRegime(ms: number): Regime {
  const d = new Date(ms);
  const wd = d.getUTCDay(); // 0=Sun..6=Sat
  if (wd === 0 || wd === 6) return 'weekend';
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 13 * 60 + 30 && mins < 20 * 60) return 'session';
  return 'closed_wd';
}

/** 是否美股 session 内（UTC 工作日 13:30–20:00） */
export function isUsSession(ms: number): boolean {
  return utcRegime(ms) === 'session';
}

/** JSONL 落盘/报告按日分区键：UTC 日期 YYYY-MM-DD */
export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** hh:mm:ss（UTC）用于控制台日志 */
export function hms(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}
