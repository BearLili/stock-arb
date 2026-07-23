/**
 * 纸面账本：给定 TradeSignal 序列（决策与口径无关）+ 某成交口径(mode)，
 * 模拟成交、配对开/平、算 4 项归因 PnL、统计 maker 成交率。
 */
import type { Config } from '../config.js';
import type { Prod } from '../types.js';
import type { Replay } from './replay.js';
import type { FillMode, FilledLeg, Trade, TradeSignal, PnlBreakdown } from './types.js';
import { simulateFill } from './fill.js';

/**
 * 资金费 carry 提供者：返回某腿在 [tsOpen,tsClose] 持仓期的 carry(bp)。
 * dir:+1多/−1空；内部按离散结算累计、已含多付空收符号；现货腿返回 0。
 */
export type CarryFn = (sym: string, prod: Prod, dir: 1 | -1, tsOpenMs: number, tsCloseMs: number) => number;

interface OpenCtx {
  sig: TradeSignal;
  legs: FilledLeg[];
}

export interface BookResult {
  mode: FillMode;
  trades: Trade[];
  makerAttempted: number;
  makerFilled: number;
}

/**
 * 相对成交时刻中间价的不利偏移(bp)，正=成本。
 * taker：≈ 半点差 + 1bp 滑点项。
 * maker：以挂价成交、基准取成交时刻 mid → 度量的是**逆向选择成本**（挂单被打穿时
 *        市场已对你不利），非"挂价改善"；与 priceBp 共用同一 fill-time mid，故总 PnL 自洽。
 */
function slipBp(fl: FilledLeg): number {
  if (fl.fillPrice === null || fl.midAtFill === null || !(fl.midAtFill > 0)) return 0;
  const adv = fl.side === 'buy' ? fl.fillPrice - fl.midAtFill : fl.midAtFill - fl.fillPrice;
  return (adv / fl.midAtFill) * 1e4;
}

export function runBook(
  signals: TradeSignal[],
  replay: Replay,
  cfg: Config,
  mode: FillMode,
  carry: CarryFn,
): BookResult {
  const open = new Map<string, OpenCtx>();
  const trades: Trade[] = [];
  let makerAttempted = 0;
  let makerFilled = 0;

  const unfilled = (leg: TradeSignal['legs'][number], ts: number): FilledLeg => ({
    prod: leg.prod, side: leg.side, type: leg.type, filled: false, tsDecision: ts, tsFill: null, fillPrice: null, midAtFill: null, feeBp: 0,
  });

  const fillLegs = (sig: TradeSignal): FilledLeg[] => {
    let filled: FilledLeg[];
    const hedgeIdx = sig.legs.findIndex((l) => l.role === 'hedge');
    const pIdx = sig.legs.findIndex((l) => l.role === 'primary');
    if (hedgeIdx < 0 || pIdx < 0) {
      // v1：两腿独立成交（或畸形信号缺 primary/hedge → 退化为独立，防越界）
      filled = sig.legs.map((leg) => simulateFill(replay, cfg, sig.sym, leg, sig.ts, mode));
    } else {
      // v2 应急对冲：先 primary(maker)，成交后 hedge(taker) 于 primary 成交时刻下单；primary 不成交则不建腿
      filled = new Array<FilledLeg>(sig.legs.length);
      const prim = simulateFill(replay, cfg, sig.sym, sig.legs[pIdx]!, sig.ts, mode);
      filled[pIdx] = prim;
      filled[hedgeIdx] =
        prim.filled && prim.tsFill !== null
          ? simulateFill(replay, cfg, sig.sym, sig.legs[hedgeIdx]!, prim.tsFill, mode)
          : unfilled(sig.legs[hedgeIdx]!, sig.ts);
    }
    // maker 腿计数
    for (let i = 0; i < sig.legs.length; i += 1) {
      if (sig.legs[i]!.type === 'maker') {
        makerAttempted += 1;
        if (filled[i]!.filled) makerFilled += 1;
      }
    }
    return filled;
  };

  for (const sig of signals) {
    if (sig.action === 'open') {
      open.set(sig.posId, { sig, legs: fillLegs(sig) });
      continue;
    }
    // close
    const oc = open.get(sig.posId);
    open.delete(sig.posId);
    const closeLegs = fillLegs(sig);
    if (!oc) continue; // 无对应开仓（异常），跳过

    const holdMin = (sig.ts - oc.sig.ts) / 60000;
    const filledOk = oc.legs.every((l) => l.filled) && closeLegs.every((l) => l.filled);

    let pnl: PnlBreakdown = { priceBp: 0, feeBp: 0, slipBp: 0, carryBp: 0, totalBp: 0 };
    let note = '';
    if (filledOk) {
      for (const openLeg of oc.legs) {
        const closeLeg = closeLegs.find((c) => c.prod === openLeg.prod);
        if (!closeLeg) continue;
        const dir: 1 | -1 = openLeg.side === 'buy' ? 1 : -1;
        const openMid = openLeg.midAtFill!;
        const closeMid = closeLeg.midAtFill!;
        if (!(openMid > 0)) continue; // 防脏数据除零
        pnl.priceBp += ((closeMid - openMid) / openMid) * 1e4 * dir;
        pnl.slipBp += slipBp(openLeg) + slipBp(closeLeg);
        pnl.feeBp += openLeg.feeBp + closeLeg.feeBp;
        // 持仓资金费：按持仓期内离散结算累计（多付空收符号已在 carry 内处理）
        pnl.carryBp += carry(oc.sig.sym, openLeg.prod, dir, oc.sig.ts, sig.ts);
      }
      pnl.totalBp = pnl.priceBp - pnl.slipBp - pnl.feeBp + pnl.carryBp;
    } else {
      note = '腿未全成交(maker未穿越/无到达报价)';
    }

    trades.push({
      posId: sig.posId,
      strategy: sig.strategy,
      sym: sig.sym,
      pair: sig.pair,
      tsOpen: oc.sig.ts,
      tsClose: sig.ts,
      holdMin,
      openLegs: oc.legs,
      closeLegs,
      pnl,
      filledOk,
      note,
    });
  }

  return { mode, trades, makerAttempted, makerFilled };
}
