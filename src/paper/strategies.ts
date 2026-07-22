/**
 * S1 / S2 策略（均值回归，作 PairEval 的消费者产出开/平仓信号）。
 *  - S1【SNDK/CRCL bnperp-mexcperp，taker】：diff 对 240m 中位偏离超全taker往返成本 → 开，回归 → 平。
 *  - S2【SNDK gateperp-mexcperp，maker】：基差偏离超 maker 阈值 → 开（挂单收基差+carry），回归 → 平。
 * 信号只用 ts_recv 视图（PairEval 来自实盘引擎，含陈价）；下单方向：diff>0 表示 a 腿更贵 → 卖a买b。
 */
import type { Config } from '../config.js';
import type { Prod } from '../types.js';
import type { PairEval } from '../engine/netEdge.js';
import type { Strategy, TradeSignal, OrderType, Leg, FundingLookup } from './types.js';

interface PosState {
  posId: string;
  dir: 1 | -1; // +1: 卖a买b（开仓时 dev>0）；-1: 买a卖b
  tsOpen: number;
}

export class MeanRevStrategy implements Strategy {
  readonly name: string;
  private readonly a: Prod;
  private readonly b: Prod;
  private readonly syms: Set<string>;
  private readonly legType: OrderType;
  private readonly pairKey: string;
  private seq = 0;
  private readonly pos = new Map<string, PosState>(); // key: sym

  constructor(opts: { name: string; a: Prod; b: Prod; syms: string[]; legType: OrderType }, private readonly cfg: Config) {
    this.name = opts.name;
    this.a = opts.a;
    this.b = opts.b;
    this.syms = new Set(opts.syms);
    this.legType = opts.legType;
    this.pairKey = `${opts.a}-${opts.b}`;
    // tradeable 双保险：任一腿不可交易则该策略不产信号
    if (!cfg.tradeable(opts.a) || !cfg.tradeable(opts.b)) {
      this.syms = new Set();
    }
  }

  private entryThresholdBp(ev: PairEval): number {
    const mult = this.cfg.paper.entry_cost_mult;
    if (this.legType === 'taker') {
      // 全taker往返成本（用实时点差）
      return this.cfg.roundTripTakerCostBp(this.a, this.b, ev.spreadABp + ev.spreadBBp) * mult;
    }
    return this.cfg.makerThresholdBp(this.a, this.b) * mult;
  }

  private legs(dir: 1 | -1, action: 'open' | 'close'): Leg[] {
    // 开仓 dir=+1：卖a买b；平仓则反向
    const sellA = action === 'open' ? dir === 1 : dir !== 1;
    return [
      { prod: this.a, side: sellA ? 'sell' : 'buy', type: this.legType },
      { prod: this.b, side: sellA ? 'buy' : 'sell', type: this.legType },
    ];
  }

  onEval(ev: PairEval): TradeSignal[] {
    if (ev.pair !== this.pairKey || !this.syms.has(ev.sym)) return [];
    if (ev.medianBase === null) return []; // 基线未就绪
    if (ev.frozen) return []; // 休市冻结
    const dev = ev.diffBp - ev.medianBase; // 回测口径：对中位基线的偏离
    const st = this.pos.get(ev.sym);

    if (!st) {
      const thr = this.entryThresholdBp(ev);
      let dir: 1 | -1 | 0 = 0;
      if (dev > thr) dir = 1;
      else if (dev < -thr) dir = -1;
      if (dir === 0) return [];
      this.seq += 1;
      const posId = `${this.name}-${ev.sym}-${this.seq}`;
      this.pos.set(ev.sym, { posId, dir, tsOpen: ev.ts });
      return [{ posId, strategy: this.name, sym: ev.sym, pair: this.pairKey, ts: ev.ts, action: 'open', legs: this.legs(dir, 'open'), refDiffBp: ev.diffBp, reason: `dev=${dev.toFixed(1)}>thr=${thr.toFixed(1)}` }];
    }

    // 持仓中：回归/超时/反向穿越 → 平
    const held = (ev.ts - st.tsOpen) / 60000;
    const reverted = Math.abs(dev) < this.cfg.paper.exit_band_bp;
    const crossedZero = (st.dir === 1 && dev < 0) || (st.dir === -1 && dev > 0);
    const timeout = held > this.cfg.paper.max_hold_min;
    if (reverted || crossedZero || timeout) {
      this.pos.delete(ev.sym);
      const reason = reverted ? 'reverted' : crossedZero ? 'crossed0' : 'timeout';
      return [{ posId: st.posId, strategy: this.name, sym: ev.sym, pair: this.pairKey, ts: ev.ts, action: 'close', legs: this.legs(st.dir, 'close'), refDiffBp: ev.diffBp, reason }];
    }
    return [];
  }

