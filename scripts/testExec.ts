/**
 * M3 executor 自动化测试（确定性驱动全状态机 + kill switch 可重复演练）。
 * npx tsx scripts/testExec.ts；断言失败退出 1。
 */
import { Config } from '../src/config.js';
import { RiskGates } from '../src/exec/riskGates.js';
import { PaperVenueAdapter } from '../src/exec/paperVenue.js';
import { Executor, type OpenIntent } from '../src/exec/executor.js';
import { MemStore, reconcile } from '../src/exec/store.js';

let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log('✓ ' + msg);
  else { console.error('❌ ' + msg); failed += 1; }
}

const cfg = Config.load('monitor_config.json');

function harness() {
  let clock = 1_000_000;
  const adapter = new PaperVenueAdapter();
  const store = new MemStore();
  const gates = new RiskGates(cfg, {
    tradeablePairs: new Set(['gateperp-mexcperp', 'bnperp-mexcperp']),
    mexcStale: () => false,
    isHlClosingWindow: () => false,
    isEventBlackout: () => false,
  });
  const exec = new Executor(adapter, gates, cfg, store, () => clock);
  return {
    adapter, store, gates, exec,
    advance: (ms: number) => { clock += ms; },
    lastPlaced: () => adapter.placed[adapter.placed.length - 1]!,
  };
}

const S2V2: OpenIntent = { strategy: 'S2v2', sym: 'SNDK', primary: 'gateperp', hedge: 'mexcperp', primarySide: 'sell', qty: 1, notionalUsd: 400, primaryPrice: 1560 };

// 1) Happy path：maker成交→hedge IOC成交→HOLDING；平仓→FLAT
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  ok(r.ok && !!r.posId, '开仓过闸门，进 OPENING_MAKER');
  const primaryId = h.adapter.placed[0]!.clientOrderId;
  h.adapter.resolve(primaryId, 1, 1560, 'filled'); // primary maker 全成
  const hedgeId = h.lastPlaced().clientOrderId;
  ok(h.lastPlaced().type === 'ioc' && h.lastPlaced().prod === 'mexcperp', 'primary成交后发 hedge IOC(mexcperp)');
  h.adapter.resolve(hedgeId, 1, 1560, 'filled'); // hedge 全成
  ok(h.exec.positionsView()[0]!.state === 'HOLDING', '两腿到位→HOLDING');
  h.exec.closePosition(r.posId!, 1560);
  const closePrimId = h.lastPlaced().clientOrderId;
  h.adapter.resolve(closePrimId, 1, 1560, 'filled');
  const closeHedgeId = h.lastPlaced().clientOrderId;
  h.adapter.resolve(closeHedgeId, 1, 1560, 'filled');
  ok(h.exec.positionsView().length === 0, '平仓完成→FLAT(实例移除)');
}

// 2) maker 超时未成交 → ABORTED
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  h.advance(cfg.paper.maker_timeout_ms + 1000);
  h.exec.tick();
  ok(h.adapter.canceled.includes(`${r.posId}-P-open`), 'maker 超时→撤 primary');
  ok(h.store.transitionsOf(r.posId!).includes('OPENING_MAKER→ABORTED'), '→ABORTED');
  ok(h.exec.positionsView().length === 0, 'ABORTED 实例移除');
}

// 3) hedge 缺口 → EMERGENCY_UNWIND（唯一亏损路径）
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  h.adapter.resolve(h.adapter.placed[0]!.clientOrderId, 1, 1560, 'filled'); // primary 全成
  const hedgeId = h.lastPlaced().clientOrderId;
  h.adapter.resolve(hedgeId, 0.4, 1560, 'canceled'); // hedge IOC 只成 0.4 → 缺口 0.6
  ok(h.exec.positionsView()[0]!.state === 'EMERGENCY_UNWIND', 'hedge缺口→EMERGENCY_UNWIND');
  const unwindId = h.lastPlaced().clientOrderId;
  ok(h.lastPlaced().type === 'ioc' && Math.abs(h.lastPlaced().qty - 0.6) < 1e-9, '强平缺口 0.6(市价IOC)');
  ok(h.store.events.some((e) => e.type === 'emergency_unwind'), '记录 emergency_unwind');
  h.adapter.resolve(unwindId, 0.6, 1560, 'filled');
  // 强平只平未对冲缺口(0.6)，保留已对冲的 0.4 为合法两腿持仓（不弃仓/不留裸hedge）
  ok(h.exec.positionsView()[0]?.state === 'HOLDING' && Math.abs(h.exec.positionsView()[0]!.qty - 0.4) < 1e-9, '强平缺口后保留已对冲 0.4→HOLDING');
}

