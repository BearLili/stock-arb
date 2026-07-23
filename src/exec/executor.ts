/**
 * Executor 状态机（venue-agnostic）。第一公民路径 = maker 挂单 → 即时 taker(IOC) 对冲。
 * 路径：FLAT→OPENING_MAKER→HEDGING→HOLDING→CLOSING→FLAT；
 *   maker 超时未成 → ABORTED；hedge IOC 未全成(缺口) → EMERGENCY_UNWIND(市价强平缺口)；
 *   kill() → 撤所有单 + 按交易所净持仓市价平所有仓(含孤儿) → KILLED。
 * hedge 用 IOC（要么即时成、要么即时取消）——无挂单、无迟到成交竞态。
 *
 * 记账原则（两轮审计后定稿）：
 *  - 每张订单按 clientOrderId 记"上次累计成交"，回报取增量；orderIdx 带 qty 供在途统计。
 *  - 开/平两相各自独立累计；平仓两腿对称收尾（primary/hedge 各自反向到 qty 才 FLAT）。
 *  - 强平缺口计"在途 unwind"，同一缺口不重复强平；覆盖完成且无在途强平才进 HOLDING。
 *  - 所有订单 id 用单调自增 orderSeq；实例终态清理其名下 order 记录（防长跑泄漏）。
 */
import type { Config } from '../config.js';
import type { RiskGates } from './riskGates.js';
import type { ExecEventLog } from './store.js';
import type { OrderUpdate, PositionInstance, Side, VenueAdapter, Prod } from './types.js';

export interface OpenIntent {
  strategy: string;
  sym: string;
  primary: Prod;
  hedge: Prod;
  primarySide: Side;
  qty: number;
  notionalUsd: number;
  primaryPrice: number;
}

type OrderKind =
  | 'primaryOpen' | 'hedgeOpen' | 'unwind'
  | 'primaryClose' | 'hedgeClose' | 'primaryCloseFlatten' | 'hedgeCloseFlatten'
  | 'killFlatten';

const EPS = 1e-9;

export class Executor {
  private readonly pos = new Map<string, PositionInstance>();
  private readonly orderIdx = new Map<string, { posId: string; kind: OrderKind; qty: number }>();
  private readonly orderFilled = new Map<string, number>();
  private posSeq = 0;
  private orderSeq = 0;

  constructor(
    private readonly adapter: VenueAdapter,
    private readonly gates: RiskGates,
    private readonly cfg: Config,
    private readonly log: ExecEventLog,
    private readonly now: () => number = Date.now,
  ) {
    adapter.onUpdate((u) => this.onUpdate(u));
  }

  positionsView(): PositionInstance[] {
    return [...this.pos.values()];
  }
  private other(s: Side): Side {
    return s === 'buy' ? 'sell' : 'buy';
  }
  private transition(p: PositionInstance, to: PositionInstance['state'], note = ''): void {
    this.log.transition(p.posId, p.state, to, this.now(), note);
    p.state = to;
  }
  private inc(u: OrderUpdate): number {
    const prev = this.orderFilled.get(u.clientOrderId) ?? 0;
    this.orderFilled.set(u.clientOrderId, u.filledQty);
    return u.filledQty > prev ? u.filledQty - prev : 0;
  }
  private place(posId: string, kind: OrderKind, req: { sym: string; prod: Prod; side: Side; type: 'maker' | 'ioc'; qty: number; price?: number; role: 'primary' | 'hedge' }, fixedId?: string): void {
    if (!(req.qty > EPS)) return;
    const id = fixedId ?? `${posId}-${kind}-${(this.orderSeq += 1)}`;
    this.orderIdx.set(id, { posId, kind, qty: req.qty });
    this.adapter.place({ clientOrderId: id, ...req });
  }
  private cleanup(posId: string): void {
    for (const [id, v] of this.orderIdx) if (v.posId === posId) { this.orderIdx.delete(id); this.orderFilled.delete(id); }
  }

  private refreshExposure(): void {
    const byStrat = new Map<string, number>();
    let total = 0;
    for (const p of this.pos.values()) {
      if (p.state === 'HOLDING' || p.state === 'CLOSING' || p.state === 'HEDGING' || p.state === 'EMERGENCY_UNWIND') {
        byStrat.set(p.strategy, (byStrat.get(p.strategy) ?? 0) + p.notionalUsd);
        total += p.notionalUsd;
      }
    }
    for (const [s, v] of byStrat) this.gates.setExposure(s, v);
    this.gates.setTotalExposure(total);
  }

