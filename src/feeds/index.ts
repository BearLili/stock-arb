/** 组装并启动全部 9 路 feed。 */
import type { FeedContext, FeedDef } from './runner.js';
import { runFeed } from './runner.js';
import { bnFut, bnSpot } from './binance.js';
import { gateFut, gateSpot } from './gate.js';
import { bybit } from './bybit.js';
import { okx } from './okx.js';
import { mexcFut, mexcSpotPoll } from './mexc.js';
import { hyperliquid } from './hyperliquid.js';

/** 9 路：BN-FUT, BN-SPOT, GATE-FUT, GATE-SPOT, BYBIT, OKX, MEXC-FUT, MEXC-SPOT, HL */
export function buildFeeds(ctx: FeedContext): FeedDef[] {
  return [
    bnFut(ctx),
    bnSpot(ctx),
    gateFut(ctx),
    gateSpot(ctx),
    bybit(ctx),
    okx(ctx),
    mexcFut(ctx),
    mexcSpotPoll(ctx),
    hyperliquid(ctx),
  ];
}

/** 启动全部 feed 的重连循环，返回一个在全部 feed 退出后 resolve 的 Promise */
export function startAllFeeds(ctx: FeedContext): Promise<void[]> {
  const feeds = buildFeeds(ctx);
  return Promise.all(feeds.map((def) => runFeed(def, ctx)));
}