// 4) EMERGENCY_UNWIND 频率闸门：日内达 limit → 自动暂停策略
{
  const limit = cfg.risk.emergency_unwind_daily_limit;
  const h2 = harness();
  for (let i = 0; i < limit; i += 1) {
    const r = h2.exec.openPosition(S2V2);
    const primId = h2.adapter.placed.find((o) => o.clientOrderId === `${r.posId}-P-open`)!.clientOrderId;
    h2.adapter.resolve(primId, 1, 1560, 'filled');
    const hId = h2.lastPlaced().clientOrderId;
    h2.adapter.resolve(hId, 0, 1560, 'canceled'); // hedge 全失 → EMERGENCY_UNWIND
    const uId = h2.lastPlaced().clientOrderId;
    h2.adapter.resolve(uId, 1, 1560, 'filled');
  }
  ok(h2.gates.isPaused('S2v2'), `EMERGENCY_UNWIND 达 ${limit} 次→策略自动暂停`);
  const blocked = h2.exec.openPosition(S2V2);
  ok(!blocked.ok && /暂停/.test(blocked.reason ?? ''), '暂停后新开被拒');
}

// 5) 风控闸门拒单
{
  const h = harness();
  ok(!h.exec.openPosition({ ...S2V2, notionalUsd: 999999 }).ok, '单笔名义超限→拒');
  ok(!h.exec.openPosition({ ...S2V2, primary: 'mexcon', hedge: 'bnperp' }).ok, 'tradeable=false腿(mexcon)→拒');
  ok(!h.exec.openPosition({ ...S2V2, primary: 'gateperp', hedge: 'bstocks' }).ok, '非白名单对→拒');
}

// 6) Kill switch 演练（可重复测试用例）
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  h.adapter.resolve(h.adapter.placed[0]!.clientOrderId, 1, 1560, 'filled');
  h.adapter.resolve(h.lastPlaced().clientOrderId, 1, 1560, 'filled'); // HOLDING，净持仓 gate -1 / mexc +1
  const canceledBefore = h.adapter.canceled.length;
  h.exec.kill();
  ok(h.adapter.canceled.length > canceledBefore, 'kill：撤所有挂单');
  const flat = h.adapter.placed.filter((o) => o.clientOrderId.includes('killFlatten'));
  ok(flat.length >= 1, 'kill：对净持仓发市价强平单');
  ok(h.gates.isPaused('S2v2') === false && h.exec.positionsView().every((p) => p.state === 'KILLED'), 'kill：实例置 KILLED');
  const afterKill = h.exec.openPosition(S2V2);
  ok(!afterKill.ok && /kill/.test(afterKill.reason ?? ''), 'kill 后拒一切新单(降级监控)');
}

// 7) 对账
{
  const rec = reconcile(
    [{ sym: 'SNDK', prod: 'gateperp', qty: -1 }, { sym: 'SNDK', prod: 'mexcperp', qty: 1 }],
    [{ sym: 'SNDK', prod: 'gateperp', qty: -1 }, { sym: 'CRCL', prod: 'bnperp', qty: 2 }],
  );
  ok(rec.matched.length === 1 && rec.exchangeOnly.length === 1 && rec.localOnly.length === 1, '对账：matched/exchangeOnly/localOnly 分类正确');
  const rec2 = reconcile([{ sym: 'SNDK', prod: 'gateperp', qty: -1 }], [{ sym: 'SNDK', prod: 'gateperp', qty: -0.5 }]);
  ok(rec2.qtyMismatch.length === 1 && rec2.qtyMismatch[0]!.exchange === -1, '对账：数量不一致以交易所为准');
}

// 8) primary 分笔成交(同一时钟) → hedge id 不碰撞、逐笔对冲 → 全成 HOLDING（审计 C1）
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  const pid = h.adapter.placed[0]!.clientOrderId;
  h.adapter.resolve(pid, 0.5, 1560, 'partial'); // 第一笔 0.5（同一 ms）
  const hedge1 = h.lastPlaced().clientOrderId;
  h.adapter.resolve(hedge1, 0.5, 1560, 'filled');
  h.adapter.resolve(pid, 1.0, 1560, 'filled'); // 第二笔到 1.0（同一 ms，id 必须不碰撞）
  const hedge2 = h.lastPlaced().clientOrderId;
  ok(hedge2 !== hedge1, 'primary 分笔→两张 hedge id 不碰撞(C1)');
  h.adapter.resolve(hedge2, 0.5, 1560, 'filled');
  ok(h.exec.positionsView()[0]?.state === 'HOLDING' && Math.abs(h.exec.positionsView()[0]!.qty - 1) < 1e-9, '分笔全成对冲→HOLDING(1.0)');
}