  openPosition(intent: OpenIntent): { ok: boolean; posId?: string; reason?: string } {
    const nowMs = this.now();
    const gate = this.gates.checkOpen({ strategy: intent.strategy, sym: intent.sym, primary: intent.primary, hedge: intent.hedge, notionalUsd: intent.notionalUsd, nowMs });
    if (!gate.ok) {
      this.log.rejected(intent.strategy, intent.sym, gate.reason ?? 'gate', nowMs);
      return { ok: false, reason: gate.reason };
    }
    this.posSeq += 1;
    const posId = `${intent.strategy}-${intent.sym}-${this.posSeq}`;
    const p: PositionInstance = {
      posId, strategy: intent.strategy, sym: intent.sym, primary: intent.primary, hedge: intent.hedge,
      primarySide: intent.primarySide, qty: intent.qty, notionalUsd: intent.notionalUsd, state: 'OPENING_MAKER',
      openPrimaryFilled: 0, openHedgeFilled: 0, openHedgeInFlight: 0, openUnwoundQty: 0, openUnwindInFlight: 0,
      closePrimaryDone: 0, closeHedgeDone: 0, closeDowngraded: false, tsOpen: nowMs, tsClose: null,
    };
    this.pos.set(posId, p);
    this.log.transition(posId, 'FLAT', 'OPENING_MAKER', nowMs, `qty=${intent.qty}`);
    this.place(posId, 'primaryOpen', { sym: p.sym, prod: p.primary, side: p.primarySide, type: 'maker', qty: p.qty, price: intent.primaryPrice, role: 'primary' }, `${posId}-P-open`);
    return { ok: true, posId };
  }

  onUpdate(u: OrderUpdate): void {
    const idx = this.orderIdx.get(u.clientOrderId);
    if (!idx) return;
    const p = this.pos.get(idx.posId);
    if (!p) return;
    const inc = this.inc(u);
    const terminal = u.status === 'filled' || u.status === 'canceled' || u.status === 'rejected';

    switch (idx.kind) {
      case 'primaryOpen':
        if (inc > 0) {
          p.openPrimaryFilled += inc;
          if (p.state === 'OPENING_MAKER') this.transition(p, 'HEDGING', `primary成交${p.openPrimaryFilled}`);
          p.openHedgeInFlight += inc; // 对冲在途，settleOpen 不会误判缺口
          this.place(p.posId, 'hedgeOpen', { sym: p.sym, prod: p.hedge, side: this.other(p.primarySide), type: 'ioc', qty: inc, role: 'hedge' });
        }
        this.settleOpen(p);
        break;
      case 'hedgeOpen':
        if (inc > 0) p.openHedgeFilled += inc;
        if (terminal) {
          p.openHedgeInFlight = Math.max(0, p.openHedgeInFlight - idx.qty);
          this.settleOpen(p);
        }
        break;
      case 'unwind':
        if (terminal) p.openUnwindInFlight = Math.max(0, p.openUnwindInFlight - idx.qty);
        if (inc > 0) p.openUnwoundQty += inc;
        this.settleOpen(p);
        break;
      case 'primaryClose':
      case 'primaryCloseFlatten':
        if (inc > 0) {
          p.closePrimaryDone += inc;
          this.place(p.posId, 'hedgeClose', { sym: p.sym, prod: p.hedge, side: this.other(this.other(p.primarySide)), type: 'ioc', qty: inc, role: 'hedge' });
        }
        this.settleClose(p);
        break;
      case 'hedgeClose':
        if (inc > 0) p.closeHedgeDone += inc;
        if (terminal) {
          const gap = p.closePrimaryDone - p.closeHedgeDone;
          if (gap > EPS) this.place(p.posId, 'hedgeCloseFlatten', { sym: p.sym, prod: p.hedge, side: p.primarySide, type: 'ioc', qty: gap, role: 'hedge' });
        }
        this.settleClose(p);
        break;
      case 'hedgeCloseFlatten':
        if (inc > 0) p.closeHedgeDone += inc;
        this.settleClose(p);
        break;
      case 'killFlatten':
        break;
    }
  }

