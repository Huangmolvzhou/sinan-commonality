/* 后段（BE）数据库连接
   ★ v6.1 Task6：和主库一样，凭据全部外置（BE_SQL_* 环境变量或 ~/.config/sinan/be.local.json）
   ★ 与前段共用同一套只读熔断（直接 require ../conn 的 assertReadOnly，避免两份规则走偏）
   ★ 独立连接池：后段的查询比前段重，单独限流，不拖慢前段
*/
const sql = require('mssql');
const CFGX = require('./config');
const { assertReadOnly, maskLiterals } = require('./conn');

function buildCfg() {
  const r = CFGX.resolve('be');
  if (!r.configured) return null;
  const c = r.cfg;
  return {
    server: String(c.host), port: Number(c.port) || 1433,
    user: String(c.user), password: String(c.password), database: String(c.database),
    /* ★ v6.0：与主库同一套规矩 —— appName 可辨识 + 连接池收到 4 + 过闸门 */
    options: {
      encrypt: false, trustServerCertificate: true, connectTimeout: 12000, requestTimeout: 200000,
      appName: 'PQM-Commonality'
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 60000 }
  };
}

let poolPromise = null;
function pool() {
  const cfg = buildCfg();
  if (!cfg) {
    const e = new Error('后段数据库还没配置。请先跑一次「首次配置_数据库连接」，或者在 ~/.config/sinan/be.local.json 里填好连接信息。');
    e.code = 'DB_NOT_CONFIGURED';
    return Promise.reject(e);
  }
  /* 失败即清缓存，VPN 断过一次后不会一直卡在「连不上」（v6.0 与主库同修） */
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(cfg).connect().catch(e => { poolPromise = null; throw e; });
  }
  return poolPromise;
}

let GATE = null;
try { GATE = require('./gate').STMT; } catch (e) { GATE = null; }

async function q(statement, params) {
  assertReadOnly(statement);
  const go = async () => {
    const p = await pool();
    const req = p.request();
    for (const [k, v] of Object.entries(params || {})) req.input(k, v);
    const res = await req.query(statement);
    return res.recordset;
  };
  return GATE ? GATE.run(go) : go();
}

async function health() {
  const r = await q("SELECT @@VERSION v, DB_NAME() db, SUSER_NAME() login");
  return r[0];
}

module.exports = {
  q, sql, health, assertReadOnly, maskLiterals, buildCfg,
  isConfigured: () => CFGX.resolve('be').configured,
  describe: () => CFGX.describe('be')
};
