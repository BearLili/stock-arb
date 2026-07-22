/**
 * M1 净edge引擎（可执行口径 + 双轨基线 + 分级告警）。
 *
 * 对每个 config.pairs 里的对 [a,b]（在某 sym 上两腿都有行情时）：
 *   可执行净edge（唯一真实口径，开发文档 §4.1）：
 *     e1 = (bidA − askB)/mid×1e4 − takerA − takerB   （卖A买B）
 *     e2 = (bidB − askA)/mid×1e4 − takerA − takerB   （卖B买A）
 *   基线 diff = (midA − midB)/mid×1e4；EWMA 与 240m 滚动中位双轨；
 *   dev = 两轨中 |·| 较小者（保守，宁漏勿误）。
 * 去噪：单tick尖刺过滤（连续3tick确认）；腿陈旧丢弃（>stale_ms）；
 * HL 对休市（周五20:00–周日20:00 ET）冻结基线更新 + 暂停告警（防重开陈价污染喷告警）。
 */
import type { Config, EngineParams } from '../config.js';
import type { Prod } from '../types.js';
import type { AlertSink } from './alerts.js';
import { DualBaseline, conservativeDev } from './baseline.js';
import { isHlClosed } from '../time.js';

interface DenoisedState {
  bid: number;
  ask: number;
  tsRecv: number;
  tsExch: number | null;
}

interface SpikeState {
  acceptedMid: number | null;
  pendingMid: number | null;
  pendingCount: number;
}


/** 每次 pair 求值的完整快照（供 s4s5 / 信号落盘消费） */
export interface PairEval {
  ts: number;
  sym: string;
  pair: string;
  a: Prod;
  b: Prod;
  midA: number;
  midB: number;
  spreadABp: number;
  spreadBBp: number;
  diffBp: number;
  ewma: number | null;
  medianBase: number | null;
  devBp: number | null;
  which: 'ewma' | 'median' | 'none';
  edgeBp: number;
  side: string;
  frozen: boolean;
  carryBpDay: number | null;
}

export interface EngineDeps {
  cfg: Config;
  alerts: AlertSink;
  now?: () => number;
  /** 资金费 net carry 提供者：返回 a腿−b腿 的日化资金费差(bp/天)，无则 null */
  carry?: (sym: string, a: Prod, b: Prod) => number | null;
  /** 每次 pair 求值回调（s4s5/信号落盘用） */
  onEval?: (ev: PairEval) => void;
}

export class NetEdgeEngine {
  private readonly cfg: Config;
  private readonly alerts: AlertSink;
  private readonly now: () => number;
  private readonly states = new Map<string, DenoisedState>();
  private readonly spikes = new Map<string, SpikeState>();
  private readonly baselines = new Map<string, DualBaseline>();
  private readonly p: EngineParams;

  constructor(private readonly deps: EngineDeps) {
    this.cfg = deps.cfg;
    this.alerts = deps.alerts;
    this.now = deps.now ?? Date.now;
    this.p = deps.cfg.engine;
  }

  private static key(sym: string, prod: Prod): string {
    return `${sym}|${prod}`;
  }

  /**
   * 尖刺过滤：返回是否接受本 tick 进入引擎状态。
   * 逻辑：距上一被接受 mid 在阈值内 → 直接接受（正常移动）；超出 → 记为候选并累计
   * "连续偏离" 计数，累计到 spike_confirm_ticks 即接受最新值（真实/持续移动）。
   * 只要出现一个回到接受值附近的 tick，计数复位（单/少 tick 尖刺被过滤）。
   * pendingMid 始终前移到最新，避免持续高波动腿因"不聚集在首个候选值"而永久锁死（审计 M1）。
   */
  private acceptSpike(key: string, mid: number): boolean {
    const s = this.spikes.get(key);
    if (!s) {
      this.spikes.set(key, { acceptedMid: mid, pendingMid: null, pendingCount: 0 });
      return true;
    }
    const base = s.acceptedMid ?? mid;
    const rel = Math.abs(mid / base - 1) * 1e4;
    if (rel <= this.p.spike_filter_bp) {
      s.acceptedMid = mid;
      s.pendingMid = null;
      s.pendingCount = 0;
      return true;
    }
    // 偏离接受值：累计连续偏离计数，pendingMid 前移到最新
    s.pendingCount += 1;
    s.pendingMid = mid;
    if (s.pendingCount >= this.p.spike_confirm_ticks) {
      s.acceptedMid = mid; // 持续偏离已确认为真实移动
      s.pendingMid = null;
      s.pendingCount = 0;
      return true;
    }
    return false;
  }

  onBbo(e: { sym: string; prod: Prod; bid: number; ask: number; tsExch: number | null; tsRecv: number }): void {
    const key = NetEdgeEngine.key(e.sym, e.prod);
    const mid = (e.bid + e.ask) / 2;
    if (!this.acceptSpike(key, mid)) return; // 尖刺未确认，暂不采纳
    this.states.set(key, { bid: e.bid, ask: e.ask, tsRecv: e.tsRecv, tsExch: e.tsExch });
    this.check(e.sym);
  }

