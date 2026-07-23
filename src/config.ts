/**
 * monitor_config.json 的类型化加载与校验（zod）。
 *
 * 硬性约束（PRD/开发文档 §3.3）：交易对符号严禁字符串拼接，一律走 symbols 映射表。
 * 本模块是策略参数（费率/阈值）的唯一入口——不在别处硬编码数值。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Prod } from './types.js';

const PRODS = [
  'bstocks', 'gstocks', 'xstocks', 'bybitx', 'okxx',
  'mexcon', 'bnperp', 'gateperp', 'mexcperp', 'hlperp',
] as const;

const feeRecord = z.record(z.string(), z.number());

/** 一个 pair 是 [prodA, prodB] 二元组 */
const pairSchema = z.tuple([z.string(), z.string()]);

const engineSchema = z
  .object({
    spike_filter_bp: z.number().default(100),
    spike_confirm_ticks: z.number().int().default(3),
    ewma_alpha: z.number().default(0.001),
    baseline_window_min: z.number().int().default(240),
    rolling_median_min_samples: z.number().int().default(60),
    stale_ms: z.number().int().default(10000),
    alert_cooldown_ms: z.number().int().default(2000),
    // 含 MEXC 腿的对：EDGE 告警要求该腿 ts_exch 新鲜度 ≤ 此值，否则降级为 DEV（防陈价幻象）
    mexc_edge_stale_ms: z.number().int().default(2000),
  })
  .default({});

const fundingPollSchema = z
  .object({
    interval_sec: z.number().int().default(300),
    settle_per_day: z.record(z.string(), z.number()).default({}),
  })
  .default({});

const paperSchema = z
  .object({
    taker_slippage_bp: z.number().default(1),
    entry_cost_mult: z.number().default(1.0),
    exit_band_bp: z.number().default(2),
    maker_timeout_ms: z.number().int().default(60000),
    max_hold_min: z.number().int().default(240),
    min_trading_days_for_m3: z.number().int().default(5),
    // maker 挂单偏移(bp)：正=更激进(向mid内挂,成交率↑价差↓)，0=挂在bbo。扫描维度。
    maker_offset_bp: z.number().default(0),
    // S3 carry-hold（现货多+永续空）：入/出场按永续日化资金费(bp/天)阈值 + 最长持仓天数
    s3_entry_carry_bp_day: z.number().default(2),
    s3_exit_carry_bp_day: z.number().default(0.5),
    s3_max_hold_days: z.number().default(30),
  })
  .default({});

const riskSchema = z
  .object({
    max_notional_usd: z.number().default(500),
    max_strategy_exposure_usd: z.number().default(20000),
    max_total_exposure_usd: z.number().default(50000),
    daily_loss_halt_usd: z.number().default(1000),
    api_error_rate_per_min: z.number().default(5),
    emergency_unwind_daily_limit: z.number().int().default(3),
    clock_skew_reject_ms: z.number().int().default(500),
  })
  .default({});

export type EngineParams = z.infer<typeof engineSchema>;
export type FundingPollParams = z.infer<typeof fundingPollSchema>;
export type PaperParams = z.infer<typeof paperSchema>;
export type RiskParams = z.infer<typeof riskSchema>;

const configSchema = z
  .object({
    taker_fee_bp: feeRecord,
    // 以下为在原配置上"追加"的字段（原始 monitor_config.json 只含 taker）：
    maker_fee_bp: feeRecord.optional(),
    maker_min_profit_bp: z.number().default(2),
    edge_threshold_bp: z.number().default(3),
    dev_threshold_bp: z.number().default(15),
    engine: engineSchema,
    funding_poll: fundingPollSchema,
    tradeable: z.record(z.string(), z.boolean()).default({}),
    rtt_ms: z.record(z.string(), z.number()).default({}),
    paper: paperSchema,
    risk: riskSchema,
    alert_csv: z.string().default('alerts.csv'),
    funding_note: z.string().optional(),
    pairs: z.array(pairSchema),
    symbols: z.record(z.string(), z.record(z.string(), z.string())),
  })
  // 允许 _说明 等注释字段透传，不做未知键报错
  .passthrough();

export type RawConfig = z.infer<typeof configSchema>;

export class Config {
  private readonly raw: RawConfig;
  readonly path: string;

  constructor(raw: RawConfig, path: string) {
    this.raw = raw;
    this.path = path;
    this.validateSemantics();
  }

