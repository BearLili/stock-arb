/**
 * 单腿成交模拟（开发文档 §4.3 + 用户裁决的权威口径）。
 *
 * naive（未校正）：按决策时刻 t 观测到的（可能陈）报价立即成交。
 * corrected（校正后）：订单 t+rtt 到达，按录制流中第一条 event-time ≥ t+rtt 的真实报价成交。
 * taker：吃对侧 bbo + 1bp 滑点。 maker：挂同侧 bbo 价 P，等对侧穿越 P 成交（价=P）。
 */
import type { Config } from '../config.js';
import type { Replay } from './replay.js';
import type { FilledLeg, FillMode, Leg } from './types.js';

export function simulateFill(replay: Replay, cfg: Config, sym: string, leg: Leg, tDecision: number, mode: FillMode): FilledLeg {
  const { prod, side, type } = leg;
  const rtt = cfg.rttMs(prod);
  const arrival = mode === 'corrected' ? tDecision + rtt : tDecision;

  const base: FilledLeg = {
    prod, side, type, filled: false, tsDecision: tDecision, tsFill: null, fillPrice: null, midAtFill: null, feeBp: 0,
  };

  if (type === 'taker') {
    const q = mode === 'corrected' ? replay.fillQuote(sym, prod, arrival) : replay.quoteAt(sym, prod, tDecision);
    if (!q) return base;
    const mid = (q.bid + q.ask) / 2;
    const raw = side === 'buy' ? q.ask : q.bid;
    const slip = cfg.paper.taker_slippage_bp / 1e4;
    const fillPrice = side === 'buy' ? raw * (1 + slip) : raw * (1 - slip);
    return {
      ...base,
      filled: true,
      tsFill: mode === 'corrected' ? (q.tsExch ?? q.tsRecv) : tDecision,
      fillPrice,
      midAtFill: mid,
      feeBp: cfg.takerFeeBp(prod),
    };
  }

  // maker：挂决策时看到的同侧 bbo 价 P
  const seen = replay.quoteAt(sym, prod, tDecision);
  if (!seen) return base;
  const postPrice = side === 'buy' ? seen.bid : seen.ask;
  const cross = replay.firstCross(sym, prod, arrival, side, postPrice, cfg.paper.maker_timeout_ms);
  if (!cross) {
    // 未成交（挂单超时撤单）
    return { ...base, tsFill: null };
  }
  const mid = (cross.bid + cross.ask) / 2;
  return {
    ...base,
    filled: true,
    tsFill: cross.tsExch ?? cross.tsRecv,
    fillPrice: postPrice, // maker 以挂价成交
    midAtFill: mid,
    feeBp: cfg.makerFeeBp(prod),
  };
}
