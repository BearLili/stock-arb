/**
 * 资金费轮询 → 持仓对 net carry（开发文档 §4.2、FR4）。
 *
 * 各所 REST 拉当期资金费率（每结算周期的 fraction），换算日化 bp：
 *   dailyBp(prod,sym) = rateFrac × settlePerDay × 1e4
 *   settlePerDay：8h 所=3，HL=每小时结算=24（优先用交易所返回的周期覆盖 config 缺省）。
 * 对 [a,b]：carry = dailyBp(a) − dailyBp(b)（bp/天）。
 *   正 = a 腿多头付费更高 → 空 a 多 b 收取该 carry；负则相反。
 * 任一腿缺失（拉取失败/非永续）→ carry=null，不参与告警注释。
 */
import { request } from 'undici';
import type { Config } from '../config.js';
import type { Prod } from '../types.js';
import { childLog } from './../log.js';
import { delay } from '../feeds/runner.js';

const lg = childLog('funding');

const PERP_PRODS: Prod[] = ['bnperp', 'gateperp', 'mexcperp', 'hlperp'];

interface RateEntry {
  rateFrac: number;
  settlePerDay: number;
  ts: number;
}

async function getJson(url: string, init?: Parameters<typeof request>[1]): Promise<unknown> {
  const res = await request(url, { headersTimeout: 6000, bodyTimeout: 6000, ...init });
  return res.body.json();
}

export class FundingPoller {
  private readonly rates = new Map<string, RateEntry>(); // key: sym|prod

  constructor(private readonly cfg: Config) {}

  private static key(sym: string, prod: Prod): string {
    return `${sym}|${prod}`;
  }

  /** 日化资金费(bp/天)；无数据返回 null */
  dailyBp(sym: string, prod: Prod): number | null {
    const e = this.rates.get(FundingPoller.key(sym, prod));
    if (!e) return null;
    return e.rateFrac * e.settlePerDay * 1e4;
  }

  /** carry 提供者：a腿−b腿 日化资金费差(bp/天) */
  carry = (sym: string, a: Prod, b: Prod): number | null => {
    const da = this.dailyBp(sym, a);
    const db = this.dailyBp(sym, b);
    if (da === null || db === null) return null;
    return da - db;
  };

  /** 当前全部资金费快照（供报表） */
  snapshot(): Array<{ sym: string; prod: Prod; rateFrac: number; dailyBp: number; settlePerDay: number }> {
    const out: Array<{ sym: string; prod: Prod; rateFrac: number; dailyBp: number; settlePerDay: number }> = [];
    for (const [k, e] of this.rates) {
      const [sym, prod] = k.split('|') as [string, Prod];
      out.push({ sym, prod, rateFrac: e.rateFrac, dailyBp: e.rateFrac * e.settlePerDay * 1e4, settlePerDay: e.settlePerDay });
    }
    return out;
  }

  private async fetchOne(sym: string, prod: Prod, code: string, now: number): Promise<void> {
    try {
      const def = this.cfg.settlePerDay(prod);
      let rateFrac: number | null = null;
      let settlePerDay = def;
      if (prod === 'bnperp') {
        const j = (await getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${code}`)) as {
          lastFundingRate?: string;
        };
        if (j.lastFundingRate !== undefined) rateFrac = Number(j.lastFundingRate);
      } else if (prod === 'gateperp') {
        const j = (await getJson(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${code}`)) as {
          funding_rate?: string;
          funding_interval?: number;
        };
        if (j.funding_rate !== undefined) rateFrac = Number(j.funding_rate);
        if (j.funding_interval && j.funding_interval > 0) settlePerDay = 86400 / j.funding_interval;
      } else if (prod === 'mexcperp') {
        const j = (await getJson(`https://contract.mexc.com/api/v1/contract/funding_rate/${code}`)) as {
          data?: { fundingRate?: number; collectCycle?: number };
        };
        if (j.data?.fundingRate !== undefined) rateFrac = Number(j.data.fundingRate);
        if (j.data?.collectCycle && j.data.collectCycle > 0) settlePerDay = 24 / j.data.collectCycle;
      } else if (prod === 'hlperp') {
        // tradeXYZ dex 资产上下文；universe 名即完整 code（如 "xyz:TSLA"，带前缀）
        const j = (await getJson('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }),
        })) as [{ universe?: Array<{ name?: string }> }, Array<{ funding?: string }>];
        const meta = j[0];
        const ctxs = j[1];
        const idx = meta.universe?.findIndex((u) => u.name === code) ?? -1;
        if (idx >= 0 && ctxs[idx]?.funding !== undefined) {
          rateFrac = Number(ctxs[idx]!.funding); // HL funding 为每小时结算
          settlePerDay = 24;
        }
      }
      if (rateFrac !== null && Number.isFinite(rateFrac)) {
        this.rates.set(FundingPoller.key(sym, prod), { rateFrac, settlePerDay, ts: now });
      }
    } catch (e) {
      lg.debug({ err: (e as Error).message, sym, prod }, '资金费拉取失败');
    }
  }

  /** 拉一轮全部永续腿 */
  async pollOnce(now: number): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const prod of PERP_PRODS) {
      for (const { sym, code } of this.cfg.entriesForProd(prod)) {
        tasks.push(this.fetchOne(sym, prod, code, now));
      }
    }
    await Promise.allSettled(tasks);
  }

  /** 后台轮询循环，直到 signal abort */
  async run(signal: AbortSignal, now: () => number = Date.now): Promise<void> {
    const intervalMs = this.cfg.fundingPoll.interval_sec * 1000;
    lg.info({ intervalSec: this.cfg.fundingPoll.interval_sec }, '资金费轮询启动');
    while (!signal.aborted) {
      await this.pollOnce(now());
      const n = this.rates.size;
      lg.info({ legs: n }, '资金费已更新');
      await delay(intervalMs, signal);
    }
  }
}
