# 股票代币跨所套利系统 — 需求文档（PRD）

版本 v1.0 ｜ 2026-07-22 ｜ 基于 2026-07-21/22 完成的多所调研与 7–90 天历史数据回测
本文档自包含：开发 agent 不需要访问原始对话即可理解全部背景。

---

## 1. 项目目标

构建一个监听→识别→（半自动到自动）执行的跨交易所股票类产品套利系统。标的为加密交易所上的"股票类目"产品：代币化股票现货与股票永续合约。核心逻辑：同一只美股在不同交易所、不同产品形态上并行定价，定价机制、费率、流动性差异产生可收割的价差与 carry。

已完成的量化验证（数据在 `gap_data/` 目录）表明：热门标的（TSLA/NVDA）价差已被套满（净空间≈0），**长尾高波动标的（SNDK 闪迪、MU 美光、CRCL）存在扣费后仍为正的系统性机会**。

## 2. 覆盖范围

### 2.1 标的（首发 5 个，可扩展）
TSLA、NVDA、MU（美光）、SNDK（闪迪）、CRCL（Circle）。
注意 2026-07 价位：MU ≈ $918、SNDK ≈ $1,497（存储超级周期，波动大——这正是机会来源）。

### 2.2 场所与产品（符号映射表，已全部验证可用）

| 产品键 | 场所/产品 | 符号示例 | 数据粒度 | 备注 |
|---|---|---|---|---|
| bstocks | Binance 现货 bStocks | TSLABUSDT | 1m | B后缀，BNB Chain代币 |
| gstocks | Gate 现货 gStocks | TSLAG_USDT | 1m | G后缀，Gate自营 |
| xstocks | Gate 现货 xStocks | TSLAX_USDT | 1m | 无MU/SNDK |
| bybitx | Bybit 现货 xStocks | TSLAXUSDT | 1m | 仅TSLA/NVDA/CRCL |
| okxx | OKX 现货代币化股票 | XTSLA-USDT | 1m(历史仅5m) | 2026-07-16上线 |
| mexcon | MEXC 现货 Ondo | TSLAONUSDT | 1m | 点差极宽，仅观察 |
| bnperp | Binance 股票永续 | TSLAUSDT | 1m | fapi |
| gateperp | Gate 股票永续 | TSLAX_USDT / MU_USDT / SNDK_USDT | 1m | 注意混合命名 |
| mexcperp | MEXC 股票永续 | SNDKSTOCK_USDT | 1m | 仅SNDK/CRCL |
| hlperp | Hyperliquid tradeXYZ 永续 | xyz:SNDK | WS实时(历史仅5m) | USDC计价，24/5 |

完整映射表见随附 `monitor_config.json`。

## 3. 机会清单（按优先级，全部为扣费后口径）

### 3.1 费率事实表（2026-07-22 实测/查证，taker bp/边）
bstocks 10（maker 0 促销至8/31）｜ gstocks/xstocks/bybitx 20 ｜ okxx 10 ｜ mexcon 5 ｜ bnperp 5(maker 2) ｜ **gateperp 7.5(maker −1 返佣，API实测)** ｜ **mexcperp 0/0（API实测，促销，会变）** ｜ hlperp ≈7(maker 1.5，含tradeXYZ分成，估计值需实盘核实)

### 3.2 资金费日均（近7天，%/天，正=多头付）
| | BN | Gate | MEXC | HL |
|---|---|---|---|---|
| TSLA | .0235 | .0187 | — | .0359 |
| NVDA | .0085 | .0061 | — | .0254 |
| MU | .0366 | .0373 | — | .0507 |
| SNDK | **.0729** | **.0963** | .0728 | .0624 |
| CRCL | .0262 | .0215 | .0262 | .0501 |

### 3.3 策略注册表

**S1【首发】SNDK/CRCL：BN永续 ↔ MEXC永续 均值回归**
- 依据：1m×7天数据，全taker往返成本仅10.2/13.0bp（MEXC零费，两边点差<3.3bp），偏离基线超全成本的分钟占 SNDK 2.6%、CRCL 1.0%；maker口径 9.7%/7.8%
- 逻辑：diff=premBN−premMEXC 对 240min 滚动基线的偏离超阈值→多便宜腿空贵腿→回归平仓
- 前置条件：⚠️ **MEXC 合约下单 API 官方标注"维护中"，必须先小单验证下单通道**（本策略最大执行风险）；MEXC 零费率促销结束即重算
- 失效条件：MEXC恢复收费使成本>20bp；偏离频率降至<0.5%

**S2【首发】SNDK：Gate永续 ↔ MEXC永续 基差+carry 双收**
- 依据：持续基差中位 +11.3bp（Gate贵）；maker-maker 往返成本为负（Gate返佣−1bp×2 + MEXC 0）；偏离机会分钟 50.8%；资金费差 Gate .0963 − MEXC .0728 = 2.35bp/天 → 空Gate多MEXC同时收基差回归+资金费差
- 前置条件：同S1的MEXC下单验证；Gate maker返佣以实盘成交确认
- 失效条件：基差中位收敛至<5bp或转负；资金费差反转

**S3【首发】SNDK carry 底仓：现货多 + 永续空**
- 依据：SNDK 资金费年化 22–35%；BN 站内 bStocks现货+SNDK永续，一次性成本≈10bp+点差，1.4天回本；或 Gate gStocks+Gate永续（资金费最高但现货费20bp）
- 前置：确认 bStocks 可用保证金效率（是否可作组合保证金）；分红/拆股事件日历接入（rebase乘数更新≈除息日前一天20:00 EST）
- 失效：资金费持续<0.02%/天

