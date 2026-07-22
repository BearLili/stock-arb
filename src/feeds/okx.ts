/** OKX 代币化股票现货（okxx）—— books5 频道；OKX 需 20s 心跳（字符串 'ping'）。 */
import type { FeedContext, FeedDef } from './runner.js';
import { runSocket, heartbeat } from './runner.js';

interface OkxMsg {
  arg?: { channel?: string; instId?: string };
  data?: Array<{ bids?: string[][]; asks?: string[][]; ts?: string }>;
}

export function okx(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('okxx');
  const rev = new Map(entries.map((e) => [e.code, e.sym]));
  return {
    name: 'OKX',
    prods: ['okxx'],
    active: entries.length > 0,
    connect: () => {
      const url = 'wss://ws.okx.com:8443/ws/v5/public';
      return runSocket(
        ctx,
        'OKX',
        url,
        (ws, connSignal) => {
          ws.send(
            JSON.stringify({
              op: 'subscribe',
              args: entries.map((e) => ({ channel: 'books5', instId: e.code })),
            }),
          );
          // OKX 30s 无数据即断，发字符串 'ping' 保活
          heartbeat(connSignal, 20000, () => ws.send('ping'));
        },
        (text) => {
          if (text === 'pong') return;
          const d = JSON.parse(text) as OkxMsg;
          if (d.arg?.channel !== 'books5' || !d.data?.[0]) return;
          const inst = d.arg.instId;
          if (!inst) return;
          const sym = rev.get(inst);
          if (!sym) return;
          const r = d.data[0];
          const bid = r.bids?.[0]?.[0];
          const ask = r.asks?.[0]?.[0];
          if (bid === undefined || ask === undefined) return;
          ctx.norm.accept('OKX', sym, 'okxx', Number(bid), Number(ask), r.ts ? Number(r.ts) : null);
        },
      );
    },
  };
}
