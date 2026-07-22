/**
 * M1 验收：用引擎的基线口径回放 data/minute_data_v3.json，对照 data/net_edge.csv。
 *
 * 口径（与回测严格一致，已核对可复现）：
 *   d 序列为溢价 deci-bp（÷10 → bp）；diff = d[a]−d[b]；
 *   基线 = 240min 滚动中位（min 60 样本，rollingMedianOffline，与 engine 共用 median()）；
 *   dev = diff − baseline；
 *   exc_taker = %{ |dev| > cost_taker }，cost_taker 取 net_edge 列（= 2×(takerA+takerB)+spread_sum）；
 *   exc_maker = %{ |dev| > threshold_maker }，threshold_maker = max(2×(makerA+makerB),0)+2（修正#1）。
 *
 * 验收断言（开发文档 §7）：S1 = SNDK bnperp-mexcperp 的 exc_taker 与回测 2.6% 相对误差 <50%。
 * 同时：① 用 config 费率重算 cost_taker 对照 net_edge 列（费率表校验）；② 复现 exc_maker。
 * data/ 只读，不改动。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Config } from '../src/config.js';
import type { Prod } from '../src/types.js';
import { rollingMedianOffline, median } from '../src/engine/baseline.js';

const SCALE = 10; // deci-bp → bp
const WINDOW = 240;
const MIN_SAMPLES = 60;

interface NetEdgeRow {
  sym: string;
  pair: string;
  a: Prod;
  b: Prod;
  n: number;
  diffMed: number;
  spreadSumBp: number;
  costTakerBp: number;
  excTakerPct: number;
  excMakerPct: number;
}

interface ProductData {
  d: Array<number | null>;
}
interface SymData {
  products: Record<string, ProductData>;
}
type MinuteData = Record<string, SymData>;

function parseNetEdge(path: string): NetEdgeRow[] {
  const text = readFileSync(path, 'utf8').trim();
  const lines = text.split('\n');
  const rows: NetEdgeRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i]!.split(',');
    const pair = c[1]!;
    const [a, b] = pair.split('-') as [Prod, Prod];
    rows.push({
      sym: c[0]!,
      pair,
      a,
      b,
      n: Number(c[2]),
      diffMed: Number(c[3]),
      spreadSumBp: Number(c[6]),
      costTakerBp: Number(c[7]),
      excTakerPct: Number(c[8]),
      excMakerPct: Number(c[9]),
    });
  }
  return rows;
}

function reproduce(
  cfg: Config,
  data: MinuteData,
  row: NetEdgeRow,
): {
  ok: boolean;
  reason?: string;
  n?: number;
  diffMed?: number;
  costMine?: number;
  excTaker?: number;
  excMaker?: number;
  makerThr?: number;
} {
  const sym = data[row.sym];
  if (!sym) return { ok: false, reason: 'sym缺失' };
  const pa = sym.products[row.a];
  const pb = sym.products[row.b];
  if (!pa || !pb) return { ok: false, reason: `产品缺失(${!pa ? row.a : row.b})` };
  const da = pa.d;
  const db = pb.d;
  const len = Math.min(da.length, db.length);
  const diff: Array<number | null> = new Array(len);
  for (let i = 0; i < len; i += 1) {
    const x = da[i];
    const y = db[i];
    diff[i] = x === null || x === undefined || y === null || y === undefined ? null : (x - y) / SCALE;
  }
  const base = rollingMedianOffline(diff, WINDOW, MIN_SAMPLES);
  const devs: number[] = [];
  for (let i = 0; i < len; i += 1) {
    if (diff[i] !== null && base[i] !== null) devs.push((diff[i] as number) - (base[i] as number));
  }
  const validDiffs = diff.filter((v): v is number => v !== null);
  const costMine = cfg.roundTripTakerCostBp(row.a, row.b, row.spreadSumBp);
  const makerThr = cfg.makerThresholdBp(row.a, row.b);
  const excTaker = (100 * devs.filter((v) => Math.abs(v) > row.costTakerBp).length) / devs.length;
  const excMaker = (100 * devs.filter((v) => Math.abs(v) > makerThr).length) / devs.length;
  return {
    ok: true,
    n: devs.length,
    diffMed: median(validDiffs) ?? NaN,
    costMine,
    excTaker,
    excMaker,
    makerThr,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function main(): void {
  const cfg = Config.load(process.env.CONFIG ?? 'monitor_config.json');
  const data = JSON.parse(readFileSync('data/minute_data_v3.json', 'utf8')) as MinuteData;
  const rows = parseNetEdge('data/net_edge.csv');

  const out: string[] = [];
  out.push(
    `${pad('sym', 5)} ${pad('pair', 20)} ${padL('n', 6)} ${padL('diffMed', 8)}/${padL('ref', 6)} ${padL('cost', 6)}/${padL('ref', 6)} ${padL('excTk', 6)}/${padL('ref', 6)} ${padL('Δ%', 6)} ${padL('excMk', 6)}/${padL('ref', 6)}`,
  );
  let costMismatches = 0;
  let takerWithin50 = 0;
  let takerComparable = 0;
  const results: Array<Record<string, unknown>> = [];
  let s1: { repro: number; ref: number; relErr: number } | null = null;

  for (const row of rows) {
    const r = reproduce(cfg, data, row);
    if (!r.ok) {
      out.push(`${pad(row.sym, 5)} ${pad(row.pair, 20)} —— 跳过: ${r.reason}`);
      results.push({ sym: row.sym, pair: row.pair, skipped: r.reason });
      continue;
    }
    const costMatch = Math.abs((r.costMine as number) - row.costTakerBp) < 0.05;
    if (!costMatch) costMismatches += 1;
    // 相对误差（回测 exc_taker>0 时才有意义）
    let relErr = NaN;
    if (row.excTakerPct > 0) {
      relErr = Math.abs((r.excTaker as number) - row.excTakerPct) / row.excTakerPct;
      takerComparable += 1;
      if (relErr < 0.5) takerWithin50 += 1;
    }
    if (row.sym === 'SNDK' && row.pair === 'bnperp-mexcperp') {
      s1 = { repro: r.excTaker as number, ref: row.excTakerPct, relErr };
    }
    out.push(
      `${pad(row.sym, 5)} ${pad(row.pair, 20)} ${padL(String(r.n), 6)} ${padL((r.diffMed as number).toFixed(1), 8)}/${padL(row.diffMed.toFixed(1), 6)} ${padL((r.costMine as number).toFixed(1), 6)}/${padL(row.costTakerBp.toFixed(1), 6)} ${padL((r.excTaker as number).toFixed(2), 6)}/${padL(row.excTakerPct.toFixed(2), 6)} ${padL(Number.isNaN(relErr) ? '—' : (relErr * 100).toFixed(0), 6)} ${padL((r.excMaker as number).toFixed(2), 6)}/${padL(row.excMakerPct.toFixed(2), 6)}`,
    );
    results.push({
      sym: row.sym,
      pair: row.pair,
      n: r.n,
      diffMed_repro: Number((r.diffMed as number).toFixed(2)),
      diffMed_ref: row.diffMed,
      cost_repro: Number((r.costMine as number).toFixed(2)),
      cost_ref: row.costTakerBp,
      excTaker_repro: Number((r.excTaker as number).toFixed(3)),
      excTaker_ref: row.excTakerPct,
      excTaker_relErr: Number.isNaN(relErr) ? null : Number(relErr.toFixed(3)),
      excMaker_repro: Number((r.excMaker as number).toFixed(3)),
      excMaker_ref: row.excMakerPct,
      makerThr: r.makerThr,
    });
  }

  console.log(out.join('\n'));
  console.log('');
  console.log(`费率表校验：cost_taker 用 config 费率重算，与 net_edge 列不符的行数 = ${costMismatches} (期望 0)`);
  console.log(`exc_taker 相对误差 <50% 的行：${takerWithin50}/${takerComparable} (仅统计回测 exc_taker>0 的对)`);
  console.log(
    '注：exc_maker 两列口径不同、不可直接对比——本列用修正#1 的 maker 阈值 max(2×(makerA+makerB),0)+2（不含点差），' +
      'net_edge 列含点差且对 mexcon/okxx 现货腿用了不同 maker 率；perp-perp 对（含 S2 gateperp-mexcperp）吻合，' +
      'mexcon/okxx 观察腿(PRD §3.4 已排除)背离属预期。exc_maker 不计入验收门槛。',
  );

  if (!s1) {
    console.error('❌ 未找到 S1 行 (SNDK bnperp-mexcperp)');
    process.exit(1);
  }
  const pass = s1.relErr < 0.5 && costMismatches === 0;
  console.log('');
  console.log(
    `【S1 验收】SNDK bnperp-mexcperp: 复现 ${s1.repro.toFixed(2)}% vs 回测 ${s1.ref.toFixed(2)}% ` +
      `(相对误差 ${(s1.relErr * 100).toFixed(1)}%, 阈值<50%) → ${s1.relErr < 0.5 ? '通过' : '未通过'}`,
  );
  console.log(`【总判定】${pass ? '✅ M1 验收通过' : '❌ M1 验收未通过'}`);

  mkdirSync('docs/samples', { recursive: true });
  writeFileSync(
    'docs/samples/M1_validate_output.json',
    JSON.stringify(
      {
        generatedNote: '回放 minute_data_v3.json 对照 net_edge.csv 的 M1 验收输出',
        s1,
        costMismatches,
        takerWithin50,
        takerComparable,
        pass,
        rows: results,
      },
      null,
      2,
    ),
  );

  process.exit(pass ? 0 : 1);
}

main();
