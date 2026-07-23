/**
 * 风控闸门层（Strategy→Intent 与 Executor→Order 之间）。任一 fail 拒单。
 * 含开发文档 §6 十道闸门 + EMERGENCY_UNWIND 频率自刹车（同策略日内 ≥limit 次自动暂停）。
 * 纯状态 + 纯函数式检查，便于自动化测试。
 */
import type { Config } from '../config.js';
import type { Prod } from '../types.js';

export interface OpenRequest {
  strategy: string;
  sym: string;
  primary: Prod;
  hedge: Prod;
  notionalUsd: number;
  nowMs: number;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

export class RiskGates {
  private killed = false;
  private readonly paused = new Set<string>();
  private dailyPnlUsd = 0;
  private readonly strategyExposureUsd = new Map<string, number>();
  private totalExposureUsd = 0;
  private readonly apiErrorsPerMin = new Map<string, number>(); // venue → errs/min
  private clockSkewMs = 0;
  // EMERGENCY_UNWIND 频率：strategy|utcDate → 次数
  private readonly euCount = new Map<string, number>();

  constructor(
    private readonly cfg: Config,
    private readonly opts: {
      tradeablePairs: Set<string>; // "primary-hedge" 白名单
      mexcStale: (prod: Prod, nowMs: number) => boolean;
      isHlClosingWindow: (nowMs: number) => boolean;
      isEventBlackout: (sym: string, nowMs: number) => boolean;
    },
  ) {}

  // ---- 状态注入（executor/store 更新）----
  setKilled(v: boolean): void { this.killed = v; }
  pauseStrategy(s: string): void { this.paused.add(s); }
  resumeStrategy(s: string): void { this.paused.delete(s); }
  isPaused(s: string): boolean { return this.paused.has(s); }
  setDailyPnl(usd: number): void { this.dailyPnlUsd = usd; }
  setExposure(strategy: string, usd: number): void { this.strategyExposureUsd.set(strategy, usd); }
  setTotalExposure(usd: number): void { this.totalExposureUsd = usd; }
  setApiErrorRate(venue: string, perMin: number): void { this.apiErrorsPerMin.set(venue, perMin); }
  setClockSkew(ms: number): void { this.clockSkewMs = ms; }

  private static day(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

  /** 记一次 EMERGENCY_UNWIND；达日限则自动暂停该策略并返回 true(已暂停) */
  recordEmergencyUnwind(strategy: string, nowMs: number): { paused: boolean; count: number } {
    const key = `${strategy}|${RiskGates.day(nowMs)}`;
    const n = (this.euCount.get(key) ?? 0) + 1;
    this.euCount.set(key, n);
    if (n >= this.cfg.risk.emergency_unwind_daily_limit) {
      this.paused.add(strategy);
      return { paused: true, count: n };
    }
    return { paused: false, count: n };
  }

  private venueOf(prod: Prod): string {
    if (prod.startsWith('bn') || prod === 'bstocks') return 'binance';
    if (prod.startsWith('gate') || prod === 'gstocks' || prod === 'xstocks') return 'gate';
    if (prod === 'bybitx') return 'bybit';
    if (prod === 'okxx') return 'okx';
    if (prod === 'mexcperp' || prod === 'mexcon') return 'mexc';
    if (prod === 'hlperp') return 'hyperliquid';
    return prod;
  }

  /** 开仓前逐道闸门 */
  checkOpen(r: OpenRequest): GateResult {
    const R = this.cfg.risk;
    if (this.killed) return { ok: false, reason: 'kill switch 已触发，拒一切新单' };
    if (this.paused.has(r.strategy)) return { ok: false, reason: `策略 ${r.strategy} 已暂停` };
    if (!this.opts.tradeablePairs.has(`${r.primary}-${r.hedge}`)) return { ok: false, reason: `对 ${r.primary}-${r.hedge} 不在白名单` };
    if (!this.cfg.tradeable(r.primary) || !this.cfg.tradeable(r.hedge)) return { ok: false, reason: '含 tradeable=false 腿' };
    if (!(r.notionalUsd > 0) || r.notionalUsd > R.max_notional_usd) return { ok: false, reason: `单笔名义 ${r.notionalUsd} 超上限 ${R.max_notional_usd}` };
    const stratExp = (this.strategyExposureUsd.get(r.strategy) ?? 0) + r.notionalUsd;
    if (stratExp > R.max_strategy_exposure_usd) return { ok: false, reason: `策略净敞口 ${stratExp} 超 ${R.max_strategy_exposure_usd}` };
    if (this.totalExposureUsd + r.notionalUsd > R.max_total_exposure_usd) return { ok: false, reason: `总净敞口超 ${R.max_total_exposure_usd}` };
    if (this.dailyPnlUsd <= -R.daily_loss_halt_usd) return { ok: false, reason: `日亏损熔断（${this.dailyPnlUsd} ≤ -${R.daily_loss_halt_usd}）` };
    for (const prod of [r.primary, r.hedge]) {
      const venue = this.venueOf(prod);
      if ((this.apiErrorsPerMin.get(venue) ?? 0) > R.api_error_rate_per_min) return { ok: false, reason: `${venue} API 错误率超限，熔断中` };
    }
    if (this.opts.mexcStale(r.hedge, r.nowMs) || this.opts.mexcStale(r.primary, r.nowMs)) return { ok: false, reason: 'MEXC 腿 ts_exch 陈旧(>2s)，拒单' };
    if ((r.primary === 'hlperp' || r.hedge === 'hlperp') && this.opts.isHlClosingWindow(r.nowMs)) return { ok: false, reason: 'HL 休市前强平窗口，拒新开' };
    if (this.opts.isEventBlackout(r.sym, r.nowMs)) return { ok: false, reason: `${r.sym} 事件日黑窗，暂停新开` };
    if (Math.abs(this.clockSkewMs) > R.clock_skew_reject_ms) return { ok: false, reason: `时钟偏移 ${this.clockSkewMs}ms 超 ${R.clock_skew_reject_ms}ms，新鲜度门失真，拒单` };
    return { ok: true };
  }
}
