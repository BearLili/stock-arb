/**
 * Hyperliquid tradeXYZ 永续（hlperp）—— l2Book，coin=xyz:{SYM}，USDC 计价。
 * 周五20:00–周日20:00 ET 休市无推送（连接保持但 idle）；基线冻结在 engine 侧处理。
 */
import type { FeedContext, FeedDef } from './runner.js';
import { runSocket, heartbeat } from './runner.js';

interface HlMsg {
  channel?: string;
  data?: {
    coin?: string;
    time?: number;
    levels?: [Array<{ px?: string }>, Array<{ px?: string }>];
  };
}

export function hyperliquid(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('hlperp');
  const rev = new Map(entries.map((e) => [e.code, e.sym]));
  return {
    name: 'HL',
    prods: ['hlperp'],
    active: entries.length > 0,
    connect: () => {
      const url = 'wss://api.hyperliquid.xyz/ws';
      return runSocket(
        ctx,
        'HL',
        url,
        (ws, connSignal) => {
          for (const e of entries) {
            ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: e.code } }));
          }
          // HL 60s 无 ping 断连，30s 发一次
          heartbeat(connSignal, 30000, () => ws.send(JSON.stringify({ method: 'ping' })));
        },
        (text) => {
          const d = JSON.parse(text) as HlMsg;
          if (d.channel !== 'l2Book' || !d.data?.coin) return;
          const sym = rev.get(d.data.coin);
          if (!sym) return;
          const levels = d.data.levels;
          const bid = levels?.[0]?.[0]?.px;
          const ask = levels?.[1]?.[0]?.px;
          if (bid === undefined || ask === undefined) return;
          ctx.norm.accept('HL', sym, 'hlperp', Number(bid), Number(ask), d.data.time ?? null);
        },
      );
    },
  };
}
