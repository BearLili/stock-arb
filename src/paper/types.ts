/** M2 纸面撮合领域类型。 */
import type { Prod } from '../types.js';

export type Side = 'buy' | 'sell';
export type OrderType = 'taker' | 'maker';
/** 撮合口径：naive=决策时观测价立即成交(乐观)；corrected=订单 t+rtt 到达按真实报价成交 */
export type FillMode = 'naive' | 'corrected';

/** 录制的一条报价（来自 JSONL） */
export interface Quote {
  bid: number;
  ask: number;
  tsExch: number | null;
  tsRecv: number;
}

/** 一条腿的下单意图。role 用于 v2 应急对冲：hedge 腿仅在 primary 成交后按其成交时刻下单 */
export interface Leg {
  prod: Prod;
  side: Side;
  type: OrderType;
  role?: 'primary' | 'hedge';
}

/** 一个开/平仓信号（含两腿） */
export interface TradeSignal {
  posId: string;
  strategy: string;
  sym: string;
  pair: string; // "a-b"
  ts: number; // 决策时刻(ts_recv)
  action: 'open' | 'close';
  legs: Leg[];
  /** 决策时的 diff（bp），仅记录用 */
  refDiffBp: number;
  reason: string;
}

/** 一条腿的模拟成交结果 */
export interface FilledLeg {
  prod: Prod;
  side: Side;
  type: OrderType;
  filled: boolean;
  tsDecision: number;
  tsFill: number | null;
  fillPrice: number | null;
  midAtFill: number | null; // 成交所用报价的中间价（滑点归因）
  feeBp: number; // 该腿该侧费率（maker 可为负=返佣）
}

/** 策略接口（backtest/paper/live 三模式同签名，开发文档 §2）。
 *  纸面回测用 onEval 驱动（引擎已算好每对 diff/dev/edge）。 */
export interface Strategy {
  readonly name: string;
  /** 引擎每次 pair 求值回调 → 策略产出开/平仓信号（可空） */
  onEval(ev: import('../engine/netEdge.js').PairEval): TradeSignal[];
  /** 数据结束时强制平掉未平仓头寸（carry-hold 尤其需要）；ts 应留出 rtt 余量 */
  forceClose(ts: number): TradeSignal[];
}

/** 时点日化资金费查询(bp/天)；无则 null */
export type FundingLookup = (sym: string, prod: Prod, tsMs: number) => number | null;

/** PnL 四项归因（bp of notional） */
export interface PnlBreakdown {
  priceBp: number; // 价差（中间价收敛）
  feeBp: number; // 手续费（taker/maker，含返佣）
  slipBp: number; // 滑点（fill vs mid + taker 1bp）
  carryBp: number; // 资金费（持仓期 net carry）
  totalBp: number; // 合计
}

/** 一笔完成的往返交易（开+平） */
export interface Trade {
  posId: string;
  strategy: string;
  sym: string;
  pair: string;
  tsOpen: number;
  tsClose: number;
  holdMin: number;
  openLegs: FilledLeg[];
  closeLegs: FilledLeg[];
  pnl: PnlBreakdown;
  filledOk: boolean; // 四条腿是否都成交
  note: string;
}
