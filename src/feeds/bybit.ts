/** Bybit 现货 xStocks（bybitx）—— orderbook.1 snapshot+delta，需维护本地簿。 */
import type { FeedContext, FeedDef } from './runner.js';
import { runSocket, heartbeat } from './runner.js';

interface BybitMsg {
  topic?: string;
  ts?: number;
  data?: { b?: Array<[string, string]>; a?: Array<[string, string]> };
}

/** 取一档最优价：size>0 返回价格，size=0 表示删除该档返回 null，缺省 undefined 表示无变化 */
function bestPrice(level: [string, string] | undefined): number | null | undefined {
  if (level === undefined) return undefined;
  const px = Number(level[0]);
  const sz = Number(level[1]);
  if (!(sz > 0)) return null; // 删除档
  return px;
}

export function bybit(ctx: FeedContext): FeedDef {
  const entries = ctx.cfg.entriesForProd('bybitx');
  const rev = new Map(entries.map((e) => [e.code, e.sym]));
  return {
    name: 'BYBIT',
    prods: ['bybitx'],
    active: entries.length > 0,
    connect: () => {
      const url = 'wss://stream.bybit.com/v5/public/spot';
      // 本地簿：orderbook.1 只有一档，snapshot 给全量、delta 增量更新最优价
      const book = new Map<string, { b: number | null; a: number | null }>();
      return runSocket(
        ctx,
        'BYBIT',
        url,
        (ws, connSignal) => {
          ws.send(JSON.stringify({ op: 'subscribe', args: entries.map((e) => `orderbook.1.${e.code}`) }));
          heartbeat(connSignal, 20000, () => ws.send(JSON.stringify({ op: 'ping' })));
        },
        (text) => {
          const d = JSON.parse(text) as BybitMsg;
          if (!d.topic) return; // 订阅确认/pong 等
          const code = d.topic.split('.').pop();
          if (!code) return;
          const sym = rev.get(code);
          if (!sym || !d.data) return;
          const bk = book.get(code) ?? { b: null, a: null };
          const bb = bestPrice(d.data.b?.[0]);
          const aa = bestPrice(d.data.a?.[0]);
          if (bb !== undefined) bk.b = bb; // null=删除档 → 清空该侧
          if (aa !== undefined) bk.a = aa;
          book.set(code, bk);
          if (bk.b !== null && bk.a !== null) {
            ctx.norm.accept('BYBIT', sym, 'bybitx', bk.b, bk.a, d.ts ?? null);
          }
        },
      );
    },
  };
}
