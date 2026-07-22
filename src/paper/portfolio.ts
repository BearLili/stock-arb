/**
 * 纸面账本：给定 TradeSignal 序列（决策与口径无关）+ 某成交口径(mode)，
 * 模拟成交、配对开/平、算 4 项归因 PnL、统计 maker 成交率。
 */
import type { Config } from '../config.js';
import type { Replay } from './replay.js';
import type { FillMode, FilledLeg, Trade, TradeSignal, PnlBreakdown } from './types.js';
import { simulateFill } from './fill.js';

/** 资金费 carry 提供者：某 (sym,prod) 日化资金费(bp)；无则 null → carry 记 0 */
export type CarryFn = (sym: string, prod: string) => number | null;

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

  const fillLegs = (sig: TradeSignal): FilledLeg[] =>
    sig.legs.map((leg) => {
      const fl = simulateFill(replay, cfg, sig.sym, leg, sig.ts, mode);
      if (leg.type === 'maker') {
        makerAttempted += 1;
        if (fl.filled) makerFilled += 1;
      }
      return fl;
    });

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
      const holdDays = holdMin / 1440;
      for (const openLeg of oc.legs) {
        const closeLeg = closeLegs.find((c) => c.prod === openLeg.prod);
        if (!closeLeg) continue;
        const dir = openLeg.side === 'buy' ? 1 : -1;
        const openMid = openLeg.midAtFill!;
        const closeMid = closeLeg.midAtFill!;
        if (!(openMid > 0)) continue; // 防脏数据除零
        pnl.priceBp += ((closeMid - openMid) / openMid) * 1e4 * dir;
        pnl.slipBp += slipBp(openLeg) + slipBp(closeLeg);
        pnl.feeBp += openLeg.feeBp + closeLeg.feeBp;
        // 持仓资金费：多头付、空头收 → carry_leg = −dir × dailyBp × holdDays
        const daily = carry(oc.sig.sym, openLeg.prod);
        if (daily !== null) pnl.carryBp += -dir * daily * holdDays;
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
