/**
 * 全局领域类型。
 * 术语：
 *  - prod（产品键）：bstocks/gstocks/xstocks/bybitx/okxx/mexcon/bnperp/gateperp/mexcperp/hlperp
 *  - sym（标的）：TSLA/NVDA/MU/SNDK/CRCL
 *  - 价格单位一律 quote 币（USDT/USDC），edge/dev 单位一律 bp（万分之一）
 */

/** 产品键（对应交易所×产品形态的一路行情） */
export type Prod =
  | 'bstocks'
  | 'gstocks'
  | 'xstocks'
  | 'bybitx'
  | 'okxx'
  | 'mexcon'
  | 'bnperp'
  | 'gateperp'
  | 'mexcperp'
  | 'hlperp';

/** 一条已归一化的 BBO（best bid/offer）事件 */
export interface BboEvent {
  sym: string;
  prod: Prod;
  bid: number;
  ask: number;
  /** 交易所事件时间（ms, epoch）。部分feed不提供 → null，需在 health 中标记 */
  tsExch: number | null;
  /** 本地接收时间（ms, epoch），必有 */
  tsRecv: number;
}

/** 归一化状态机中每个 (sym,prod) 的当前盘口 */
export interface BboState {
  bid: number;
  ask: number;
  tsExch: number | null;
  tsRecv: number;
}

/** feed 向总线上报的原始盘口（normalizer 补 tsRecv/校验） */
export interface FeedTick {
  sym: string;
  prod: Prod;
  bid: number;
  ask: number;
  tsExch: number | null;
}

/** feed 连接状态（用于 health / 完整率） */
export type FeedStatus = 'connecting' | 'connected' | 'disconnected';

/** 每路 feed 的健康计数 */
export interface FeedHealth {
  name: string;
  status: FeedStatus;
  messages: number;
  ticksAccepted: number;
  ticksRejected: number;
  reconnects: number;
  lastMsgTs: number | null;
  /** ts_recv - ts_exch 的偏移样本（ms），用于分布统计 */
  skewSamplesMs: number[];
}
