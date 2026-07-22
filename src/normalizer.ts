/**
 * 归一化状态机：feeds 上报的原始盘口 → 统一 (sym,prod) BBO → 事件总线。
 *
 * M0 职责（保真、不去噪）：
 *  - 校验 bid>0 / ask>0（与 ws_monitor 一致）；无效丢弃并计入 health。
 *  - 双时间戳：交易所事件时间 tsExch（可能为 null）+ 本地接收 tsRecv（Date.now）。
 *  - 维护每 (sym,prod) 最新盘口，供 engine 读取（stale 判定在 engine 侧，落盘要全量）。
 *  - 每条有效 tick 原样广播到 bus，recorder 全量落盘。
 * 尖刺去噪/陈旧丢弃是 engine（M1）的职责，不在此处，以免污染落盘的原始数据。
 */
import type { Bus } from './bus.js';
import type { Health } from './health.js';
import type { BboState, Prod } from './types.js';

export class Normalizer {
  private readonly states = new Map<string, BboState>();

  constructor(
    private readonly bus: Bus,
    private readonly health: Health,
    private readonly now: () => number = Date.now,
  ) {}

  private static key(sym: string, prod: Prod): string {
    return `${sym}|${prod}`;
  }

  /**
   * 接受一条原始盘口。feedName 用于 health 归属。
   * tsExch 为交易所事件时间（ms），feed 无法提供时传 null。
   */
  accept(
    feedName: string,
    sym: string,
    prod: Prod,
    bid: number,
    ask: number,
    tsExch: number | null,
  ): void {
    const tsRecv = this.now();
    // 有限且为正：同时挡住 NaN、±Infinity（保证 JSONL 始终合法，审计 L8）
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
      this.health.onReject(feedName);
      return;
    }
    const skewMs = tsExch !== null ? tsRecv - tsExch : null;
    this.states.set(Normalizer.key(sym, prod), { bid, ask, tsExch, tsRecv });
    this.health.onAccept(feedName, tsRecv, skewMs);
    this.bus.emitBbo({ sym, prod, bid, ask, tsExch, tsRecv });
  }

  getState(sym: string, prod: Prod): BboState | undefined {
    return this.states.get(Normalizer.key(sym, prod));
  }
}
