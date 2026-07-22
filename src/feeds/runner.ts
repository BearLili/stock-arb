/**
 * feed 运行框架：断线重连（照 ws_monitor.reconnecting，固定 5s）+ WS 连接封装。
 *
 * 每路 feed 定义一个 connect()，负责建连/订阅/读循环，返回的 Promise：
 *   - resolve → 干净关闭（触发重连）
 *   - reject  → 出错（记 reconnect + 5s 后重连）
 * 关停通过 ctx.signal（AbortSignal）广播。
 */
import { WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { Normalizer } from '../normalizer.js';
import type { Health } from '../health.js';
import { childLog } from '../log.js';

export interface FeedContext {
  cfg: Config;
  norm: Normalizer;
  health: Health;
  signal: AbortSignal;
  /** M2 才启用：trades 订阅（maker 成交率标定）。M0/M1 为 false，仅预留接口 */
  enableTrades: boolean;
}

export interface FeedDef {
  name: string;
  prods: string[];
  /** 该 feed 在当前 config 下是否有标的订阅（无则不建连） */
  active: boolean;
  connect(ctx: FeedContext): Promise<void>;
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 建立一个 WS 连接并跑到关闭/出错。
 *  - onOpen(ws, connSignal)：订阅、启动 ping（connSignal 在本连接关闭时 abort，用于清理 interval）
 *  - onMessage(text, ws)：每条消息（已计入 health.onMessage）
 */
export function runSocket(
  ctx: FeedContext,
  name: string,
  url: string,
  onOpen: ((ws: WebSocket, connSignal: AbortSignal) => void) | undefined,
  onMessage: (text: string, ws: WebSocket) => void,
): Promise<void> {
  const lg = childLog(name);
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    const conn = new AbortController();
    let settled = false;

    const onAbort = (): void => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      conn.abort();
      ctx.signal.removeEventListener('abort', onAbort);
      // 无条件关闭 ws，避免 onOpen 抛错走 reject 分支后 socket 泄漏（审计 L7）
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };

    ws.on('open', () => {
      ctx.health.setStatus(name, 'connected', Date.now());
      lg.info('connected');
      try {
        onOpen?.(ws, conn.signal);
      } catch (e) {
        settle(() => reject(e as Error));
      }
    });
    ws.on('message', (data) => {
      ctx.health.onMessage(name, Date.now());
      try {
        onMessage(data.toString(), ws);
      } catch (e) {
        // 单条消息解析错误不应拖垮连接
        lg.debug({ err: (e as Error).message }, 'message parse error');
      }
    });
    ws.on('error', (err) => settle(() => reject(err)));
    ws.on('close', () => settle(() => resolve()));

    if (ctx.signal.aborted) onAbort();
  });
}

/** 在 connSignal 未 abort 时，每 periodMs 执行一次 fn（用于 app 级 ping/keepalive） */
export function heartbeat(connSignal: AbortSignal, periodMs: number, fn: () => void): void {
  if (connSignal.aborted) return;
  const t = setInterval(() => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }, periodMs);
  connSignal.addEventListener('abort', () => clearInterval(t), { once: true });
}

/** 重连循环：跑一路 feed 直到 ctx.signal 关停 */
export async function runFeed(def: FeedDef, ctx: FeedContext): Promise<void> {
  const lg = childLog(def.name);
  ctx.health.register(def.name, def.prods);
  if (!def.active) {
    lg.info('无标的订阅，跳过');
    return;
  }
  let first = true;
  while (!ctx.signal.aborted) {
    ctx.health.setStatus(def.name, 'connecting', Date.now());
    if (!first) ctx.health.onReconnect(def.name);
    first = false;
    try {
      await def.connect(ctx);
      if (ctx.signal.aborted) break;
      lg.warn('连接关闭，5s 后重连');
    } catch (e) {
      lg.warn({ err: String((e as Error).message).slice(0, 120) }, '断线，5s 后重连');
    }
    ctx.health.setStatus(def.name, 'disconnected', Date.now());
    if (ctx.signal.aborted) break;
    await delay(5000, ctx.signal);
  }
  ctx.health.setStatus(def.name, 'disconnected', Date.now());
}
