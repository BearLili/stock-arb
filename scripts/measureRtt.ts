/**
 * 各所 REST 往返延迟实测 → 建议 config.rtt_ms（M2 滞后校正用）。
 * 在**目标服务器**上跑：npx tsx scripts/measureRtt.ts
 * 输出每所 median/p95 RTT 与一段可直接粘进 monitor_config.json 的 rtt_ms 块。
 *
 * 说明：这是**网络单程 REST RTT**，是真实下单 rtt 的下界（真单还含撮合处理）。
 *   保守起见建议用 median（或 median 上浮少量）。仅测网络，不下单、不需密钥。
 */
import { request } from 'undici';
import type { Prod } from '../src/types.js';

const N = Number(process.env.SAMPLES ?? 12);
const WARMUP = 2;

interface Probe {
  venue: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  prods: Prod[];
}

const PROBES: Probe[] = [
  { venue: 'binance-fapi', url: 'https://fapi.binance.com/fapi/v1/ping', prods: ['bnperp'] },
  { venue: 'binance-spot', url: 'https://api.binance.com/api/v3/ping', prods: ['bstocks'] },
  { venue: 'gate', url: 'https://api.gateio.ws/api/v4/spot/time', prods: ['gateperp', 'gstocks', 'xstocks'] },
  { venue: 'bybit', url: 'https://api.bybit.com/v5/market/time', prods: ['bybitx'] },
  { venue: 'okx', url: 'https://www.okx.com/api/v5/public/time', prods: ['okxx'] },
  { venue: 'mexc-contract', url: 'https://contract.mexc.com/api/v1/contract/ping', prods: ['mexcperp'] },
  { venue: 'mexc-spot', url: 'https://api.mexc.com/api/v3/ping', prods: ['mexcon'] },
  { venue: 'hyperliquid', url: 'https://api.hyperliquid.xyz/info', method: 'POST', body: '{"type":"meta"}', prods: ['hlperp'] },
];

function pctile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i]!;
}

async function measure(p: Probe): Promise<{ median: number; p95: number; n: number } | null> {
  const times: number[] = [];
  for (let i = 0; i < N; i += 1) {
    try {
      const t0 = performance.now();
      const res = await request(p.url, {
        method: p.method ?? 'GET',
        ...(p.body ? { headers: { 'content-type': 'application/json' }, body: p.body } : {}),
        headersTimeout: 8000,
        bodyTimeout: 8000,
      });
      await res.body.text(); // 消费 body 完成往返
      const dt = performance.now() - t0;
      if (i >= WARMUP) times.push(dt);
    } catch {
      /* 单次失败忽略 */
    }
  }
  if (times.length === 0) return null;
  times.sort((a, b) => a - b);
  return { median: Math.round(pctile(times, 0.5)), p95: Math.round(pctile(times, 0.95)), n: times.length };
}

async function main(): Promise<void> {
  if (!Number.isFinite(N) || N <= WARMUP) {
    console.error(`SAMPLES 需为 > ${WARMUP} 的整数（当前 ${process.env.SAMPLES ?? N}）。`);
    process.exit(1);
  }
  console.log(`各所 REST RTT 实测（每所 ${N} 次，去 ${WARMUP} 次预热）…\n`);
  const rtt: Record<string, number> = {};
  const rows: Array<Record<string, unknown>> = [];
  const failed: string[] = [];
  for (const p of PROBES) {
    const r = await measure(p);
    if (r) {
      for (const prod of p.prods) rtt[prod] = r.median;
      rows.push({ venue: p.venue, prods: p.prods.join(','), median_ms: r.median, p95_ms: r.p95, samples: r.n });
    } else {
      failed.push(...p.prods);
      rows.push({ venue: p.venue, prods: p.prods.join(','), median_ms: 'FAIL', p95_ms: '-', samples: 0 });
    }
  }
  console.table(rows);
  if (failed.length) {
    console.log(`\n⚠️ 以下所测量失败，rtt_ms 块缺这些键：${failed.join(', ')}`);
    console.log('   请勿整块替换 monitor_config.json（缺键会静默回退 100ms）——只合并已测到的键，失败的所稍后重测或手填。');
  } else {
    console.log('\n✅ 全部 10 个产品键均测到，可整块替换 monitor_config.json 的 rtt_ms（保守可各 +少量余量）：');
  }
  console.log('  "rtt_ms": ' + JSON.stringify(rtt) + ',');
  console.log('\n⚠️ 这是网络单程 RTT，是真实下单 rtt 的下界；mexcperp 的合约WS推送滞后请另用 collector 的 ts_exch skew 复测（见执行卡）。');
  process.exit(0);
}

main().catch((e) => {
  console.error('测量失败：', (e as Error).message);
  process.exit(1);
});
