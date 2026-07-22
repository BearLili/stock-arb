# 部署运维手册（东京/SG 服务器）

> 我（开发方）无你服务器的访问权，**无法代为执行部署**。以下为开箱即用步骤，你在有 SSH 后按此操作，单机纯手动预计 **10–15 分钟**起跑。

## 0. 选址与前置
- 机房：东京/新加坡（BN/Gate/Bybit 撮合主要在亚洲，HL 节点东京，MEXC 亚洲）——**顺带会显著改善本地实测的 mexcperp ~1.9s 滞后**（须复测，见 `docs/MEXC滞后定位.md`）。
- 系统：Linux（Ubuntu 22.04+），Node ≥ 20，出网可达各所 WSS；`npm ci` 需 build-essential/python3（原生模块）。
- 时区：`timedatectl set-timezone UTC`（进程也已注入 `TZ=UTC`）。
- **时钟同步（必须）**：`sudo apt install chrony && sudo systemctl enable --now chrony`。MEXC 新鲜度门（`mexc_edge_stale_ms=2000`）依赖本地时钟≈交易所时钟，钟差会系统性误判陈旧。
- 依赖安装用 `npm ci`（`tsx` 已在 dependencies，生产 `--omit=dev` 也能起）；若额外要 `npm run typecheck` 则 `npm ci --include=dev`。
- 首次部署若目录残留旧的 9 列 `alerts.csv`，先删除（新版为 10 列含 stale_downgrade，追加到旧文件会列错位）。

## 1. 拉代码 + 安装
```bash
sudo mkdir -p /opt/stock-arb && sudo chown $USER /opt/stock-arb
# 上传项目到 /opt/stock-arb（git 或 rsync）
cd /opt/stock-arb
npm ci            # 或 npm install（含 better-sqlite3/duckdb 原生编译，需 build-essential/python3）
cp .env.example .env   # 按需改（ALERT_WEBHOOK 等）
npm run typecheck      # 确认编译干净
```

## 2. 冒烟自检（30s，确认 9 路连通）
```bash
RUN_SECONDS=30 REPORT_EVERY=25 npm run collector
# 期望：9 路 status=connected、0 reject、uptime≈随窗口上升；产出 data/live/ 与 completeness-*.json
npm run query          # duckdb 能查到各 prod 行数即 OK
```

## 3. 长跑（M0 采集）—— 二选一

### A. pm2（推荐）
```bash
npm i -g pm2
mkdir -p logs
pm2 start deploy/ecosystem.config.cjs --only stock-arb-collector
pm2 save && pm2 startup      # 按提示执行 sudo 命令，开机自启
pm2 logs stock-arb-collector
```
> 上线 M1 实时告警时：`pm2 stop stock-arb-collector && pm2 start deploy/ecosystem.config.cjs --only stock-arb-engine`（engine 是 collector 超集，同样落盘，**勿两者同时跑**）。

### B. systemd
```bash
sudo cp deploy/stock-arb-collector.service /etc/systemd/system/
sudoedit /etc/systemd/system/stock-arb-collector.service   # 改 User/WorkingDirectory/ExecStart
sudo systemctl daemon-reload && sudo systemctl enable --now stock-arb-collector
journalctl -u stock-arb-collector -f
```

## 4. 健康监控（cron 每 5 分钟）
```bash
# crontab -e
*/5 * * * * cd /opt/stock-arb && /usr/bin/npx tsx scripts/healthcheck.ts >> logs/health.log 2>&1 || echo "$(date -u) UNHEALTHY" >> logs/health.alert
```
`npm run health` 读最近完整率报表，任一 feed 在线率 <95% 或报表过旧则退出码 1。

## 5. 磁盘与轮转
- 落盘量级：~2–5 万行/分钟合计（gz 后每日约数十–数百 MB，视行情活跃度）。跨 UTC 日自动 gzip。
- 建议 `logs/` 挂 logrotate；`data/live/` 定期归档到对象存储；保留 ≥ M2 所需窗口。

## 6. 里程碑时钟（关键，时间敏感）
- **S4/S5 数据时钟从服务器首日 00:00 UTC 起算**；S5（OKX 溢价）在自然衰减，每晚一天窗口就少一天 → 尽早起跑。
- 起跑 **+24h**：`npm run report:s4s5` 看覆盖；跑够 **≥3 交易日 + 1 周末** 后出 S4/S5 定稿。
- 起跑 **+24h**：M0 完整率报表定稿（`data/live/completeness-report.json`，或健康报表累计）。

## 7. 交给开发方的回流
- 把 `data/live/*/*.jsonl.gz` 回流（rsync/对象存储）即可作为 **M2 纸面撮合的数据源**；M2 的 MEXC 滞后校正会用其中 `ts_exch/ts_recv` 双时间戳的实测滞后分布。
