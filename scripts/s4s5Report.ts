/**
 * S4 / S5 实时结论报告（开发文档 §7 M1 验收产出之一）。
 *
 * 数据源：collector/engine 落盘的原始 BBO（data/live 下 JSONL/gz），用 duckdb 直查。
 * S4（HL↔BN/Gate 永续）：HL 真实同时点差 vs 回测 5m 假设——回测因仅 5m 粒度高估偏离，
 *   本报告给出 HL 逐日 bid-ask 点差(bp) 分布 + HL-BN 实时溢价，用于判断 S4 做/不做。
 * S5（OKX 新区溢价）：okxx vs bnperp 逐日溢价中位序列（溢价衰减速度本身是结论），
 *   标注观察起点 = OKX 上市第 N 天（上市日 2026-07-16）。
 *
 * 硬性门槛（修正#5）：结论须基于 ≥3 个美股交易日 + ≥1 个周末的实时数据；
 *   不足则明确输出"数据不足"，禁止提前下结论（仍给出已观测统计以供参考）。
 * data/ 只读。
 */
import duckdb from 'duckdb';
import { writeFileSync, mkdirSync } from 'node:fs';

// duckdb 的 count 等返回 BigInt，JSON.stringify 无法序列化 → 统一转 Number
const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v);

const GLOB = process.env.LANDING_GLOB ?? 'data/live/*/*.jsonl*';
const OKX_LIST_DATE = '2026-07-16'; // OKX 代币化股票上市日（PRD §2.2）
const MIN_TRADING_DAYS = 3;
const MIN_WEEKENDS = 1;

const SRC = `read_json_auto('${GLOB}', format='newline_delimited', compression='auto_detect', union_by_name=true)`;

function makeDb(): { all: (sql: string) => Promise<Array<Record<string, unknown>>>; close: () => void } {
  const db = new duckdb.Database(':memory:');
  const con = db.connect();
  return {
    all: (sql: string) =>
      new Promise((resolve, reject) => {
        con.all(sql, (err, rows) => (err ? reject(err) : resolve(rows as Array<Record<string, unknown>>)));
      }),
    close: () => {
      con.close();
      db.close(() => undefined);
    },
  };
}

// 分钟对齐后每 (sym,prod,minute) 取该分钟最后一个 mid
const MINUTE_MID = `
  WITH t AS (
    SELECT sym, prod, CAST(ts_recv/60000 AS BIGINT) AS min, (bid+ask)/2.0 AS mid, ts_recv
    FROM ${SRC}
  )
  SELECT sym, prod, min, arg_max(mid, ts_recv) AS mid
  FROM t GROUP BY sym, prod, min
`;

async function coverage(db: ReturnType<typeof makeDb>): Promise<{
  tradingDays: number;
  weekendDays: number;
  days: Array<{ day: string; dow: number; sessionRows: number; totalRows: number }>;
}> {
  const rows = await db.all(`
    WITH t AS (
      SELECT ts_recv,
             CAST(to_timestamp(ts_recv/1000) AS DATE) AS day,
             dayofweek(to_timestamp(ts_recv/1000)) AS dow,   -- 0=Sun..6=Sat
             (CAST(ts_recv/60000 AS BIGINT) % 1440) AS mod   -- UTC 分钟
      FROM ${SRC}
    )
    SELECT day::VARCHAR AS day, any_value(dow) AS dow,
           sum(CASE WHEN mod >= 810 AND mod < 1200 THEN 1 ELSE 0 END) AS session_rows,
           count(*) AS total_rows
    FROM t GROUP BY day ORDER BY day
  `);
  const days = rows.map((r) => ({
    day: String(r.day),
    dow: Number(r.dow),
    sessionRows: Number(r.session_rows),
    totalRows: Number(r.total_rows),
  }));
  const tradingDays = days.filter((d) => d.dow >= 1 && d.dow <= 5 && d.sessionRows > 0).length;
  const weekendDays = days.filter((d) => d.dow === 0 || d.dow === 6).length;
  return { tradingDays, weekendDays, days };
}

async function s4(db: ReturnType<typeof makeDb>): Promise<{
  hlSpreadDaily: Array<Record<string, unknown>>;
  hlVsBnPremiumDaily: Array<Record<string, unknown>>;
}> {
  // HL 自身 bid-ask 点差(bp) 逐日分布
  const hlSpreadDaily = await db.all(`
    SELECT sym,
           CAST(to_timestamp(ts_recv/1000) AS DATE)::VARCHAR AS day,
           count(*) AS ticks,
           round(median((ask-bid)/((ask+bid)/2.0)*1e4), 2) AS spread_med_bp,
           round(quantile_cont((ask-bid)/((ask+bid)/2.0)*1e4, 0.95), 2) AS spread_p95_bp
    FROM ${SRC} WHERE prod='hlperp'
    GROUP BY sym, day ORDER BY sym, day
  `);
  // HL vs BN 实时同时溢价（分钟对齐）逐日中位
  const hlVsBnPremiumDaily = await db.all(`
    WITH m AS (${MINUTE_MID}),
    h AS (SELECT sym, min, mid FROM m WHERE prod='hlperp'),
    b AS (SELECT sym, min, mid FROM m WHERE prod='bnperp')
    SELECT h.sym,
           CAST(to_timestamp(h.min*60) AS DATE)::VARCHAR AS day,
           count(*) AS minutes,
           round(median((h.mid/b.mid-1)*1e4), 2) AS hl_minus_bn_med_bp,
           round(stddev_pop((h.mid/b.mid-1)*1e4), 2) AS std_bp
    FROM h JOIN b USING (sym, min)
    GROUP BY h.sym, day ORDER BY h.sym, day
  `);
  return { hlSpreadDaily, hlVsBnPremiumDaily };
}