  private baseline(pairKey: string): DualBaseline {
    let b = this.baselines.get(pairKey);
    if (!b) {
      b = new DualBaseline(this.p.ewma_alpha, this.p.baseline_window_min, this.p.rolling_median_min_samples);
      this.baselines.set(pairKey, b);
    }
    return b;
  }

  /**
   * 含 MEXC 腿的对，判断该腿是否 ts_exch 陈旧（>mexc_edge_stale_ms）。
   * mexcperp（合约WS，有事件时间）按 now−tsExch 判定；
   * mexcon（现货REST，无事件时间）无法验证新鲜度 → 保守视为陈旧。
   * 非 MEXC 腿不触发此门（其新鲜度已由 stale_ms 兜底）。
   */
  private mexcLegStale(a: Prod, A: DenoisedState, b: Prod, B: DenoisedState, now: number): boolean {
    const legs: Array<[Prod, DenoisedState]> = [
      [a, A],
      [b, B],
    ];
    for (const [prod, st] of legs) {
      if (prod === 'mexcperp' || prod === 'mexcon') {
        if (st.tsExch === null) return true; // mexcon：无事件时间，不可验证
        if (now - st.tsExch > this.p.mexc_edge_stale_ms) return true;
      }
    }
    return false;
  }

  private check(sym: string): void {
    const now = this.now();
    for (const [a, b] of this.cfg.pairs) {
      const A = this.states.get(NetEdgeEngine.key(sym, a));
      const B = this.states.get(NetEdgeEngine.key(sym, b));
      if (!A || !B) continue;
      if (now - A.tsRecv > this.p.stale_ms || now - B.tsRecv > this.p.stale_ms) continue;

      const hlPair = a === 'hlperp' || b === 'hlperp';
      const frozen = hlPair && isHlClosed(now);

      const midA = (A.bid + A.ask) / 2;
      const midB = (B.bid + B.ask) / 2;
      const mid = (A.bid + A.ask + B.bid + B.ask) / 4;
      if (!(mid > 0)) continue;
      const diff = ((midA - midB) / mid) * 1e4;

      const pairKey = `${sym}|${a}-${b}`;
      const bs = this.baseline(pairKey);
      if (!frozen) bs.observe(Math.floor(now / 60000), diff);
      const { dev, which } = conservativeDev(diff, bs.ewmaValue, bs.medianValue);

      const takerA = this.cfg.takerFeeBp(a);
      const takerB = this.cfg.takerFeeBp(b);
      const e1 = ((A.bid - B.ask) / mid) * 1e4 - takerA - takerB;
      const e2 = ((B.bid - A.ask) / mid) * 1e4 - takerA - takerB;
      const edge = Math.max(e1, e2);
      const sellA = e1 >= e2;
      const side = sellA ? `卖${a}买${b}` : `卖${b}买${a}`;
      // carry 提供者返回 a−b 日化资金费差；按推荐 side 对齐符号：
      // 卖a买b(short a/long b) 收 da−db；卖b买a 收 db−da（审计 L1）
      const rawCarry = this.deps.carry?.(sym, a, b) ?? null;
      const carry = rawCarry === null ? null : sellA ? rawCarry : -rawCarry;

      this.deps.onEval?.({
        ts: now,
        sym,
        pair: `${a}-${b}`,
        a,
        b,
        midA,
        midB,
        spreadABp: ((A.ask - A.bid) / midA) * 1e4,
        spreadBBp: ((B.ask - B.bid) / midB) * 1e4,
        diffBp: diff,
        ewma: bs.ewmaValue,
        medianBase: bs.medianValue,
        devBp: dev,
        which,
        edgeBp: edge,
        side,
        frozen,
        carryBpDay: carry,
      });

      if (frozen) continue; // HL 休市：不告警

      const edgeHit = edge > this.cfg.edgeThresholdBp;
      const mexcStale = edgeHit && this.mexcLegStale(a, A, b, B, now);
      if (edgeHit && !mexcStale) {
        this.alerts.emit({
          ts: now, sym, pair: `${a}-${b}`, kind: 'EDGE', side,
          edgeBp: edge, devBp: dev, baseline: which, carryBpDay: carry,
        });
      } else if (edgeHit && mexcStale) {
        // 本应 EDGE，但 MEXC 腿 ts_exch 陈旧 → 降级为 DEV，防陈价当真机会（第5项）
        this.alerts.emit({
          ts: now, sym, pair: `${a}-${b}`, kind: 'DEV', side,
          edgeBp: edge, devBp: dev, baseline: which, carryBpDay: carry, staleDowngrade: true,
        });
      } else if (dev !== null && Math.abs(dev) > this.cfg.devThresholdBp) {
        this.alerts.emit({
          ts: now, sym, pair: `${a}-${b}`, kind: 'DEV', side,
          edgeBp: edge, devBp: dev, baseline: which, carryBpDay: carry,
        });
      }
    }
  }
}
