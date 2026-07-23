/**
 * 合成 tick 生成器（仅供 M2 机制演示，非真实数据）。
 * 从 data/minute_data_v3.json 的逐分钟溢价展开成 tick 级 BBO JSONL（落盘格式一致），
 * 给 mexcperp 注入实测量级的可变滞后（0.3–3.2s），BN/Gate 注入 ~20–60ms。
 * 输出到 data/synth_live/（与真实 data/live 分开）。
 *   npx tsx scripts/genSyntheticTicks.ts && LANDING=data/synth_live npm run paper
 * ⚠️ 合成 PnL 不是 S1/S2 进 M3 的裁决数字——那必须用服务器回流的真实 tick。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 可复现的 LCG（不依赖 Math.random）
let seed = 12345;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const BASE: Record<string, number> = { SNDK: 1560, CRCL: 68.7, MU: 949 };
// 点差校准自 book_snap 实测（SNDK）：mexcperp 0.06bp(Boss实测)、bnperp 0.06、gateperp 0.71、bstocks 3.85、gstocks 13.91
const SPREAD_BP: Record<string, number> = { bnperp: 0.06, mexcperp: 0.06, gateperp: 0.71, bstocks: 3.85, gstocks: 13.91 };
const PRODS = ['bnperp', 'mexcperp', 'gateperp', 'bstocks', 'gstocks'] as const;
const SYMS = ['SNDK', 'CRCL', 'MU'] as const;
const TICKS_PER_MIN = 4;

interface MinuteData {
  [sym: string]: { ts0: number; products: Record<string, { d: Array<number | null> }> };
}

/** 返回该 prod 的事件时间偏移(ms)；bstocks(BN现货)无 ts_exch → null */
function lagMs(prod: string): number | null {
  if (prod === 'bstocks') return null; // BN 现货 bookTicker 无事件时间(与真实一致)
  // 注：gstocks(Gate现货)有事件时间 → 走下方 else 带 lag，与真实 Gate spot.book_ticker.t 一致
  if (prod === 'mexcperp') return Math.round(300 + rnd() * 2900); // 0.3–3.2s
  return Math.round(20 + rnd() * 40); // 20–60ms
}

function main(): void {
  const data = JSON.parse(readFileSync('data/minute_data_v3.json', 'utf8')) as MinuteData;
  const root = 'data/synth_live';
  // 按 day|prod 缓冲
  const buf = new Map<string, string[]>();
  let lines = 0;

  for (const sym of SYMS) {
    const s = data[sym];
    if (!s) continue;
    const base = BASE[sym]!;
    for (const prod of PRODS) {
      const p = s.products[prod];
      if (!p) continue;
      const d = p.d;
      for (let i = 0; i < d.length - 1; i += 1) {
        const cur = d[i];
        const nxt = d[i + 1] ?? cur;
        if (cur === null || cur === undefined) continue;
        for (let k = 0; k < TICKS_PER_MIN; k += 1) {
          // 分钟内线性插值，制造 lag 窗口内的真实价格移动
          const frac = k / TICKS_PER_MIN;
          const premBp = ((cur as number) * (1 - frac) + (nxt === null ? (cur as number) : (nxt as number)) * frac) / 10; // deci-bp→bp
          const mid = base * (1 + premBp / 1e4);
          const half = (SPREAD_BP[prod]! / 2 / 1e4) * mid;
          const tsRecv = (s.ts0 + i * 60 + k * 15) * 1000;
          const lag = lagMs(prod);
          const tsExch = lag === null ? null : tsRecv - lag;
          const day = new Date(tsRecv).toISOString().slice(0, 10);
          const key = `${day}|${prod}|${sym}`;
          const arr = buf.get(key) ?? buf.set(key, []).get(key)!;
          arr.push(JSON.stringify({ ts_exch: tsExch, ts_recv: tsRecv, sym, prod, bid: mid - half, ask: mid + half }));
          lines += 1;
        }
      }
    }
  }

  // 落盘：data/synth_live/<day>/<prod>.jsonl（同一 prod 多 sym 合并）
  const byDayProd = new Map<string, string[]>();
  for (const [key, arr] of buf) {
    const [day, prod] = key.split('|');
    const k2 = `${day}|${prod}`;
    const merged = byDayProd.get(k2) ?? byDayProd.set(k2, []).get(k2)!;
    merged.push(...arr);
  }
  for (const [k2, arr] of byDayProd) {
    const [day, prod] = k2.split('|');
    const dir = join(root, day!);
    mkdirSync(dir, { recursive: true });
    // 按 ts_recv 排序（同 prod 跨 sym 合并后）
    arr.sort((a, b) => (JSON.parse(a).ts_recv as number) - (JSON.parse(b).ts_recv as number));
    writeFileSync(join(dir, `${prod}.jsonl`), arr.join('\n') + '\n');
  }
  console.log(`合成完成：${lines} 条 tick → ${root}/（${byDayProd.size} 个 day×prod 文件）`);
  console.log('运行：LANDING=data/synth_live npm run paper');
}

main();
