/**
 * 资金费历史（回放 carry 用）。源 = data/minute_data_v3.json 的 per-sym funding：
 *   { bn:[[ts_sec, rate_%/settle],...], gate:.., mexc:.., hl:.. }
 * 单位已核对：**% 每结算**（bn/gate/mexc 每8h，hl 每小时）；SNDK bn 均值×3=0.0729%/日，
 * 与 PRD §3.2 逐所日化%精确吻合。bp/settle = rate_% × 100。
 *
 * carry 口径：持仓 (tsOpen,tsClose] 内（左开右闭，开仓当刻结算不计），每个**永续腿**在其每个结算点：
 *   多头付、空头收 → 贡献 = −dir × (rate_% × 100) bp。现货腿无资金费 → 0。
 */
import { readFileSync } from 'node:fs';
import type { Prod } from '../types.js';

type Venue = 'bn' | 'gate' | 'mexc' | 'hl';

const PROD_VENUE: Partial<Record<Prod, Venue>> = {
  bnperp: 'bn',
  gateperp: 'gate',
  mexcperp: 'mexc',
  hlperp: 'hl',
};

export class FundingHistory {
  private readonly series = new Map<string, Array<[number, number]>>(); // key sym|venue → [[ts_ms, rate_%],...] 升序

  static fromMinuteData(path = 'data/minute_data_v3.json'): FundingHistory {
    const fh = new FundingHistory();
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { funding?: Record<string, Array<[number, number]>> }>;
    for (const [sym, s] of Object.entries(data)) {
      const f = s.funding;
      if (!f) continue;
      for (const [venue, arr] of Object.entries(f)) {
        const norm = arr
          .map(([ts, r]) => [ts * 1000, r] as [number, number]) // 秒→毫秒
          .sort((a, b) => a[0] - b[0]);
        fh.series.set(`${sym}|${venue}`, norm);
      }
    }
    return fh;
  }

  /** 是否有该 sym 的资金费数据（用于报告标注 carry 是否可算） */
  hasSym(sym: string): boolean {
    return [...this.series.keys()].some((k) => k.startsWith(`${sym}|`));
  }

  /**
   * 某腿在 [tsOpenMs, tsCloseMs] 持仓期的 carry(bp)。
   * dir: +1 多 / −1 空。现货腿(无 venue 映射)返回 0。
   */
  legCarryBp(sym: string, prod: Prod, dir: 1 | -1, tsOpenMs: number, tsCloseMs: number): number {
    const venue = PROD_VENUE[prod];
    if (!venue) return 0; // 现货腿无资金费
    const arr = this.series.get(`${sym}|${venue}`);
    if (!arr) return 0;
    let carry = 0;
    for (const [tsMs, ratePct] of arr) {
      if (tsMs > tsOpenMs && tsMs <= tsCloseMs) {
        carry += -dir * (ratePct * 100); // %→bp；多付空收
      }
    }
    return carry;
  }

  /** 某 (sym,prod) 的日化资金费(bp/天)，供报告展示（用全窗口均值×settle/day 估计） */
  dailyBp(sym: string, prod: Prod): number | null {
    const venue = PROD_VENUE[prod];
    if (!venue) return null;
    const arr = this.series.get(`${sym}|${venue}`);
    if (!arr || arr.length < 2) return null;
    const meanPct = arr.reduce((s, [, r]) => s + r, 0) / arr.length;
    const settlePerDay = venue === 'hl' ? 24 : 3;
    return meanPct * 100 * settlePerDay;
  }

  /**
   * 时点日化资金费(bp/天)：取 ≤tsMs 的最近一次结算率年化（S3 决策用）。
   * tsMs 早于首次结算则用首个。无数据返回 null。
   */
  dailyBpAt(sym: string, prod: Prod, tsMs: number): number | null {
    const venue = PROD_VENUE[prod];
    if (!venue) return null;
    const arr = this.series.get(`${sym}|${venue}`);
    if (!arr || arr.length === 0) return null;
    let ratePct = arr[0]![1];
    for (const [tMs, r] of arr) {
      if (tMs <= tsMs) ratePct = r;
      else break;
    }
    const settlePerDay = venue === 'hl' ? 24 : 3;
    return ratePct * 100 * settlePerDay;
  }
}
