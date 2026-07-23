# M3 设计：Executor + 风控 + Kill Switch + 对账（仅设计，未实现）

配套 PRD §P2/FR8-FR9、开发文档 §5-§6。**本文过目批准后才写实盘代码。** 密钥禁提现权限，executor 与监控/告警进程物理隔离。

## 0. 第一公民执行路径：maker 挂单 → 即时 taker 对冲（S2v2/S1v2）

M2 漏斗证明双边 maker 脆弱（S2 单腿 67.9%）；应急对冲把它降到 0%。M3 executor 以此为**主执行原语**：

```
挂 primary(maker，吃返佣) ──成交──▶ 立即 taker 对冲 hedge(MEXC 0费必成交)
        │未成交(超时/被穿越走) 
        ▼
     撤单，本轮无仓（零敞口，非单腿）
```

其余策略映射到同一原语：S1v2=BN maker→MEXC taker；S3=现货 taker + 永续 taker（两腿都主动，无 maker 依赖）；S1/S2 原双边版仅作对照回测，实盘不用。

## 1. Executor 状态机（单个仓位实例）

```
              ┌─────────┐
              │  FLAT   │◀───────────────── 平仓完成 / 撤退完成
              └────┬────┘
      开仓 Intent  │
              ▼
        ┌────────────────┐  primary 撤单/超时   ┌──────────┐
        │ OPENING_MAKER  │────────────────────▶│  ABORTED │→ FLAT
        │ (挂 primary)   │                      └──────────┘
        └───────┬────────┘
     primary 成交(全部/部分)
              ▼
        ┌────────────────┐  hedge 成交   ┌──────────┐
        │  HEDGING       │──────────────▶│  HOLDING │
        │ (taker 对冲)   │               └────┬─────┘
        └───────┬────────┘                    │ 平仓 Intent
   hedge 超时未成交(1s)                        ▼
              ▼                          ┌────────────────┐
      ┌──────────────┐  市价强平先成交腿  │ CLOSING(同开仓  │
      │ EMERGENCY_    │──────────────────▶│  的镜像:maker→  │
      │ UNWIND        │  + 告警            │  taker 对冲)   │
      └──────────────┘ → FLAT            └───────┬────────┘
                                          平仓完成 ▼ → FLAT
```

- **部分成交**（开发文档 §5）：primary maker 部分成交 → hedge 只对冲**已成交数量**，剩余 primary 撤单；仓位以实际成交量为准进 HOLDING。
- **hedge 订单类型 = IOC（立即成交否则取消），非挂单**：primary 成交瞬间发 MEXC taker IOC 市价/激进限价，要么即时全成、要么即时返回未成交，**不留挂单、无迟到成交**。这样"超时"退化为"IOC 未全成"，从根上消除"撤单后迟到成交产生反向单腿"的竞态（审计 M-1）。
- **hedge 未全成（IOC 部分/未成）** → EMERGENCY_UNWIND：立即市价强平**未对冲的缺口数量**（gap = primary已成 − hedge已成），**保留已成功对冲的部分为合法两腿持仓**（不弃仓、不留裸 hedge 腿）+ 告警。这是唯一会吃亏的路径，须监控其频率（§2 有闸门）。若因回报延迟对 hedge 成交量存疑，以**交易所 REST 查实际成交为准**再决定强平数量，绝不凭本地假设。
- **不变量**：任一时刻净敞口 = primary 已成交 − hedge 已成交，且该差额在下一动作（补对冲 或 强平 primary）内被清零；executor 不允许该差额跨事件循环存活超过 `hedge_timeout_ms`。
- **平仓**用同一 maker→taker 原语；平仓 primary maker 超时未成交 → 降级为 taker 平仓（不容忍持仓卡住，与纸面"平仓卡住"对应的实盘兜底）。
- **幂等**：每个 order 带全局唯一 clientOrderId=`{strat}-{sym}-{posSeq}-{leg}-{openOrClose}`；重启后据此对账去重。

## 2. 风控闸门清单（下单前逐项检查，任一 fail 拒单；对照 FR9 / 开发文档 §6）

| 闸门 | 阈值(config，初始值) | 触发动作 |
|---|---|---|
| 品种白名单 | 仅 tradeable=true 且策略注册的对 | 拒单 |
| 单笔名义 | ≤ $500(P2)→$5,000(P3) | 拒单 |
| 单策略净敞口 | ≤ $20,000 | 拒新开，允许平 |
| 总净敞口 | ≤ $50,000 | 拒新开，允许平 |
| 日亏损熔断 | = 日均预期盈利×3 | **停所有新开 + 降级监控**，人工复位 |
| API 错误率 | 某所 >5 次/分钟 | 熔断该所 15min，其对暂停 |
| MEXC 新鲜度 | 该腿 ts_exch >2s 陈旧 | 拒该对下单（与告警门同源，第5项） |
| hedge 失败率 | EMERGENCY_UNWIND >N 次/时 | 暂停含该所 taker 对冲的策略 |
| 周末 HL 敞口 | 周五 19:00 ET 前 | 强制平所有含 HL 的对 |
| 事件日 | 财报/公司行为前 2h（SNDK/MU 日历） | 暂停该 sym 新开 |
| 时钟偏移 | 本地钟 vs 交易所 >100ms | 告警；>500ms 拒单（新鲜度门失真） |