  /** 开仓侧收敛：primary 全成 && 缺口已覆盖(对冲+已强平) && 无在途强平 → HOLDING */
  private settleOpen(p: PositionInstance): void {
    if (p.state !== 'HEDGING' && p.state !== 'EMERGENCY_UNWIND') return;
    // 未覆盖缺口 = primary成交 − 已对冲 − 已强平 − 对冲在途 − 强平在途；只有确实无在途覆盖才强平
    const gap = p.openPrimaryFilled - p.openHedgeFilled - p.openUnwoundQty - p.openHedgeInFlight - p.openUnwindInFlight;
    if (gap > EPS) {
      this.emergencyUnwind(p, gap);
      return;
    }
    const primaryDone = p.openPrimaryFilled >= p.qty - EPS;
    if (primaryDone && p.openHedgeInFlight <= EPS && p.openUnwindInFlight <= EPS && p.openHedgeFilled + p.openUnwoundQty >= p.openPrimaryFilled - EPS) {
      p.qty = p.openHedgeFilled; // 有效持仓 = 已对冲量（强平掉的不算持仓）
      this.transition(p, 'HOLDING', `持仓${p.openHedgeFilled}`);
      this.refreshExposure();
    }
  }

  private emergencyUnwind(p: PositionInstance, gap: number): void {
    if (p.state !== 'EMERGENCY_UNWIND') this.transition(p, 'EMERGENCY_UNWIND', `hedge 缺口 ${gap}，市价强平`);
    p.openUnwindInFlight += gap;
    this.place(p.posId, 'unwind', { sym: p.sym, prod: p.primary, side: this.other(p.primarySide), type: 'ioc', qty: gap, role: 'hedge' });
    const r = this.gates.recordEmergencyUnwind(p.strategy, this.now());
    this.log.emergencyUnwind(p.posId, p.strategy, gap, r.count, r.paused, this.now());
    this.refreshExposure();
  }

  /** 平仓侧收敛：两腿都反向到 qty → FLAT */
  private settleClose(p: PositionInstance): void {
    if (p.state !== 'CLOSING') return;
    if (p.closePrimaryDone >= p.qty - EPS && p.closeHedgeDone >= p.qty - EPS) {
      this.transition(p, 'FLAT', '平仓完成(两腿净零)');
      this.cleanup(p.posId);
      this.pos.delete(p.posId);
      this.refreshExposure();
    }
  }

  closePosition(posId: string, primaryPrice: number): void {
    const p = this.pos.get(posId);
    if (!p || p.state !== 'HOLDING') return;
    p.tsClose = this.now();
    this.transition(p, 'CLOSING', '发起平仓');
    this.place(posId, 'primaryClose', { sym: p.sym, prod: p.primary, side: this.other(p.primarySide), type: 'maker', qty: p.qty, price: primaryPrice, role: 'primary' }, `${posId}-P-close`);
  }

  tick(): void {
    const now = this.now();
    const to = this.cfg.paper.maker_timeout_ms;
    for (const p of [...this.pos.values()]) {
      if ((p.state === 'OPENING_MAKER' || p.state === 'HEDGING') && now - p.tsOpen > to) {
        if (p.openPrimaryFilled < EPS) {
          this.adapter.cancel(`${p.posId}-P-open`);
          this.transition(p, 'ABORTED', 'maker 超时未成交，撤单');
          this.cleanup(p.posId);
          this.pos.delete(p.posId);
        } else if (p.openPrimaryFilled < p.qty - EPS) {
          this.adapter.cancel(`${p.posId}-P-open`);
          p.qty = p.openPrimaryFilled; // 目标缩到已成量，settleOpen 据此收敛
          this.settleOpen(p);
        }
      }
      // CLOSING maker 超时 → 降级 taker 平剩余 primary（只降级一次；hedge 由 flatten 成交触发）
      if (p.state === 'CLOSING' && !p.closeDowngraded && p.tsClose !== null && now - p.tsClose > to) {
        this.adapter.cancel(`${p.posId}-P-close`);
        p.closeDowngraded = true;
        const remaining = p.qty - p.closePrimaryDone;
        this.place(p.posId, 'primaryCloseFlatten', { sym: p.sym, prod: p.primary, side: this.other(p.primarySide), type: 'ioc', qty: remaining, role: 'primary' });
      }
    }
  }

  kill(): void {
    const now = this.now();
    this.gates.setKilled(true);
    for (const [id] of this.orderIdx) this.adapter.cancel(id);
    for (const pos of this.adapter.positions()) {
      const owner = [...this.pos.values()].find((x) => x.sym === pos.sym && (x.primary === pos.prod || x.hedge === pos.prod));
      const posId = owner?.posId ?? `KILL-${pos.sym}-${pos.prod}`;
      this.place(posId, 'killFlatten', { sym: pos.sym, prod: pos.prod, side: pos.qty > 0 ? 'sell' : 'buy', type: 'ioc', qty: Math.abs(pos.qty), role: 'hedge' });
    }
    for (const p of this.pos.values()) if (p.state !== 'ABORTED') this.transition(p, 'KILLED', 'kill switch');
    this.refreshExposure();
    this.log.kill(now);
  }
}
