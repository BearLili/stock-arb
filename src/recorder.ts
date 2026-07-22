/**
 * 全量 BBO 落盘：按 UTC 日分区的 JSONL，跨日滚动时 gzip 归档（开发文档 §1）。
 *
 * 路径：data/live/YYYY-MM-DD/{prod}.jsonl   （当日活动文件，明文追加）
 * 滚动：进入新 UTC 日或关停时，前一日文件 → {prod}.jsonl.gz（duckdb 可直查）。
 * 每行：{"ts_exch":<ms|null>,"ts_recv":<ms>,"sym":..,"prod":..,"bid":..,"ask":..}
 *   —— 双时间戳：交易所事件时间 + 本地接收时间（S4 跨所对齐必需）。
 * 落盘保真：不做去噪/陈旧过滤，原始 tick 全量记录。
 */
import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { BboEvent } from './types.js';
import { utcDateKey } from './time.js';
import { childLog } from './log.js';

const lg = childLog('recorder');

interface OpenFile {
  day: string;
  prod: string;
  path: string;
  stream: WriteStream;
  lines: number;
}

export class Recorder {
  private readonly root: string;
  private readonly open = new Map<string, OpenFile>(); // key: day|prod
  private currentDay: string | null = null;
  private totalLines = 0;
  private closed = false;

  constructor(root = 'data/live') {
    this.root = root;
  }

  private key(day: string, prod: string): string {
    return `${day}|${prod}`;
  }

  private getFile(day: string, prod: string): OpenFile {
    const k = this.key(day, prod);
    let f = this.open.get(k);
    if (f) return f;
    const dir = join(this.root, day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${prod}.jsonl`);
    const stream = createWriteStream(path, { flags: 'a' });
    // 磁盘异常（ENOSPC/EPIPE…）时不让未捕获 'error' 事件杀死 24h 采集器（审计 M5）
    stream.on('error', (err) => lg.error({ err: (err as Error).message, path }, '落盘流错误'));
    f = { day, prod, path, stream, lines: 0 };
    this.open.set(k, f);
    return f;
  }

  write(e: BboEvent): void {
    // 关停后到达的迟到 tick（如 MEXC REST 超时回包）不得重开已归档文件（审计 H1）
    if (this.closed) return;
    const day = utcDateKey(e.tsRecv);
    if (this.currentDay !== null && day !== this.currentDay) {
      // 跨 UTC 日：归档所有旧日文件
      void this.rollover(this.currentDay);
    }
    this.currentDay = day;
    const f = this.getFile(day, e.prod);
    // JSON.stringify 保证始终合法 JSON（字段来自可信来源，但拼接对"始终合法"验收脆弱，审计 L8）
    const line =
      JSON.stringify({
        ts_exch: e.tsExch,
        ts_recv: e.tsRecv,
        sym: e.sym,
        prod: e.prod,
        bid: e.bid,
        ask: e.ask,
      }) + '\n';
    f.stream.write(line);
    f.lines += 1;
    this.totalLines += 1;
  }

  get lineCount(): number {
    return this.totalLines;
  }

  /** 归档某一天已打开的所有文件（gzip 后删明文） */
  private async rollover(day: string): Promise<void> {
    const toArchive = [...this.open.values()].filter((f) => f.day === day);
    for (const f of toArchive) {
      this.open.delete(this.key(f.day, f.prod));
      await this.finalize(f);
    }
  }

  private async finalize(f: OpenFile): Promise<void> {
    await new Promise<void>((resolve) => f.stream.end(resolve));
    if (f.lines === 0) return;
    try {
      const gzPath = `${f.path}.gz`;
      await pipeline(createReadStream(f.path), createGzip(), createWriteStream(gzPath));
      await unlink(f.path);
      lg.info({ file: gzPath, lines: f.lines }, '归档');
    } catch (e) {
      lg.warn({ err: (e as Error).message, file: f.path }, 'gzip 归档失败，保留明文');
    }
  }

  /** 关停：置 closed（拒绝迟到 tick）并结束/归档所有打开文件 */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.open.values()];
    this.open.clear();
    for (const f of all) await this.finalize(f);
  }
}