风控为**独立闸门层**，在 Strategy→Intent 与 Executor→Order 之间；任何 Intent 必须过闸门才变 Order。

## 3. Kill Switch（最先实现并演练）

- **一键动作**：① 撤所有挂单 ② 市价平所有持仓 ③ executor 降级为"只读监控"模式（拒一切新单）。
- **触发**：人工命令 / 日亏损熔断 / API 错误率熔断 / 进程 watchdog 超时。
- **演练方案**（上线前必做，纸面+小额各一次）：
  1. 造一个持仓 → 手动触发 kill → 验证撤单+平仓完成、状态机回 FLAT、降级生效。
  2. 模拟某所 API 全错 → 验证错误率熔断→kill 链路。
  3. 断网 5s → 验证 watchdog 触发 kill、重连后不自动恢复交易（须人工复位）。
- **不可用即拒交易**：kill switch 自检失败 → executor 不允许进入 live 模式。

## 4. 对账与崩溃恢复

- **启动对账**：读本地状态库(better-sqlite3) 未完成 order → REST 查各所实际持仓+挂单 → 三方(本地/交易所/clientOrderId)对齐：
  - 交易所有、本地无 → 补记（可能是发单后崩溃）；
  - 本地有、交易所无 → 标记失败/撤销；
  - 数量不一致 → 以交易所为准，差额进 EMERGENCY_UNWIND 或告警人工。
- **状态库**：orders(clientOrderId PK, strat, sym, leg, side, type, qty, status, exch_order_id, ts) + positions + fills；每次状态转换落库（WAL），崩溃后可重放。
- **恢复后不自动开新仓**：对账完成→进入 HOLDING/FLAT 已知态→**人工确认后**才恢复策略开仓。

## 5. API Key 最小权限清单

| 用途 | 权限 | 禁止 |
|---|---|---|
| 监控(collector/engine) | 只读行情（多数所无需 key） | 一切交易/提现 |
| Executor 下单 | 现货/合约**交易**权限 | **提现**、划转到外部、API 改权限 |
| 资金费/对账查询 | 只读账户 | 交易、提现 |

- 每所两把 key：只读 key（监控/对账进程）与交易 key（executor 进程），**物理隔离不同进程/机器**。
- 交易 key 绑定 IP 白名单（服务器固定 IP）；提现权限一律关闭；密钥环境变量注入，不落盘、不进 git（`.env` 已 gitignore）。
- 定期轮换；泄露即吊销（因禁提现，泄露最坏是被恶意交易，kill switch + 敞口上限兜底）。

## 6. 与现有代码的接口（paper→live 复用）

- **Strategy 接口不变**（开发文档 §2）：onBbo/onFunding/onFill→Intent[]。M2 的 Leg.role(primary/hedge) 直接就是 executor 的挂单/对冲原语。
- 三模式同签名：backtest(minute_data) / paper(JSONL 回放，已完成) / live(executor)。live 只是把 paper 的 simulateFill 换成真实下单+回报。
- 纸面撮合器的 fill 语义（对侧穿越判成交、taker 对侧+1bp）是 live 成交预期的下界，实盘滑点须 ≤ 纸面×1.5（PRD P2 验收）。

## 7. 上线前人工验证顺序（对照 PRD §7，逐项打勾才进下一步）

1. ☐ MEXC 合约下单 API 可用性（小单实测）——S1v2/S2v2 对冲腿的生死项
2. ☐ Gate maker −0.01% 返佣实盘确认（S2v2 收益基础）
3. ☐ kill switch 三项演练通过
4. ☐ 对账恢复：手动 kill 进程后重启，状态正确恢复、不误开仓
5. ☐ 风控每道闸门单测 + 联调（造越界 Intent 验证被拒）
6. ☐ 真实小额（每笔<$500）≥10 笔，滑点 ≤ 纸面×1.5
7. ☐ API key 权限核对（提现已关、IP 白名单生效）

## 8. 不做（本期）
自动参数寻优上实盘（先人工定）；高频抢开盘；链上 DEX 腿。M3 只做"白名单策略半自动→自动执行 + 风控 + kill switch"，策略集 = 真实数据裁决通过的那几个变体。