async function s5(db: ReturnType<typeof makeDb>): Promise<Array<Record<string, unknown>>> {
  // OKX vs BN 逐日溢价中位序列（溢价衰减）
  return db.all(`
    WITH m AS (${MINUTE_MID}),
    o AS (SELECT sym, min, mid FROM m WHERE prod='okxx'),
    b AS (SELECT sym, min, mid FROM m WHERE prod='bnperp'),
    j AS (
      SELECT o.sym AS sym,
             CAST(to_timestamp(o.min*60) AS DATE) AS day,
             (o.mid/b.mid-1)*1e4 AS prem
      FROM o JOIN b USING (sym, min)
    )
    SELECT sym, day::VARCHAR AS day,
           datediff('day', DATE '${OKX_LIST_DATE}', day) AS days_since_listing,
           count(*) AS minutes,
           round(median(prem), 2) AS okx_prem_med_bp,
           round(quantile_cont(prem, 0.95), 2) AS okx_prem_p95_bp
    FROM j GROUP BY sym, day ORDER BY sym, day
  `);
}

async function main(): Promise<void> {
  const db = makeDb();
  // 关键：固定 UTC，否则日期/星期按宿主本地时区分桶，破坏 UTC 口径与"交易日/周末"门槛（审计 M2）
  await db.all(`SET TimeZone='UTC'`);
  let hasData = true;
  try {
    await db.all(`SELECT count(*) FROM ${SRC} LIMIT 1`);
  } catch {
    hasData = false;
  }

  if (!hasData) {
    console.log('❌ 未发现落盘数据（data/live 下无 JSONL）。先运行 collector/engine 采集：npm run engine');
    db.close();
    process.exit(0);
  }

  const cov = await coverage(db);
  const sufficient = cov.tradingDays >= MIN_TRADING_DAYS && cov.weekendDays >= MIN_WEEKENDS;

  const s4res = await s4(db);
  const s5res = await s5(db);
  db.close();

  const verdict = sufficient
    ? '数据充分，可下结论'
    : `数据不足（需 ≥${MIN_TRADING_DAYS} 交易日 + ≥${MIN_WEEKENDS} 周末；当前 ${cov.tradingDays} 交易日 / ${cov.weekendDays} 周末日）——暂不下结论，仅列已观测统计`;

  console.log('===== S4/S5 实时结论报告 =====');
  console.log(`覆盖：交易日 ${cov.tradingDays} / 周末日 ${cov.weekendDays} / 观测天数 ${cov.days.length}`);
  console.log(`判定：${verdict}`);
  console.log('\n[S4] HL 逐日 bid-ask 点差(bp):');
  console.table(s4res.hlSpreadDaily);
  console.log('[S4] HL−BN 实时溢价逐日(bp):');
  console.table(s4res.hlVsBnPremiumDaily);
  console.log(`[S5] OKX−BN 溢价逐日(bp)（上市日 ${OKX_LIST_DATE}，days_since_listing 为第N天）:`);
  console.table(s5res);

  if (!sufficient) {
    console.log('\n⚠️ 数据不足，S4/S5 结论留空。上线后在服务器持续采集 ≥3 交易日+1 周末再复跑本报告。');
  } else {
    console.log('\nS4 结论：见 HL 真实点差与 HL−BN 溢价（对比回测 5m 假设是否高估偏离）。');
    console.log('S5 结论：见 OKX 溢价逐日衰减序列（窗口预计数周，衰减速度决定优先级）。');
  }

  mkdirSync('docs/samples', { recursive: true });
  writeFileSync(
    'docs/samples/M1_s4s5_report.json',
    JSON.stringify(
      {
        generatedNote: 'S4/S5 实时结论报告；数据不足时结论留空（修正#5）',
        okxListingDate: OKX_LIST_DATE,
        coverage: cov,
        sufficient,
        verdict,
        s4_hl_spread_daily: s4res.hlSpreadDaily,
        s4_hl_minus_bn_premium_daily: s4res.hlVsBnPremiumDaily,
        s5_okx_premium_daily: s5res,
      },
      bigintReplacer,
      2,
    ),
  );
  console.log('\n报告已写入 docs/samples/M1_s4s5_report.json');
  process.exit(0);
}

main().catch((e) => {
  console.error('s4s5Report 失败：', (e as Error).message);
  process.exit(1);
});
