# 股票代币跨所套利监控系统

跨交易所股票代币/永续套利的**监听→识别**系统。当前完成 **M0（行情采集+落盘）** 与 **M1（净edge引擎+基线+分级告警+资金费轮询）**。业务背景见 [`docs/需求文档...PRD.md`](docs/需求文档_股票代币套利系统PRD.md)，技术方案见 [`docs/开发文档_技术方案.md`](docs/开发文档_技术方案.md)。

## 快速开始

```bash
npm install
npm run typecheck            # tsc --noEmit
npm run collector            # M0：9路行情 → JSONL 落盘 + 完整率报表（Ctrl-C 停）
npm run engine               # M1：collector 超集，另加净edge引擎+告警+资金费
npm run validate:m1          # M1 验收：回放 minute_data_v3 对照 net_edge.csv
npm run report:s4s5          # S4/S5 实时结论（数据不足会如实标注）
npm run query                # duckdb 直查落盘 JSONL
npm run paper                # M2 纸面撮合（读 data/live tick JSONL；无数据则"数据不足"）
npm run test:paper           # M2 撮合核心确定性单测（滞后校正 naive/corrected）
npm run health               # 读完整率报表做健康检查（cron/监控用）
```

部署到服务器长跑见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)（pm2/systemd/健康检查/里程碑时钟）。

常用环境变量：`CONFIG`（默认 `monitor_config.json`）、`RUN_SECONDS`（跑 N 秒自停）、`REPORT_EVERY`（报表间隔秒）、`RECORD=0`（关落盘）、`ALERT_WEBHOOK`（告警 webhook 端点，用户自配才启用）。

## 架构

```
9路 feed(WS/REST) → Normalizer((sym,prod)BBO, 双时间戳, >0校验)
                         → Bus ┬→ Recorder(按日 JSONL, 跨日 gzip)
                               └→ NetEdgeEngine(可执行edge + 双轨基线 + 分级告警)
                                     ↑ FundingPoller(REST资金费 → net carry)
```

- **feeds**（照 `reference/ws_monitor.py` 规格用 TS 重写，非复用）：BN-FUT/SPOT、GATE-FUT/SPOT、BYBIT、OKX、MEXC-FUT、MEXC-SPOT(REST 2s)、HL。重连 5s、MEXC 15s ping、各所 keepalive、Bybit 本地簿、交易所事件时间提取。
- **落盘**：`data/live/YYYY-MM-DD/{prod}.jsonl`，每行 `{ts_exch,ts_recv,sym,prod,bid,ask}`（双时间戳，S4 跨所对齐用），跨 UTC 日 gzip 归档，duckdb 可直查。
- **引擎**：可执行净edge `= (bidA−askB)/mid×1e4 − takerA − takerB`；双轨基线（EWMA 与 240min 滚动中位，**均按分钟 bar 更新**）取保守 dev（两轨 |·| 较小者，宁漏勿误）；单tick尖刺过滤（连续确认）；腿陈旧>10s 丢弃；**HL 对休市（周五20:00–周日20:00 ET）冻结基线+暂停告警**。
- **告警**：EDGE（净edge>阈值）/ DEV（偏离>阈值）分级 → 控制台+CSV(`alerts.csv`)+webhook；同对同类有冷却。
- **资金费**：各所 REST 轮询当期费率 → 日化 bp 差（8h所×3、HL×24）→ 持仓对 net carry（按 side 对齐符号）。

## 配置说明（`monitor_config.json`）

原始文件提供符号映射（**严禁字符串拼接，Gate 混合命名 TSLAX_USDT/MU_USDT 全走映射表**）与 taker 费率。本次**追加**（未改动任何原值）：
- `maker_fee_bp` + `maker_min_profit_bp`：maker 阈值 `max(2×(makerA+makerB),0)+2` 所需（原文件只有 taker；来源 PRD §3.1 / `fees_api.json`）。
- `engine`：尖刺过滤/EWMA α/滚动窗口/陈旧阈值/告警冷却。
- `funding_poll`：轮询间隔与各所日结算次数。

## 验收状态

| 里程碑 | 验收标准 | 状态 |
|---|---|---|
| M0 | 9路 feed 连续运行、完整率>99%、duckdb 可查 | ✅ 代码就绪，9路实时连通、双时间戳落盘、duckdb 可查；**24h完整率数字需在服务器产出** |
| M1 | S1 告警频率与回测 2.6%±50% 吻合；产出 S4/S5 实时结论 | ✅ **validateM1：S1 复现 2.55% vs 2.57%，相对误差 0.6%**，费率表 0 处不符；S4/S5 报告就绪，**结论数字需服务器采集 ≥3 交易日+1 周末后产出** |

样例产物见 [`docs/samples/`](docs/samples/)。

## 部署注意

- **时区**：s4s5 报告已固定 duckdb `SET TimeZone='UTC'`；引擎 HL 休市判定用 ET（DST 感知）。服务器建议东京/新加坡（低延迟）。
- **只读**：`data/` 下历史回测数据只读，运行产物仅写 `data/live/`、`alerts.csv`、`run-state.db`。
- **上线前人工核实**（PRD §7）：MEXC 下单 API（S1/S2 生死项，M3 gate）、Gate maker 返佣、HL 实际 taker、OKX 充提。
- **观察项**（M1 审计遗留，需实时数据调参）：DEV 告警触发率（保守 dev 可能偏保守）；HL/Binance 资金费结算周期。

## M2 纸面撮合（已建，见 [docs/M2_设计_纸面撮合.md](docs/M2_设计_纸面撮合.md)）

- 统一撮合框架：**信号用 ts_recv 视图（含陈价）**，成交按订单 `t+rtt` 到达时刻的真实报价（第一条 `ts_exch≥t+rtt`）撮合；taker=对侧bbo+1bp，maker=挂bbo同侧+对侧穿越判成交。
- 两口径并行：**未校正 vs 校正后** PnL + 机会捕获 + maker 成交率对比；差值=陈价幻象。
- **S1/S2 进 M3 门槛**：校正后连续 ≥5 交易日纸面正收益（按美股交易日日历计数）。maker 成交率<30% 显式提示重估 S2。
- `tradeable` 双保险：mexcon=false，撮合层拒绝生成其腿。
- 滞后核心经确定性单测验证；PnL 四项归因（价差/手续费/滑点/资金费）总额自洽（手续费复算精确：S1 10bp/笔、S2 −2bp/笔返佣）。
- **真实 S1/S2 裁决数字需服务器回流足量真实 tick 后跑**；`docs/samples/M2_paper_report_SYNTHETIC_demo.json` 为合成机制演示（非裁决）。

## 后续里程碑
M3 executor+风控+kill switch+MEXC下单验证（S1/S2 生死项）；M4 白名单自动化+面板。
