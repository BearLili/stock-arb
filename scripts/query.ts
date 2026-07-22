/**
 * duckdb 直查 JSONL 落盘（M0 验收：duckdb 可查）。
 * 用法：npm run query            —— 汇总各 prod 行数/时间范围
 *      npm run query -- "<SQL>"  —— 自定义 SQL，表名用 landing
 * landing = data/live 下所有 {prod}.jsonl / .jsonl.gz。
 */
import duckdb from 'duckdb';

const GLOB = process.env.LANDING_GLOB ?? 'data/live/*/*.jsonl*';
const custom = process.argv[2];

const source = `read_json_auto('${GLOB}', format='newline_delimited', compression='auto_detect', union_by_name=true)`;

const sql =
  custom ??
  `SELECT prod,
          count(*) AS rows,
          count(DISTINCT sym) AS syms,
          sum(CASE WHEN ts_exch IS NULL THEN 1 ELSE 0 END) AS null_exch,
          min(ts_recv) AS first_recv,
          max(ts_recv) AS last_recv
   FROM ${source}
   GROUP BY prod
   ORDER BY rows DESC`;

const finalSql = custom ? sql.replace(/\blanding\b/g, source) : sql;

const db = new duckdb.Database(':memory:');
const con = db.connect();
con.all(finalSql, (err, rows) => {
  if (err) {
    console.error('查询失败：', err.message);
    console.error('（若报无文件，先跑 collector 落盘：npm run collector）');
    process.exit(1);
  }
  console.table(rows);
  con.close();
  db.close(() => process.exit(0));
});
