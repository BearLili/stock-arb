/**
 * pm2 部署配置。用法（在项目根）：
 *   pm2 start deploy/ecosystem.config.cjs --only stock-arb-collector   # M0 采集长跑
 *   pm2 start deploy/ecosystem.config.cjs --only stock-arb-engine      # M1 全量(采集+引擎+告警+资金费)
 *   pm2 save && pm2 startup     # 开机自启
 *   pm2 logs stock-arb-collector
 * 注意：collector 与 engine 各自建立 9 路 WS，**不要同时跑两个**（会双倍连接）。
 *   M0 阶段跑 collector；上线 M1 实时告警时切到 engine（engine 是 collector 超集，同样落盘）。
 */
module.exports = {
  apps: [
    {
      name: 'stock-arb-collector',
      script: 'node',
      args: '--import tsx src/collector.ts',
      cwd: __dirname + '/..',
      env: { NODE_ENV: 'production', TZ: 'UTC' },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '600M',
      out_file: 'logs/collector.out.log',
      error_file: 'logs/collector.err.log',
      time: true,
    },
    {
      name: 'stock-arb-engine',
      script: 'node',
      args: '--import tsx src/engineMain.ts',
      cwd: __dirname + '/..',
      env: { NODE_ENV: 'production', TZ: 'UTC' },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '800M',
      out_file: 'logs/engine.out.log',
      error_file: 'logs/engine.err.log',
      time: true,
    },
  ],
};
