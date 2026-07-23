/**
 * Executor 状态持久化 + 对账。
 * ExecEventLog：executor 记录状态转换/拒单/强平/kill（对账与崩溃恢复的依据）。
 * MemStore：自动化测试用（内存记录，可断言）。SqliteStore：生产用(better-sqlite3, WAL)。
 * reconcile：交易所实际持仓 vs 本地预期，输出差异（交易所为准）。
 */
import Database from 'better-sqlite3';
import type { Prod } from '../types.js';

export interface ExecEvent {
  ts: number;
  type: 'transition' | 'rejected' | 'emergency_unwind' | 'kill';
  posId?: string;
  from?: string;
  to?: string;
  strategy?: string;
  sym?: string;
  note?: string;
}

export interface ExecEventLog {
  transition(posId: string, from: string, to: string, ts: number, note: string): void;
  rejected(strategy: string, sym: string, reason: string, ts: number): void;
  emergencyUnwind(posId: string, strategy: string, gap: number, count: number, paused: boolean, ts: number): void;
  kill(ts: number): void;
}

/** 内存实现（测试用） */
export class MemStore implements ExecEventLog {
  readonly events: ExecEvent[] = [];
  transition(posId: string, from: string, to: string, ts: number, note: string): void {
    this.events.push({ ts, type: 'transition', posId, from, to, note });
  }
  rejected(strategy: string, sym: string, reason: string, ts: number): void {
    this.events.push({ ts, type: 'rejected', strategy, sym, note: reason });
  }
  emergencyUnwind(posId: string, strategy: string, gap: number, count: number, paused: boolean, ts: number): void {
    this.events.push({ ts, type: 'emergency_unwind', posId, strategy, note: `gap=${gap} count=${count} paused=${paused}` });
  }
  kill(ts: number): void {
    this.events.push({ ts, type: 'kill' });
  }
  transitionsOf(posId: string): string[] {
    return this.events.filter((e) => e.type === 'transition' && e.posId === posId).map((e) => `${e.from}→${e.to}`);
  }
}

/** sqlite 实现（生产） */
export class SqliteStore implements ExecEventLog {
  private readonly db: Database.Database;
  private readonly ins: Database.Statement;
  constructor(path = 'exec-state.db') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS exec_events (
      ts INTEGER NOT NULL, type TEXT NOT NULL, pos_id TEXT, from_state TEXT, to_state TEXT,
      strategy TEXT, sym TEXT, note TEXT
    );`);
    this.ins = this.db.prepare('INSERT INTO exec_events (ts,type,pos_id,from_state,to_state,strategy,sym,note) VALUES (?,?,?,?,?,?,?,?)');
  }
  transition(posId: string, from: string, to: string, ts: number, note: string): void {
    this.ins.run(ts, 'transition', posId, from, to, null, null, note);
  }
  rejected(strategy: string, sym: string, reason: string, ts: number): void {
    this.ins.run(ts, 'rejected', null, null, null, strategy, sym, reason);
  }
  emergencyUnwind(posId: string, strategy: string, gap: number, count: number, paused: boolean, ts: number): void {
    this.ins.run(ts, 'emergency_unwind', posId, null, null, strategy, null, `gap=${gap} count=${count} paused=${paused}`);
  }
  kill(ts: number): void {
    this.ins.run(ts, 'kill', null, null, null, null, null, null);
  }
  close(): void {
    this.db.close();
  }
}

export interface ReconResult {
  matched: Array<{ sym: string; prod: Prod; qty: number }>;
  exchangeOnly: Array<{ sym: string; prod: Prod; qty: number }>; // 交易所有本地无 → 补记
  localOnly: Array<{ sym: string; prod: Prod; qty: number }>; // 本地有交易所无 → 标失败
  qtyMismatch: Array<{ sym: string; prod: Prod; exchange: number; local: number }>; // 以交易所为准
}

/** 对账：交易所实际持仓 vs 本地预期（key sym|prod） */
export function reconcile(
  exchange: Array<{ sym: string; prod: Prod; qty: number }>,
  local: Array<{ sym: string; prod: Prod; qty: number }>,
  tol = 1e-9,
): ReconResult {
  const key = (x: { sym: string; prod: Prod }): string => `${x.sym}|${x.prod}`;
  const exMap = new Map(exchange.map((x) => [key(x), x]));
  const loMap = new Map(local.map((x) => [key(x), x]));
  const res: ReconResult = { matched: [], exchangeOnly: [], localOnly: [], qtyMismatch: [] };
  for (const [k, ex] of exMap) {
    const lo = loMap.get(k);
    if (!lo) res.exchangeOnly.push(ex);
    else if (Math.abs(ex.qty - lo.qty) > tol) res.qtyMismatch.push({ sym: ex.sym, prod: ex.prod, exchange: ex.qty, local: lo.qty });
    else res.matched.push(ex);
  }
  for (const [k, lo] of loMap) if (!exMap.has(k)) res.localOnly.push(lo);
  return res;
}
