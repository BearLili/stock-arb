/**
 * 分级告警输出：EDGE（可执行净edge>阈值）/ DEV（偏离基线>阈值）。
 * 通道：控制台 + CSV（复用 ws_monitor 的 alerts.csv 列）+ webhook（可选，env ALERT_WEBHOOK）。
 * 同对同类告警有冷却，避免刷屏；冷却只影响输出，不影响 validateM1 的离线频率统计。
 */
import { appendFileSync } from 'node:fs';
import { request } from 'undici';
import { childLog } from '../log.js';
import { hms } from '../time.js';

const lg = childLog('alert');

export type AlertKind = 'EDGE' | 'DEV';

/** 引擎依赖的告警下沉接口（live=Alerts，paper=静默） */
export interface AlertSink {
  emit(a: AlertEvent): void;
}

/** 静默下沉：纸面回测用，不产告警 */
export const silentSink: AlertSink = { emit: () => {} };

export interface AlertEvent {
  ts: number;
  sym: string;
  pair: string; // "a-b"
  kind: AlertKind;
  side: string; // "卖a买b" 等；DEV 时为观察方向
  edgeBp: number; // 可执行净edge（两方向取大）
  devBp: number | null; // 偏离基线（保守口径）
  baseline: 'ewma' | 'median' | 'none';
  carryBpDay: number | null; // 持仓对净carry（bp/天），无则 null
  staleDowngrade?: boolean; // MEXC 腿 ts_exch 陈旧，本应 EDGE 但降级为 DEV
}

export class Alerts implements AlertSink {
  private readonly csvPath: string;
  private readonly cooldownMs: number;
  private readonly webhook: string | undefined;
  private readonly last = new Map<string, number>();

  constructor(csvPath: string, cooldownMs: number) {
    this.csvPath = csvPath;
    this.cooldownMs = cooldownMs;
    this.webhook = process.env.ALERT_WEBHOOK; // 用户自配端点才启用；默认 undefined
    // CSV 表头（若文件不存在）——用 appendFile 幂等，简单起见首行总尝试写头由外部保证
  }

  private cooled(key: string, ts: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && ts - prev < this.cooldownMs) return false;
    this.last.set(key, ts);
    return true;
  }

  emit(a: AlertEvent): void {
    const key = `${a.sym}|${a.pair}|${a.kind}`;
    if (!this.cooled(key, a.ts)) return;

    const carry = a.carryBpDay !== null ? ` carry${a.carryBpDay >= 0 ? '+' : ''}${a.carryBpDay.toFixed(2)}bp/日` : '';
    const devStr = a.devBp !== null ? `${a.devBp >= 0 ? '+' : ''}${a.devBp.toFixed(1)}` : 'n/a';
    const stale = a.staleDowngrade ? ' ⚠️MEXC陈价降级' : '';
    if (a.kind === 'EDGE') {
      lg.info(`[${hms(a.ts)}] EDGE ${a.sym} ${a.pair} ${a.side} 净${a.edgeBp.toFixed(1)}bp (基线偏离${devStr}bp,${a.baseline})${carry}`);
    } else {
      lg.info(`[${hms(a.ts)}] DEV  ${a.sym} ${a.pair} 偏离基线${devStr}bp (${a.baseline},taker净edge ${a.edgeBp.toFixed(1)}bp)${carry}${stale}`);
    }

    // CSV：秒级ts, sym, pair, kind, side, edge, dev, baseline, carry, stale_downgrade
    try {
      appendFileSync(
        this.csvPath,
        `${Math.floor(a.ts / 1000)},${a.sym},${a.pair},${a.kind},${a.side},${a.edgeBp.toFixed(1)},${a.devBp === null ? '' : a.devBp.toFixed(1)},${a.baseline},${a.carryBpDay === null ? '' : a.carryBpDay.toFixed(2)},${a.staleDowngrade ? 1 : 0}\n`,
      );
    } catch (e) {
      lg.warn({ err: (e as Error).message }, 'CSV 写入失败');
    }

    if (this.webhook) void this.postWebhook(a);
  }

  private async postWebhook(a: AlertEvent): Promise<void> {
    try {
      await request(this.webhook as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a),
        headersTimeout: 4000,
        bodyTimeout: 4000,
      });
    } catch (e) {
      lg.warn({ err: (e as Error).message }, 'webhook 投递失败');
    }
  }
}
