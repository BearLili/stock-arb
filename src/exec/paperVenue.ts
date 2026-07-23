/**
 * 纸面场所适配器：executor 对接它跑通全状态机 + 自动化测试。
 * 订单不自动成交——由驱动方(测试/纸面回放)调用 resolve() 决定成交结果，
 * 从而确定性地驱动 executor 走每条路径(maker成交/超时/hedge IOC成交/hedge部分→强平)。
 * 维护净持仓供对账。
 */
import type { OrderReq, OrderStatus, OrderUpdate, VenueAdapter, Prod } from './types.js';

interface Live {
  req: OrderReq;
  filled: number;
  avgPrice: number | null;
  status: OrderStatus;
}

export class PaperVenueAdapter implements VenueAdapter {
  private readonly orders = new Map<string, Live>();
  private readonly pos = new Map<string, number>(); // sym|prod → 净 base
  private cb: ((u: OrderUpdate) => void) | null = null;
  readonly placed: OrderReq[] = []; // 供测试断言
  readonly canceled: string[] = [];

  onUpdate(cb: (u: OrderUpdate) => void): void {
    this.cb = cb;
  }

  place(req: OrderReq): void {
    if (!(req.qty > 0)) throw new Error(`拒单：qty 非正 ${req.clientOrderId}`);
    if (this.orders.has(req.clientOrderId)) throw new Error(`拒单：clientOrderId 重复 ${req.clientOrderId}`);
    this.orders.set(req.clientOrderId, { req, filled: 0, avgPrice: null, status: 'open' });
    this.placed.push(req);
  }

  cancel(clientOrderId: string): void {
    this.canceled.push(clientOrderId);
    const o = this.orders.get(clientOrderId);
    if (o && (o.status === 'open' || o.status === 'partial')) {
      o.status = 'canceled';
      this.emit(o);
    }
  }

  positions(): Array<{ sym: string; prod: Prod; qty: number }> {
    const out: Array<{ sym: string; prod: Prod; qty: number }> = [];
    for (const [k, qty] of this.pos) {
      if (Math.abs(qty) < 1e-12) continue;
      const [sym, prod] = k.split('|') as [string, Prod];
      out.push({ sym, prod, qty });
    }
    return out;
  }

  /**
   * 驱动方决定某订单成交：fillQty 累计到该值，status 为终态或 partial。
   * 更新净持仓（买+卖−），回报给 executor。
   */
  resolve(clientOrderId: string, fillQty: number, avgPrice: number, status: OrderStatus): void {
    const o = this.orders.get(clientOrderId);
    if (!o) throw new Error(`resolve 未知订单 ${clientOrderId}`);
    const delta = fillQty - o.filled;
    if (delta > 0) {
      const key = `${o.req.sym}|${o.req.prod}`;
      const signed = o.req.side === 'buy' ? delta : -delta;
      this.pos.set(key, (this.pos.get(key) ?? 0) + signed);
    }
    o.filled = fillQty;
    if (fillQty > 0) o.avgPrice = avgPrice;
    o.status = status;
    this.emit(o);
  }

  private emit(o: Live): void {
    this.cb?.({ clientOrderId: o.req.clientOrderId, status: o.status, filledQty: o.filled, avgPrice: o.avgPrice });
  }
}