// 9) hedge IOC 多回报(partial→canceled) 不双计（审计 H2）
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  h.adapter.resolve(h.adapter.placed[0]!.clientOrderId, 1, 1560, 'filled');
  const hId = h.lastPlaced().clientOrderId;
  h.adapter.resolve(hId, 0.4, 1560, 'partial'); // 累计 0.4
  h.adapter.resolve(hId, 0.4, 1560, 'canceled'); // 同一单终态，仍累计 0.4（不应变 0.8）
  const uId = h.lastPlaced().clientOrderId;
  ok(h.lastPlaced().type === 'ioc' && Math.abs(h.lastPlaced().qty - 0.6) < 1e-9, 'hedge 多回报不双计→强平缺口=0.6(非0.2)');
  h.adapter.resolve(uId, 0.6, 1560, 'filled');
}

// 10) primary 部分成交后 maker 超时 → 收敛 HOLDING（审计 H4：不卡死）
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  h.adapter.resolve(h.adapter.placed[0]!.clientOrderId, 0.5, 1560, 'partial');
  h.adapter.resolve(h.lastPlaced().clientOrderId, 0.5, 1560, 'filled'); // 0.5 已对冲
  h.advance(cfg.paper.maker_timeout_ms + 1000);
  h.exec.tick();
  ok(h.adapter.canceled.includes(`${r.posId}-P-open`), '部分成交后超时→撤剩余 primary');
  ok(h.exec.positionsView()[0]?.state === 'HOLDING' && Math.abs(h.exec.positionsView()[0]!.qty - 0.5) < 1e-9, '按已成量收敛→HOLDING(0.5)，不卡死');
  h.exec.closePosition(r.posId!, 1560);
  ok(h.exec.positionsView()[0]?.state === 'CLOSING', '收敛后可正常平仓');
}

// 11) CLOSING maker 超时 → 降级 taker 一次（审计 H1：tsClose 计时、不逐 tick 重复强平）
{
  const h = harness();
  const r = h.exec.openPosition(S2V2);
  h.adapter.resolve(h.adapter.placed[0]!.clientOrderId, 1, 1560, 'filled');
  h.adapter.resolve(h.lastPlaced().clientOrderId, 1, 1560, 'filled'); // HOLDING
  h.advance(cfg.paper.max_hold_min * 60000); // 持仓很久（验证用 tsClose 而非 tsOpen 计时）
  h.exec.closePosition(r.posId!, 1560);
  const beforeTick = h.adapter.placed.length;
  h.exec.tick(); // 刚 close，未超 tsClose，不应降级
  ok(h.adapter.placed.length === beforeTick, 'close 后立刻 tick 不误降级(用 tsClose 计时)');
  h.advance(cfg.paper.maker_timeout_ms + 1000);
  h.exec.tick();
  h.exec.tick();
  h.exec.tick(); // 多打几次
  const unwinds = h.adapter.placed.filter((o) => o.clientOrderId.includes('primaryCloseFlatten'));
  ok(unwinds.length === 1, 'CLOSING 超时只降级 taker 一次（不逐 tick 重复强平）');
}

// 12) kill 面对本地无匹配的交易所净持仓(孤儿仓)也强平（审计 M2）
{
  const h = harness();
  // 直接在 adapter 造一个孤儿净持仓（无 executor 实例）
  h.adapter.place({ clientOrderId: 'orphan-1', sym: 'MU', prod: 'bnperp', side: 'buy', type: 'ioc', qty: 2, role: 'primary' });
  h.adapter.resolve('orphan-1', 2, 900, 'filled'); // MU bnperp +2 净持仓，无本地实例
  h.exec.kill();
  const kf = h.adapter.placed.filter((o) => o.clientOrderId.includes('killFlatten') && o.sym === 'MU');
  ok(kf.length === 1 && kf[0]!.side === 'sell' && Math.abs(kf[0]!.qty - 2) < 1e-9, 'kill：孤儿净持仓(MU+2)也被市价强平(sell 2)');
}

// 13) 敞口闸门带电（审计 M1）：持仓后策略净敞口累计 → 超限拒新开
{
  const lowCfg = cfg.override({ risk: { max_strategy_exposure_usd: 500 } });
  let clock = 2_000_000;
  const adapter = new PaperVenueAdapter();
  const gates = new RiskGates(lowCfg, { tradeablePairs: new Set(['gateperp-mexcperp']), mexcStale: () => false, isHlClosingWindow: () => false, isEventBlackout: () => false });
  const exec = new Executor(adapter, gates, lowCfg, new MemStore(), () => clock);
  const r1 = exec.openPosition(S2V2); // 400
  adapter.resolve(adapter.placed[0]!.clientOrderId, 1, 1560, 'filled');
  adapter.resolve(adapter.placed[adapter.placed.length - 1]!.clientOrderId, 1, 1560, 'filled'); // HOLDING → 敞口 400
  const r2 = exec.openPosition(S2V2); // 400+400=800 > 500 → 拒
  ok(r1.ok && !r2.ok && /敞口/.test(r2.reason ?? ''), '持仓后敞口累计→超策略上限拒新开(M1闸门带电)');
}

console.log(failed === 0 ? '\n✅ executor 全部通过' : `\n❌ ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
