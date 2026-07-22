/** Binance 现货 bStocks 与股票永续 fapi —— bookTicker（组合流）。 */
import type { FeedContext, FeedDef } from './runner.js';
import { runSocket } from './runner.js';

/** Binance 股票永续（bnperp）：fapi bookTicker 带事件时间 E/T */
export function bnFut(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('bnperp');
  const rev = new Map(entries.map((e) => [e.code, e.sym]));
  return {
    name: 'BN-FUT',
    prods: ['bnperp'],
    active: entries.length > 0,
    connect: () => {
      const streams = entries.map((e) => `${e.code.toLowerCase()}@bookTicker`).join('/');
      const url = `wss://fstream.binance.com/stream?streams=${streams}`;
      // M2 预留：if (ctx.enableTrades) 追加 <code>@aggTrade 流，用于 maker 成交率标定
      return runSocket(ctx, 'BN-FUT', url, undefined, (text) => {
        const msg = JSON.parse(text) as { data?: BnBookTicker };
        const d = msg.data;
        if (!d || !d.s) return;
        const sym = rev.get(d.s);
        if (!sym) return;
        const tsExch = numOrNull(d.E) ?? numOrNull(d.T);
        ctx.norm.accept('BN-FUT', sym, 'bnperp', Number(d.b), Number(d.a), tsExch);
      });
    },
  };
}

/** Binance 现货 bStocks（bstocks）：spot bookTicker 无事件时间 → tsExch=null */
export function bnSpot(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('bstocks');
  const rev = new Map(entries.map((e) => [e.code, e.sym]));
  return {
    name: 'BN-SPOT',
    prods: ['bstocks'],
    active: entries.length > 0,
    connect: () => {
      const streams = entries.map((e) => `${e.code.toLowerCase()}@bookTicker`).join('/');
      const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
      return runSocket(ctx, 'BN-SPOT', url, undefined, (text) => {
        const msg = JSON.parse(text) as { data?: BnBookTicker };
        const d = msg.data;
        if (!d || !d.s) return;
        const sym = rev.get(d.s);
        if (!sym) return;
        // 现货 bookTicker 无 E/T
        ctx.norm.accept('BN-SPOT', sym, 'bstocks', Number(d.b), Number(d.a), null);
      });
    },
  };
}

interface BnBookTicker {
  s?: string;
  b?: string;
  a?: string;
  E?: number;
  T?: number;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
