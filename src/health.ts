/**
 * feed 健康与数据完整率统计（M0 验收：完整率>99%，ts_exch−ts_recv 偏移分布）。
 *
 * 两个口径，分开报告以免误导（审计 M3/M4）：
 *  - uptimePct（主指标，"连续运行"）：连接处于 connected 的时长占比（基于状态转换精确计时，
 *    不受行情稀疏影响；连接在线即算完整，等价于"9路 feed 24h 连续运行"）。
 *  - tickCoveragePct（次指标，数据密度）："有≥1条tick的分钟数 / 应活跃分钟数"。应活跃扣除
 *    HL 休市。注意闭市/隔夜时段股票代币现货可能长时间无变动 → 此值偏低属正常，不代表丢数据。
 * skew 用环形缓冲保留最近 N 条，覆盖整个运行窗口（非仅启动瞬间）。
 */
import type { FeedStatus } from './types.js';
import { isHlClosed } from './time.js';

const SKEW_RING_CAP = 5000;

interface FeedStat {
  name: string;
  prods: Set<string>;
  status: FeedStatus;
  messages: number;
  ticksAccepted: number;
  ticksRejected: number;
  reconnects: number;
  lastMsgTs: number | null;
  firstTickTs: number | null;
  lastTickTs: number | null;
  // 环形缓冲 skew 样本（ms）
  skewRing: number[];
  skewNext: number;
  skewCount: number;
  // 有tick的分钟桶（epoch 分钟）
  minuteBuckets: Set<number>;
  // 连接在线计时
  connectedSinceTs: number | null;
  connectedMs: number;
}

export interface SkewSummary {
  n: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface FeedReport {
  name: string;
  status: FeedStatus;
  messages: number;
  ticksAccepted: number;
  ticksRejected: number;
  reconnects: number;
  uptimePct: number | null;
  tickCoverageMinutes: number;
  tickCoverageExpectedMinutes: number;
  tickCoveragePct: number | null;
  skew: SkewSummary;
}

function pctile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx] ?? null;
}

export class Health {
  private readonly feeds = new Map<string, FeedStat>();
  private readonly startTs: number;

  constructor(startTs: number) {
    this.startTs = startTs;
  }

  register(name: string, prods: string[]): void {
    if (this.feeds.has(name)) return;
    this.feeds.set(name, {
      name,
      prods: new Set(prods),
      status: 'connecting',
      messages: 0,
      ticksAccepted: 0,
      ticksRejected: 0,
      reconnects: 0,
      lastMsgTs: null,
      firstTickTs: null,
      lastTickTs: null,
      skewRing: [],
      skewNext: 0,
      skewCount: 0,
      minuteBuckets: new Set(),
      connectedSinceTs: null,
      connectedMs: 0,
    });
  }

  /** 状态转换 + 精确在线计时。now 必传以累计 connected 时长。 */
  setStatus(name: string, status: FeedStatus, now: number): void {
    const f = this.feeds.get(name);
    if (!f) return;
    const wasConnected = f.status === 'connected';
    const willConnected = status === 'connected';
    if (wasConnected && !willConnected && f.connectedSinceTs !== null) {
      f.connectedMs += now - f.connectedSinceTs;
      f.connectedSinceTs = null;
    } else if (!wasConnected && willConnected) {
      f.connectedSinceTs = now;
    }
    f.status = status;
  }

  onReconnect(name: string): void {
    const f = this.feeds.get(name);
    if (f) f.reconnects += 1;
  }

  onMessage(name: string, now: number): void {
    const f = this.feeds.get(name);
    if (!f) return;
    f.messages += 1;
    f.lastMsgTs = now;
  }

  onAccept(name: string, now: number, skewMs: number | null): void {
    const f = this.feeds.get(name);
    if (!f) return;
    f.ticksAccepted += 1;
    if (f.firstTickTs === null) f.firstTickTs = now;
    f.lastTickTs = now;
    f.minuteBuckets.add(Math.floor(now / 60000));
    if (skewMs !== null) {
      // 环形缓冲：满则覆盖最旧
      f.skewRing[f.skewNext] = skewMs;
      f.skewNext = (f.skewNext + 1) % SKEW_RING_CAP;
      f.skewCount += 1;
    }
  }

  onReject(name: string): void {
    const f = this.feeds.get(name);
    if (f) f.ticksRejected += 1;
  }

  /** tickCoverage 应活跃分钟数（含 hlperp 的 feed 扣除休市分钟） */
  private expectedMinutes(f: FeedStat, start: number, end: number): number {
    const startMin = Math.floor(start / 60000);
    const endMin = Math.floor(end / 60000);
    const affectedByHl = f.prods.has('hlperp');
    if (!affectedByHl) return Math.max(0, endMin - startMin + 1);
    let count = 0;
    for (let m = startMin; m <= endMin; m += 1) {
      if (!isHlClosed(m * 60000)) count += 1;
    }
    return count;
  }

  report(now: number): FeedReport[] {
    const out: FeedReport[] = [];
    const windowMs = Math.max(1, now - this.startTs);
    for (const f of this.feeds.values()) {
      // uptime：累计 connected 时长（含当前仍连接的一段）
      const liveMs = f.connectedMs + (f.status === 'connected' && f.connectedSinceTs !== null ? now - f.connectedSinceTs : 0);
      const uptimePct = Number(Math.min(100, (liveMs / windowMs) * 100).toFixed(2));
      // tick coverage
      const expected = this.expectedMinutes(f, this.startTs, now);
      const active = f.minuteBuckets.size;
      const tickPct = expected > 0 ? Number(Math.min(100, (active / expected) * 100).toFixed(2)) : null;
      const sorted = [...f.skewRing].sort((a, b) => a - b);
      out.push({
        name: f.name,
        status: f.status,
        messages: f.messages,
        ticksAccepted: f.ticksAccepted,
        ticksRejected: f.ticksRejected,
        reconnects: f.reconnects,
        uptimePct,
        tickCoverageMinutes: active,
        tickCoverageExpectedMinutes: expected,
        tickCoveragePct: tickPct,
        skew: {
          n: Math.min(f.skewCount, SKEW_RING_CAP),
          medianMs: pctile(sorted, 0.5),
          p95Ms: pctile(sorted, 0.95),
          maxMs: sorted.length ? (sorted[sorted.length - 1] ?? null) : null,
        },
      });
    }
    return out;
  }
}