**S4【WS验证后启动】HL ↔ BN/Gate 永续**
- 依据：回测显示 SNDK 16%/MU 11% 分钟超taker成本，但 HL 历史数据仅5m粒度，偏离被高估——**必须用WS实时数据重测**（这是监控系统上线后第一个任务）；HL资金费系统性更高（空HL多BN另收carry：MU差1.4bp/天，CRCL差2.4bp/天）
- 注意：HL为USDC计价（含USDT/USD微基差）；tradeXYZ 周五20:00–周日20:00 ET休市，周末只能单腿持有BN侧
- 前置：WS实测真实同时点差；HL实际费率（含builder分成）小单核实

**S5【确认充提后启动】OKX 新区溢价收割**
- 依据：OKX 上市6天持续溢价（CRCL中位+14.3bp、SNDK+6.8bp、MU+8.8bp vs BN永续），新场所买盘驱动
- 路径：现货无法做空 → a) 持有xStocks库存者在OKX溢价卖出；b) 确认OKX的xStocks链上充值开放后：Gate/Bybit买入→充值OKX→卖出 闭环
- 前置：⚠️ 确认 OKX 代币化股票充提状态（调研时未公布）；确认OKX实际费率
- 时效：新区溢价通常随流动性成熟衰减，预计窗口数周——优先级高于其复杂度

**S6【观察池】** 开盘收敛（13:30 UTC，窗口约1分钟，需低延迟不适合首发）；bStocks↔真股转换锚定（需Binance合资格账户）；周末信号方向单；公司行为事件套利；跨版本基差（xStocks vs Ondo 漂移≈股息率）。

### 3.4 已排除
TSLA/NVDA 所有产品对（净空间≈0，最卷）；MEXC Ondo现货作交易腿（点差100bp+）；Gate现货腿的高频进出（20bp费率太贵，只适合carry持仓腿）。

## 4. 系统阶段划分

- **P0 数据与监听（第1周）**：9路WS接入、净edge引擎、告警、全量tick落盘。验收：与回测口径对齐，S1告警频率与回测2.6%误差<50%；产出S4/S5的实时数据结论
- **P1 纸面交易（第2周）**：信号→模拟成交（用对侧盘口价+费率）→ 模拟PnL 报表。验收：连续5个交易日纸面PnL为正且回撤可解释
- **P2 半自动执行（第3-4周）**：单边maker挂单+确认后对冲，人工点击确认；密钥只读→交易分级；风控（单笔/总敞口/日亏损上限/kill switch）。验收：真实小额（每笔<$500）10笔以上，滑点符合预期
- **P3 自动化**：白名单策略自动执行，异常自动平仓+降级到监控模式

## 5. 功能需求

FR1 多所WS行情接入（9路，断线重连、时钟偏移校正、陈旧数据丢弃>10s）
FR2 符号/产品映射统一（见config，注意Gate永续混合命名）
FR3 净edge引擎：可执行口径（bidA−askB−双边taker费），基线EWMA/滚动中位数双口径
FR4 资金费引擎：各所当期/预测资金费轮询，计入持仓对net carry
FR5 告警：分级（EDGE可执行/DEV偏离），通道：控制台+CSV+Telegram/webhook
FR6 全量数据落盘（tick级bbo+成交，Parquet按日分区）供策略迭代
FR7 纸面交易与真实执行共用同一策略接口（backtest/paper/live三模式）
FR8 执行：两腿协调（先难成交腿/先流动性差腿，对冲腿限时未成交则撤退平仓）、部分成交处理
FR9 风控：品种白名单、单笔上限、净敞口上限、日亏损熔断、API错误率熔断、周末HL休市敞口规则
FR10 报表：每日PnL归因（价差/资金费/手续费/滑点四项分解）

## 6. 非功能需求

延迟目标：信号计算<10ms（数据到达后）；监控可用性>99%（重连补偿）；密钥安全：环境变量+最小权限（禁提现权限）、执行与监控进程隔离；全部动作审计日志；服务器建议：低延迟优先选东京/新加坡机房（BN/Gate/Bybit主要撮合在亚洲），HL节点在东京。

## 7. 上线前人工验证清单（按顺序）

1. ☐ MEXC 合约下单API可用性（小单实测）——S1/S2的生死项
2. ☐ MEXC 股票永续零费率是否仍有效（每周复查）
3. ☐ Gate 永续 maker −0.01% 返佣实盘确认
4. ☐ HL tradeXYZ 实际taker费（含builder分成）小单实测
5. ☐ OKX 代币化股票充提是否开放、费率表
6. ☐ 各所目标标的的仓位/名义上限（Bybit xStocks单币30万USDT上限类似规则）
7. ☐ 账户地域合规：各所股票类产品的辖区白名单与本人账户资格
8. ☐ SNDK/MU 财报与公司行为日历（事件日风险）

## 8. 成功指标

P0：S4/S5结论产出（做/不做+参数）；P1：纸面夏普>2、单日最大回撤<2×日均盈利；P2：真实滑点≤纸面假设×1.5；P3：月化净收益/最大回撤>3，系统无人工干预连续运行>2周。

## 9. 随附资产（复用，勿重写）

- `gap_data/`：90天15m溢价序列(premium_data.json)、7天1m全产品溢价(minute_data_v3.json含10产品)、净edge回测(net_edge.csv)、盘口快照(book_snap*.json)、费率实测(fees_api.json)、资金费历史
- `ws_monitor.py` + `monitor_config.json`：可运行的监控原型（P0起点，含9路WS接入代码与坑位处理）
- `fetch_perp_data.py`/`analyze_gap.py`：历史数据拉取与gap分析脚本
- 交易所API坑位清单见《开发文档》第3节
