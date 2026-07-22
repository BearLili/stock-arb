/**
 * 基线数学：EWMA 与滚动中位数。live 引擎与 validateM1 离线复现共用同一套，保证"同口径"。
 */

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** EWMA：value = value*(1-α) + x*α；首样本直接取 x */
export class Ewma {
  private v: number | null = null;
  constructor(private readonly alpha: number) {}
  update(x: number): void {
    this.v = this.v === null ? x : this.v * (1 - this.alpha) + x * this.alpha;
  }
  get value(): number | null {
    return this.v;
  }
}

/**
 * 双轨基线（EWMA + 240min 滚动中位），两轨都以"分钟桶最后一个 diff"为样本、
 * 在分钟收口时同步更新——对齐回测的 1m bar 口径。
 *
 * 关键：EWMA 的 α 按"每分钟(bar)"而非"每 tick"生效（开发文档 §1 明确信号是"分钟级均值回归"，
 * 回测亦为 1m bar）。若按每 raw tick 更新，高 tick 率下 EWMA 半衰期只有几十秒，会退化成贴合
 * 瞬时噪声、令保守 dev 恒选 EWMA 轨、DEV 告警形同虚设（审计 M3）。按分钟更新后半衰期≈
 * ln2/α 分钟(α=0.001→~11.5h)，是真正的慢基线，双轨保守 dev 才有意义。
 */
export class DualBaseline {
  private readonly ewma: Ewma;
  private readonly ring: number[] = [];
  private curMin: number | null = null;
  private curDiff: number | null = null;

  constructor(
    alpha: number,
    private readonly windowMin: number,
    private readonly minSamples: number,
  ) {
    this.ewma = new Ewma(alpha);
  }

  /** 观察一个 tick 的 (分钟epoch, diff)；跨分钟时把上一分钟的最终 diff 收口进两轨 */
  observe(minuteEpoch: number, diff: number): void {
    if (this.curMin === null) {
      this.curMin = minuteEpoch;
      this.curDiff = diff;
      return;
    }
    if (minuteEpoch === this.curMin) {
      this.curDiff = diff;
      return;
    }
    // 进入新分钟：上一分钟收口 → 同步更新 EWMA 与中位 ring
    if (this.curDiff !== null) this.commit(this.curDiff);
    this.curMin = minuteEpoch;
    this.curDiff = diff;
  }

  private commit(barDiff: number): void {
    this.ewma.update(barDiff);
    this.ring.push(barDiff);
    if (this.ring.length > this.windowMin) this.ring.shift();
  }

  /** EWMA 基线（不足 1 个完成分钟时为 null） */
  get ewmaValue(): number | null {
    return this.ewma.value;
  }

  /** 滚动中位基线（完成分钟样本数 <minSamples 时为 null；以完成分钟为准） */
  get medianValue(): number | null {
    if (this.ring.length < this.minSamples) return null;
    return median(this.ring);
  }
}

/**
 * 离线滚动中位（validateM1 用，严格复现回测）：对 1m-bar 数组逐位置取
 * 前 window 个位置内的非空值中位；非空数<minSamples 时该位置为 null。
 */
export function rollingMedianOffline(
  series: Array<number | null>,
  window: number,
  minSamples: number,
): Array<number | null> {
  const out: Array<number | null> = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i += 1) {
    const lo = Math.max(0, i - window + 1);
    const w: number[] = [];
    for (let j = lo; j <= i; j += 1) {
      const v = series[j];
      if (v !== null && v !== undefined) w.push(v);
    }
    out[i] = w.length < minSamples ? null : median(w);
  }
  return out;
}

/** 双轨保守 dev：取 |·| 较小的一轨，符号跟随（宁漏勿误，开发文档 §4.1 + 修正#4） */
export function conservativeDev(
  diff: number,
  ewmaVal: number | null,
  medianVal: number | null,
): { dev: number | null; which: 'ewma' | 'median' | 'none' } {
  const dEwma = ewmaVal !== null ? diff - ewmaVal : null;
  const dMed = medianVal !== null ? diff - medianVal : null;
  if (dEwma === null && dMed === null) return { dev: null, which: 'none' };
  if (dEwma === null) return { dev: dMed, which: 'median' };
  if (dMed === null) return { dev: dEwma, which: 'ewma' };
  return Math.abs(dEwma) <= Math.abs(dMed) ? { dev: dEwma, which: 'ewma' } : { dev: dMed, which: 'median' };
}
