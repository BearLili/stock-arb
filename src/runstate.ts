/**
 * 运行状态持久化（better-sqlite3）：记录 run 起止 + 定期 health 快照。
 * 用途：崩溃/重启后可回看历史完整率，及 P2 executor 对账的落脚点。
 */
import Database from 'better-sqlite3';
import type { FeedReport } from './health.js';

export class RunState {
  private readonly db: Database.Database;
  private readonly insertSnap: Database.Statement;

  constructor(path = 'run-state.db') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_ts INTEGER NOT NULL,
        stopped_ts INTEGER,
        mode TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS health_snap (
        run_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        feed TEXT NOT NULL,
        status TEXT NOT NULL,
        messages INTEGER NOT NULL,
        ticks_accepted INTEGER NOT NULL,
        ticks_rejected INTEGER NOT NULL,
        reconnects INTEGER NOT NULL,
        uptime_pct REAL,
        tick_coverage_pct REAL,
        skew_median_ms REAL,
        skew_p95_ms REAL
      );
    `);
    this.insertSnap = this.db.prepare(`
      INSERT INTO health_snap
        (run_id, ts, feed, status, messages, ticks_accepted, ticks_rejected, reconnects, uptime_pct, tick_coverage_pct, skew_median_ms, skew_p95_ms)
      VALUES (@run_id, @ts, @feed, @status, @messages, @ticks_accepted, @ticks_rejected, @reconnects, @uptime_pct, @tick_coverage_pct, @skew_median_ms, @skew_p95_ms)
    `);
  }

  startRun(mode: string, now: number): number {
    const info = this.db.prepare('INSERT INTO runs (started_ts, mode) VALUES (?, ?)').run(now, mode);
    return Number(info.lastInsertRowid);
  }

  snapshot(runId: number, now: number, reports: FeedReport[]): void {
    const tx = this.db.transaction((rows: FeedReport[]) => {
      for (const r of rows) {
        this.insertSnap.run({
          run_id: runId,
          ts: now,
          feed: r.name,
          status: r.status,
          messages: r.messages,
          ticks_accepted: r.ticksAccepted,
          ticks_rejected: r.ticksRejected,
          reconnects: r.reconnects,
          uptime_pct: r.uptimePct,
          tick_coverage_pct: r.tickCoveragePct,
          skew_median_ms: r.skew.medianMs,
          skew_p95_ms: r.skew.p95Ms,
        });
      }
    });
    tx(reports);
  }

  stopRun(runId: number, now: number): void {
    this.db.prepare('UPDATE runs SET stopped_ts = ? WHERE id = ?').run(now, runId);
  }

  close(): void {
    this.db.close();
  }
}