  static load(path: string): Config {
    const text = readFileSync(path, 'utf8');
    const json = JSON.parse(text) as unknown;
    const parsed = configSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`配置校验失败 ${path}:\n${parsed.error.toString()}`);
    }
    return new Config(parsed.data, path);
  }

  /** 返回覆盖了部分 engine/paper/risk 参数的新 Config（扫描/测试用；不改原对象） */
  override(patch: { engine?: Partial<EngineParams>; paper?: Partial<PaperParams>; risk?: Partial<RiskParams> }): Config {
    const raw = structuredClone(this.raw);
    if (patch.engine) Object.assign(raw.engine, patch.engine);
    if (patch.paper) Object.assign(raw.paper, patch.paper);
    if (patch.risk) Object.assign(raw.risk, patch.risk);
    return new Config(raw, this.path);
  }

  /** 语义级校验：pair 两腿必须是已知产品键；至少一个 symbol 提供该产品 */
  private validateSemantics(): void {
    for (const [a, b] of this.raw.pairs) {
      for (const p of [a, b]) {
        if (!(PRODS as readonly string[]).includes(p)) {
          throw new Error(`pairs 含未知产品键: ${p}`);
        }
      }
    }
    // 校验 symbols 里的产品键都合法
    for (const [sym, m] of Object.entries(this.raw.symbols)) {
      for (const p of Object.keys(m)) {
        if (!(PRODS as readonly string[]).includes(p)) {
          throw new Error(`symbols.${sym} 含未知产品键: ${p}`);
        }
      }
    }
  }

  get symbolsList(): string[] {
    return Object.keys(this.raw.symbols);
  }

  get pairs(): ReadonlyArray<readonly [Prod, Prod]> {
    return this.raw.pairs.map(([a, b]) => [a as Prod, b as Prod] as const);
  }

  get edgeThresholdBp(): number {
    return this.raw.edge_threshold_bp;
  }

  get devThresholdBp(): number {
    return this.raw.dev_threshold_bp;
  }

  get makerMinProfitBp(): number {
    return this.raw.maker_min_profit_bp;
  }

  get engine(): EngineParams {
    return this.raw.engine;
  }

  get fundingPoll(): FundingPollParams {
    return this.raw.funding_poll;
  }

  /** 资金费日结算次数（8h所=3，HL=24）；未配置回退 3 */
  settlePerDay(prod: Prod): number {
    return this.raw.funding_poll.settle_per_day[prod] ?? 3;
  }

  get paper(): PaperParams {
    return this.raw.paper;
  }

  get risk(): RiskParams {
    return this.raw.risk;
  }

  /** 该产品是否允许作交易腿（撮合层双保险）；缺省 true */
  tradeable(prod: Prod): boolean {
    return this.raw.tradeable[prod] ?? true;
  }

  /** 下单往返到达交易所估计延迟(ms)；缺省 100 */
  rttMs(prod: Prod): number {
    return this.raw.rtt_ms[prod] ?? 100;
  }

  get alertCsv(): string {
    return this.raw.alert_csv;
  }

  get fundingNote(): string | undefined {
    return this.raw.funding_note;
  }

  /**
   * 取某 (sym, prod) 的交易所符号。严禁在别处拼接——只从映射表读。
   * 不存在返回 undefined（该 sym 不在此产品上市）。
   */
  symbolCode(sym: string, prod: Prod): string | undefined {
    return this.raw.symbols[sym]?.[prod];
  }

  /** 枚举某产品下所有 (sym, 交易所符号) —— feed 订阅时用 */
  entriesForProd(prod: Prod): Array<{ sym: string; code: string }> {
    const out: Array<{ sym: string; code: string }> = [];
    for (const sym of this.symbolsList) {
      const code = this.symbolCode(sym, prod);
      if (code) out.push({ sym, code });
    }
    return out;
  }

  /** taker 费率（bp/边）。缺省 10（与 ws_monitor 一致的保守回退） */
  takerFeeBp(prod: Prod): number {
    return this.raw.taker_fee_bp[prod] ?? 10;
  }

  /** maker 费率（bp/边）。负值=返佣。未配置则回退到 taker（保守） */
  makerFeeBp(prod: Prod): number {
    return this.raw.maker_fee_bp?.[prod] ?? this.takerFeeBp(prod);
  }

  /**
   * 往返 taker 成本（bp）——回测口径（net_edge.csv 复现用）。
   * = 2×(takerA + takerB) + spreadSumBp
   * spreadSumBp 为两腿盘口点差之和（回测由 book 实测；net_edge.csv 提供该列）。
   */
  roundTripTakerCostBp(a: Prod, b: Prod, spreadSumBp: number): number {
    return 2 * (this.takerFeeBp(a) + this.takerFeeBp(b)) + spreadSumBp;
  }

  /**
   * maker 阈值（bp）——纸面/回测 maker 口径。
   * = max(2×(makerA + makerB), 0) + maker_min_profit_bp
   * max(...,0) 将 Gate 返佣（负 maker）在最低利润项前下限归零。
   */
  makerThresholdBp(a: Prod, b: Prod): number {
    return Math.max(2 * (this.makerFeeBp(a) + this.makerFeeBp(b)), 0) + this.makerMinProfitBp;
  }
}
