# MEXC 行情滞后定位（S1/S2 执行风险）

日期：2026-07-22 ｜ 数据源：本地 collector 落盘的 `ts_exch`（交易所事件时间）与 `ts_recv`（本地接收时间）双时间戳，滞后 = `ts_recv − ts_exch`。

## 结论：滞后来自 mexcperp 合约 WS（严重），非 mexcon REST

| MEXC 通道 | 产品 | 滞后中位 | p95 | max | min | 性质 |
|---|---|---|---|---|---|---|
| **mexcperp（contract.mexc.com/edge WS）** | SNDK | **1956ms** | 3133ms | 3240ms | 343ms | 🔴 严重：合约 WS 自身滞后 |
| **mexcperp（同上）** | CRCL | **1963ms** | 2986ms | 3130ms | 270ms | 🔴 同上 |
| mexcon（api.mexc.com REST 轮询 2s） | 全部 | 无 `ts_exch`（REST 无事件时间） | — | — | — | 预期内：2s 轮询，且为观察腿(PRD §3.4 已排除) |

- SNDK/CRCL 正是 **S1（BN↔MEXC 永续均值回归）与 S2（Gate↔MEXC 基差+carry）的 MEXC 腿**。
- 滞后分布 ~0.3s–3.2s、**高度可变**（非固定偏移）——固定 offset 校正不够，必须按分布重放。

## 为什么这是"陈价幻象"风险

对 S1/S2，可执行 edge = `(bidMEXC − askBN)/mid×1e4 − 费`。若 mexcperp 的 bid/ask 反映的是 ~2s 前的价，而 BN 已移动，则监控端算出的 edge 是"拿旧 MEXC 价 vs 新 BN 价"的伪价差——真下单时 MEXC 价早已变，edge 不可成交。回测（net_edge.csv）用对齐的 1m bar，天然掩盖了这 ~2s 腿间错位。

## 时钟校验（排除时钟偏移解释）

同批次 BN-FUT 滞后中位 −28ms、Gate −30ms → 本地时钟与 BN/Gate 服务器对齐在几十 ms 内。故 mexcperp 的 +1.9s **是真实数据延迟**，不是本地时钟慢。滞后有分布（med 1.9s / p95 3s）而非常数，也印证是可变网络+服务端推送延迟，非固定钟差。

## 部署差异提示（须服务器复测）

本测量在本地开发机（darwin）。东京/SG 服务器到 MEXC（撮合在亚洲）网络 RTT 更低，**滞后分布可能显著改善**——但 MEXC 合约 WS 若存在服务端批量推送延迟，则与地理位置无关。**权威滞后分布须在服务器上复测**；本文结论（滞后在 mexcperp WS、且可变）方向性成立。

## 对下游的强制影响

1. **告警（已落地，第5项）**：含 MEXC 腿的对，EDGE 告警要求该腿 `ts_exch` 新鲜度 ≤ `mexc_edge_stale_ms`(默认2000ms)，否则降级为 DEV（标记 `stale_downgrade`）。避免监控端把陈价 edge 当真机会。
2. **M2 纸面撮合（待建，第3/4项）**：MEXC 腿必须以 `ts_exch + 实测滞后分布` 重放建模；M2 报告须给"滞后校正前后"的 S1/S2 纸面收益对比——该数字直接决定 S1/S2 能否进 M3。
