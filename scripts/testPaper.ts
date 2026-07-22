/**
 * M2 撮合核心的确定性单测（重点：滞后校正的 naive vs corrected）。
 * 用 npx tsx scripts/testPaper.ts 跑；断言失败退出 1。
 */
import { Config } from '../src/config.js';
import { Replay } from '../src/paper/replay.js';
import { simulateFill } from '../src/paper/fill.js';
import type { Prod } from '../src/types.js';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('❌ ' + msg);
    failed += 1;
  } else {
    console.log('✓ ' + msg);
  }
}
function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
}

const cfg = Config.load('monitor_config.json');
// mexcperp rtt=300, taker slippage 1bp（来自 config）
const SYM = 'SNDK';
const P: Prod = 'mexcperp';

// 墙钟时间线（ms）：MEXC 滞后 1900ms。价格在决策后"真实"已上移。
// A: 事件1000/接收2900 价100 ；B: 事件3200/接收5100 价102 ；C: 事件3400/接收5300 价103
const rows = [
  { sym: SYM, prod: P, tsExch: 1000, tsRecv: 2900, bid: 99.95, ask: 100.05 },
  { sym: SYM, prod: P, tsExch: 3200, tsRecv: 5100, bid: 101.95, ask: 102.05 },
  { sym: SYM, prod: P, tsExch: 3400, tsRecv: 5300, bid: 102.95, ask: 103.05 },
];
const replay = Replay.fromQuotes(rows);

// 决策 t=3000（ts_recv 视图只能看到 A，事件时间1000，已陈 ~2s）
const t = 3000;
const naiveBuy = simulateFill(replay, cfg, SYM, { prod: P, side: 'buy', type: 'taker' }, t, 'naive');
const corrBuy = simulateFill(replay, cfg, SYM, { prod: P, side: 'buy', type: 'taker' }, t, 'corrected');

assert(naiveBuy.filled && corrBuy.filled, 'taker 两口径都成交');
// naive 看到陈价 A：ask 100.05 + 1bp
assert(near(naiveBuy.fillPrice!, 100.05 * 1.0001), `naive 买入=陈价100.05+1bp (实得 ${naiveBuy.fillPrice?.toFixed(4)})`);
// corrected 订单3000+300=3300到达，第一条 ts_exch≥3300 = C(3400)，ask 103.05 + 1bp
assert(near(corrBuy.fillPrice!, 103.05 * 1.0001), `corrected 买入=真实到达价103.05+1bp (实得 ${corrBuy.fillPrice?.toFixed(4)})`);
// 陈价幻象：corrected 比 naive 贵 ~3（买在更高价）
assert(corrBuy.fillPrice! - naiveBuy.fillPrice! > 2.9, `陈价幻象量化: corrected−naive=${(corrBuy.fillPrice! - naiveBuy.fillPrice!).toFixed(3)} (>2.9)`);

// BN 腿 rtt=50，滞后小：naive 与 corrected 价格应接近（陈价幻象很小）
const BN: Prod = 'bnperp';
const bnRows = [
  { sym: SYM, prod: BN, tsExch: 2980, tsRecv: 3000, bid: 200, ask: 200.02 },
  { sym: SYM, prod: BN, tsExch: 3060, tsRecv: 3080, bid: 200.01, ask: 200.03 }, // ts_exch≥3050，价几乎没动
];
const bnReplay = Replay.fromQuotes(bnRows);
const bnNaive = simulateFill(bnReplay, cfg, SYM, { prod: BN, side: 'sell', type: 'taker' }, 3000, 'naive');
const bnCorr = simulateFill(bnReplay, cfg, SYM, { prod: BN, side: 'sell', type: 'taker' }, 3000, 'corrected');
assert(bnNaive.filled && bnCorr.filled, 'BN taker 两口径成交');
assert(near(bnNaive.fillPrice!, 200 * 0.9999), `BN naive 卖=200−1bp (实得 ${bnNaive.fillPrice?.toFixed(4)})`);
assert(Math.abs(bnCorr.fillPrice! - bnNaive.fillPrice!) < 0.02, `BN 低滞后：corrected≈naive (差 ${Math.abs(bnCorr.fillPrice! - bnNaive.fillPrice!).toFixed(4)})`);

// maker 穿越判定：挂 bid=100，之后 ask≤100 才成交
const mkRows = [
  { sym: SYM, prod: BN, tsExch: 1000, tsRecv: 1000, bid: 100, ask: 100.1 },
  { sym: SYM, prod: BN, tsExch: 2000, tsRecv: 2000, bid: 99.8, ask: 99.95 }, // ask 99.95 ≤ 100 → 穿越
];
const mkReplay = Replay.fromQuotes(mkRows);
const mk = simulateFill(mkReplay, cfg, SYM, { prod: BN, side: 'buy', type: 'maker' }, 1000, 'naive');
assert(mk.filled, 'maker 挂 bid=100 被后续 ask=99.95 穿越 → 成交');
assert(near(mk.fillPrice!, 100), `maker 以挂价100成交 (实得 ${mk.fillPrice})`);

// maker 超时不成交：对侧始终不穿越
const mkRows2 = [
  { sym: SYM, prod: BN, tsExch: 1000, tsRecv: 1000, bid: 100, ask: 100.1 },
  { sym: SYM, prod: BN, tsExch: 2000, tsRecv: 2000, bid: 100.05, ask: 100.2 }, // ask 100.2 > 100 不穿越
];
const mkNo = simulateFill(Replay.fromQuotes(mkRows2), cfg, SYM, { prod: BN, side: 'buy', type: 'maker' }, 1000, 'naive');
assert(!mkNo.filled, 'maker 对侧不穿越 → 超时未成交');

// tradeable：mexcon=false
assert(cfg.tradeable('mexcon') === false, 'config: mexcon tradeable=false');
assert(cfg.tradeable('mexcperp') === true, 'config: mexcperp tradeable=true');
assert(cfg.rttMs('mexcperp') === 300 && cfg.rttMs('bnperp') === 50, 'config: rtt mexcperp=300 bnperp=50');

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
