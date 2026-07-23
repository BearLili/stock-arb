/**
 * M3 executor 领域类型（venue-agnostic）。实盘适配器等裁决后再按胜出策略场所写。
 * 下单腿类型：maker(挂单) / ioc(立即成交否则取消，用于 taker 对冲，消除迟到成交竞态)。
 */
import type { Prod } from '../types.js';
export type { Prod };

export type Side = 'buy' | 'sell';
export type ExecOrderType = 'maker' | 'ioc';
export type OrderStatus = 'open' | 'partial' | 'filled' | 'canceled' | 'rejected';

/** 下单请求（executor→adapter） */
export interface OrderReq {
  clientOrderId: string;
  sym: string;
  prod: Prod;
  side: Side;
  type: ExecOrderType;
  qty: number; // 名义 base 数量（>0）
  price?: number; // maker 挂价；ioc 可省（市价/激进）
  role: 'primary' | 'hedge';
}

/** 订单回报（adapter→executor.onUpdate） */
export interface OrderUpdate {
  clientOrderId: string;
  status: OrderStatus;
  filledQty: number; // 累计已成交
  avgPrice: number | null;
}

/** 场所适配器接口：executor 只依赖此接口，live/paper 各自实现 */
export interface VenueAdapter {
  /** 下单（同步触发；pre-trade 拒绝可抛 Error） */
  place(req: OrderReq): void;
  /** 撤单 */
  cancel(clientOrderId: string): void;
  /** 当前持仓（对账用）：每 (sym,prod) 净 base 数量 */
  positions(): Array<{ sym: string; prod: Prod; qty: number }>;
  /** 注册订单回报回调 */
  onUpdate(cb: (u: OrderUpdate) => void): void;
}

export type ExecState =
  | 'FLAT'
  | 'OPENING_MAKER' // 挂 primary maker，等成交
  | 'HEDGING' // primary 已成交，发 hedge IOC
  | 'HOLDING' // 两腿到位，持仓
  | 'CLOSING' // 平仓（镜像 maker→hedge）
  | 'EMERGENCY_UNWIND' // hedge 未全成，市价强平缺口
  | 'ABORTED' // maker 超时未成交，撤单收场
  | 'KILLED'; // kill switch

export interface PositionInstance {
  posId: string;
  strategy: string;
  sym: string;
  primary: Prod;
  hedge: Prod;
  primarySide: Side; // 开仓时 primary 方向
  qty: number; // 目标名义 base
  notionalUsd: number;
  state: ExecState;
  // 分相独立记账（开/平各自累计，避免复用同一字段串味）
  openPrimaryFilled: number;
  openHedgeFilled: number;
  openHedgeInFlight: number; // 已发但未终态的 hedge IOC 量（防对冲在途时误判缺口强平）
  openUnwoundQty: number; // 已强平成交的未对冲缺口
  openUnwindInFlight: number; // 已发但未终态的强平量（防重复强平/卡死）
  closePrimaryDone: number; // 平仓侧 primary 腿已反向量（maker + 降级taker）
  closeHedgeDone: number; // 平仓侧 hedge 腿已反向量（IOC + 缺口taker）
  closeDowngraded: boolean; // CLOSING maker 超时已降级 taker，防重复
  tsOpen: number;
  tsClose: number | null; // 进入 CLOSING 的时刻（超时计时基准）
}