  forceClose(ts: number): TradeSignal[] {
    const out: TradeSignal[] = [];
    for (const [sym, st] of this.pos) {
      // 若头寸在 eodTs 之后才开仓，平仓 ts 不得早于开仓 ts（防负持仓/carry窗口反转，审计M1）
      const closeTs = Math.max(ts, st.tsOpen);
      out.push({ posId: st.posId, strategy: this.name, sym, pair: this.pairKey, ts: closeTs, action: 'close', legs: this.legs(st.dir, 'close'), refDiffBp: 0, reason: 'forced_eod' });
    }
    this.pos.clear();
    return out;
  }
}

/**
 * S3 carry-hold：现货多 + 永续空，收永续资金费。
 * 入场：永续日化资金费(bp/天) > 入场阈值 → 买现货、卖永续；
 * 平仓：资金费 < 退出阈值 或 超最长持仓天数 或 数据结束(forceClose)。
 * 现货腿费率一次性(BN 10bp/Gate 20bp)，永续腿 taker；carry 由 portfolio 按结算累计。
 */
export class CarryHoldStrategy implements Strategy {
  readonly name: string;
  private readonly spot: Prod;
  private readonly perp: Prod;
  private readonly syms: Set<string>;
  private readonly pairKey: string;
  private seq = 0;
  private readonly pos = new Map<string, { posId: string; tsOpen: number }>();

  constructor(
    opts: { name: string; spot: Prod; perp: Prod; syms: string[] },
    private readonly cfg: Config,
    private readonly fundingAt: FundingLookup,
  ) {
    this.name = opts.name;
    this.spot = opts.spot;
    this.perp = opts.perp;
    this.syms = new Set(opts.syms);
    this.pairKey = `${opts.spot}-${opts.perp}`;
    if (!cfg.tradeable(opts.spot) || !cfg.tradeable(opts.perp)) this.syms = new Set();
  }

  private legs(action: 'open' | 'close'): Leg[] {
    // 开：买现货 + 卖永续；平：反向
    const buySpot = action === 'open';
    return [
      { prod: this.spot, side: buySpot ? 'buy' : 'sell', type: 'taker' },
      { prod: this.perp, side: buySpot ? 'sell' : 'buy', type: 'taker' },
    ];
  }

  onEval(ev: PairEval): TradeSignal[] {
    if (ev.pair !== this.pairKey || !this.syms.has(ev.sym)) return [];
    const fBpDay = this.fundingAt(ev.sym, this.perp, ev.ts);
    if (fBpDay === null) return [];
    const st = this.pos.get(ev.sym);
    const p = this.cfg.paper;
    if (!st) {
      if (fBpDay > p.s3_entry_carry_bp_day) {
        this.seq += 1;
        const posId = `${this.name}-${ev.sym}-${this.seq}`;
        this.pos.set(ev.sym, { posId, tsOpen: ev.ts });
        return [{ posId, strategy: this.name, sym: ev.sym, pair: this.pairKey, ts: ev.ts, action: 'open', legs: this.legs('open'), refDiffBp: ev.diffBp, reason: `funding=${fBpDay.toFixed(2)}bp/日>入场` }];
      }
      return [];
    }
    const heldDays = (ev.ts - st.tsOpen) / 86400000;
    if (fBpDay < p.s3_exit_carry_bp_day || heldDays > p.s3_max_hold_days) {
      this.pos.delete(ev.sym);
      const reason = fBpDay < p.s3_exit_carry_bp_day ? 'funding衰减' : 'max_hold';
      return [{ posId: st.posId, strategy: this.name, sym: ev.sym, pair: this.pairKey, ts: ev.ts, action: 'close', legs: this.legs('close'), refDiffBp: ev.diffBp, reason }];
    }
    return [];
  }

  forceClose(ts: number): TradeSignal[] {
    const out: TradeSignal[] = [];
    for (const [sym, st] of this.pos) {
      const closeTs = Math.max(ts, st.tsOpen); // 防负持仓（审计M1）
      out.push({ posId: st.posId, strategy: this.name, sym, pair: this.pairKey, ts: closeTs, action: 'close', legs: this.legs('close'), refDiffBp: 0, reason: 'forced_eod' });
    }
    this.pos.clear();
    return out;
  }
}

/** 构造首发策略集：S1(taker均值回归) + S2(maker基差) + S3(现货多永续空carry)两变体。 */
export function buildStrategies(cfg: Config, fundingAt: FundingLookup): Strategy[] {
  return [
    new MeanRevStrategy({ name: 'S1', a: 'bnperp', b: 'mexcperp', syms: ['SNDK', 'CRCL'], legType: 'taker' }, cfg),
    new MeanRevStrategy({ name: 'S2', a: 'gateperp', b: 'mexcperp', syms: ['SNDK'], legType: 'maker' }, cfg),
    new CarryHoldStrategy({ name: 'S3bn', spot: 'bstocks', perp: 'bnperp', syms: ['SNDK', 'CRCL', 'MU'] }, cfg, fundingAt),
    new CarryHoldStrategy({ name: 'S3gate', spot: 'gstocks', perp: 'gateperp', syms: ['SNDK', 'CRCL', 'MU'] }, cfg, fundingAt),
  ];
}
