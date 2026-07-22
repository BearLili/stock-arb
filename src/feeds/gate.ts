/** Gate 股票永续 gStocks 与现货 gStocks/xStocks —— book_ticker（result.t 为 ms 事件时间）。 */
import type { Prod } from '../types.js';
import type { FeedContext, FeedDef } from './runner.js';
import { runSocket, heartbeat } from './runner.js';

interface GateMsg {
  channel?: string;
  event?: string;
  result?: { t?: number; s?: string; b?: string; a?: string };
}

function subMsg(channel: string, payload: string[]): string {
  // Gate 要求秒级 time 字段
  return JSON.stringify({ time: Math.floor(Date.now() / 1000), channel, event: 'subscribe', payload });
}

/** Gate 股票永续（gateperp）。混合命名（TSLAX_USDT/MU_USDT）已由 config 映射解决。 */
export function gateFut(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('gateperp');
  const rev = new Map(entries.map((e) => [e.code, e.sym]));
  return {
    name: 'GATE-FUT',
    prods: ['gateperp'],
    active: entries.length > 0,
    connect: () => {
      const url = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
      return runSocket(
        ctx,
        'GATE-FUT',
        url,
        (ws, connSignal) => {
          ws.send(subMsg('futures.book_ticker', entries.map((e) => e.code)));
          // keepalive（超出 ws_monitor 规格，为 24h 稳定）
          heartbeat(connSignal, 15000, () =>
            ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' })),
          );
          // M2 预留：if (ctx.enableTrades) 订阅 futures.trades
        },
        (text) => {
          const d = JSON.parse(text) as GateMsg;
          const r = d.result;
          if (d.channel !== 'futures.book_ticker' || !r || !r.s) return;
          const sym = rev.get(r.s);
          if (!sym || r.b === undefined || r.a === undefined) return;
          ctx.norm.accept('GATE-FUT', sym, 'gateperp', Number(r.b), Number(r.a), r.t ?? null);
        },
      );
    },
  };
}

/** Gate 现货 gStocks + xStocks（gstocks/xstocks），同一连接。 */
export function gateSpot(ctx: FeedContext): FeedDef {
  const entries: Array<{ sym: string; code: string; prod: Prod }> = [];
  for (const prod of ['gstocks', 'xstocks'] as const) {
    for (const e of ctx.cfg.entriesForProd(prod)) entries.push({ ...e, prod });
  }
  // 注意：Gate 现货 xStocks 与 Gate 永续可能同名（TSLAX_USDT）——但分处不同连接，rev 各自独立
  const rev = new Map(entries.map((e) => [e.code, { sym: e.sym, prod: e.prod }]));
  return {
    name: 'GATE-SPOT',
    prods: ['gstocks', 'xstocks'],
    active: entries.length > 0,
    connect: () => {
      const url = 'wss://api.gateio.ws/ws/v4/';
      return runSocket(
        ctx,
        'GATE-SPOT',
        url,
        (ws, connSignal) => {
          ws.send(subMsg('spot.book_ticker', entries.map((e) => e.code)));
          heartbeat(connSignal, 15000, () =>
            ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'spot.ping' })),
          );
        },
        (text) => {
          const d = JSON.parse(text) as GateMsg;
          const r = d.result;
          if (d.channel !== 'spot.book_ticker' || !r || !r.s) return;
          const hit = rev.get(r.s);
          if (!hit || r.b === undefined || r.a === undefined) return;
          ctx.norm.accept('GATE-SPOT', hit.sym, hit.prod, Number(r.b), Number(r.a), r.t ?? null);
        },
      );
    },
  };
}
