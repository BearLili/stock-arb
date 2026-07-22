/**
 * MEXC 股票永续（mexcperp）—— contract.mexc.com WS，需 15s ping。
 * MEXC 现货 Ondo（mexcon）—— 现货 WS 为 protobuf，原型/本实现用 2s REST 轮询替代（开发文档 §3.2）。
 */
import { request } from 'undici';
import type { FeedContext, FeedDef } from './runner.js';
import { runSocket, heartbeat, delay } from './runner.js';
import { childLog } from '../log.js';

interface MexcTicker {
  channel?: string;
  ts?: number;
  data?: { symbol?: string; bid1?: number; ask1?: number; timestamp?: number };
}

/** MEXC 股票永续 WS ticker */
export function mexcFut(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('mexcperp');
  const rev = new Map(entries.map((e) => [e.code, e.sym]));
  return {
    name: 'MEXC-FUT',
    prods: ['mexcperp'],
    active: entries.length > 0,
    connect: () => {
      const url = 'wss://contract.mexc.com/edge';
      return runSocket(
        ctx,
        'MEXC-FUT',
        url,
        (ws, connSignal) => {
          for (const e of entries) {
            ws.send(JSON.stringify({ method: 'sub.ticker', param: { symbol: e.code } }));
          }
          // MEXC 合约要求 15s ping（开发文档 §3.2）
          heartbeat(connSignal, 15000, () => ws.send(JSON.stringify({ method: 'ping' })));
        },
        (text) => {
          const d = JSON.parse(text) as MexcTicker;
          if (d.channel !== 'push.ticker' || !d.data?.symbol) return;
          const sym = rev.get(d.data.symbol);
          if (!sym || d.data.bid1 === undefined || d.data.ask1 === undefined) return;
          const tsExch = d.ts ?? d.data.timestamp ?? null;
          ctx.norm.accept('MEXC-FUT', sym, 'mexcperp', Number(d.data.bid1), Number(d.data.ask1), tsExch);
        },
      );
    },
  };
}

/** MEXC 现货 Ondo REST 轮询（2s）。无交易所时间戳 → tsExch=null */
export function mexcSpotPoll(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('mexcon');
  const lg = childLog('MEXC-SPOT');
  return {
    name: 'MEXC-SPOT',
    prods: ['mexcon'],
    active: entries.length > 0,
    connect: async () => {
      lg.info('REST 轮询启动 (2s)');
      ctx.health.setStatus('MEXC-SPOT', 'connected', Date.now());
      while (!ctx.signal.aborted) {
        // 并发拉取，单符号 5s 超时不拖长整轮（审计 L9）
        await Promise.allSettled(
          entries.map(async (e) => {
            const res = await request(
              `https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(e.code)}`,
              { headersTimeout: 5000, bodyTimeout: 5000 },
            );
            ctx.health.onMessage('MEXC-SPOT', Date.now());
            const j = (await res.body.json()) as { bidPrice?: string; askPrice?: string };
            if (j.bidPrice !== undefined && j.askPrice !== undefined) {
              ctx.norm.accept('MEXC-SPOT', e.sym, 'mexcon', Number(j.bidPrice), Number(j.askPrice), null);
            }
          }),
        );
        await delay(2000, ctx.signal);
      }
    },
  };
}
