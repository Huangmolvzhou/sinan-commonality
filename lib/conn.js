/* 数据库连接（只读查询）。★ v6.1 Task6：凭据全部外置，源码里不再有任何密码。
   ★ 熔断：任何非 SELECT/WITH 语句直接抛错，绝不落到数据库
   ★ 账号实测是 db_owner 级别，所以护栏必须写在代码里，不能靠权限兜底 */
const sql = require('mssql');
const CFGX = require('./config');

function buildCfg() {
  const r = CFGX.resolve('mes');
  if (!r.configured) return null;
  const c = r.cfg;
  return {
    server: String(c.host), port: Number(c.port) || 1433,
    user: String(c.user), password: String(c.password), database: String(c.database),
    /* ★ v6.0：appName 让 DBA 在 sys.dm_exec_sessions 里一眼认出是我们。
       以前一律显示 'node-mssql'，MES 那边 4,000 多个无名会话，分不清谁是谁。 */
    options: {
      encrypt: false, trustServerCertificate: true, connectTimeout: 10000, requestTimeout: 180000,
      appName: 'PQM-Commonality'
    },
    /* ★ v6.0：连接池收到 4。配合 server 端的并发闸门（最多 2 条重查询同时跑），
       4 条连接足够周转，超出的一律排队，不往服务器上堆。 */
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 }
  };
}

/* ── v6.1：只读熔断加固 ──────────────────────────────────────────────
   比 v6.0 多加：INTO / OPENROWSET / OPENQUERY / WAITFOR / USE / SET /
   多语句 / 分号后新语句 / 临时表写入。
   两个必须守住的边界：
     ① 字符串字面量和注释里的关键字不能被误杀（'update' 这种值很常见）
     ② 正常的 WITH ... SELECT、以及所有业务查询必须照常放行
   ───────────────────────────────────────────────────────────────── */
const WRITE_WORDS = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|backup|restore|shutdown|reconfigure|dbcc|bulk)\b/i;
/* 这些词一旦出现就不是纯读：写临时表、跨库拉数、挂起、切库、改会话参 */
const DANGER_WORDS = /\b(into|openrowset|openquery|opendatasource|waitfor|use|set|kill|shutdown)\b/i;

/** 把注释和字符串字面量换成等长占位，保留分号位置，方便后续按 ';' 切分 */
function maskLiterals(src) {
  const s = String(src);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    /* 行注释 */
    if (ch === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
      out += '\n'; continue;
    }
    /* 块注释 */
    if (ch === '/' && s[i + 1] === '*') {
      out += '  '; i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++; }
      if (i < s.length) { out += '  '; i++; }
      continue;
    }
    /* 字符串字面量：'' 是转义 */
    if (ch === "'") {
      out += ' '; i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { out += '  '; i += 2; continue; }
        if (s[i] === "'") { out += ' '; break; }
        out += s[i] === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    /* 方括号标识符 [..] 与双引号标识符 ".." 也当字面量处理（里面可能叫 use/into） */
    if (ch === '[' || ch === '"') {
      const close = ch === '[' ? ']' : '"';
      out += ' '; i++;
      while (i < s.length && s[i] !== close) { out += s[i] === '\n' ? '\n' : ' '; i++; }
      if (i < s.length) { out += ' '; i++; }
      continue;
    }
    out += ch;
  }
  return out;
}

function assertReadOnly(statement) {
  const raw = String(statement == null ? '' : statement);
  if (!raw.trim()) throw new Error('拒绝执行：空语句');
  const masked = maskLiterals(raw);

  /* 多语句：只有「最后一段」可以是 SELECT，其余段一律拒绝（防止 SELECT 1; DROP …） */
  const parts = masked.split(';').map(x => x.trim()).filter(Boolean);
  if (parts.length > 1) throw new Error('拒绝执行：一次只允许一条语句（检测到 ' + parts.length + ' 段）');

  const s = masked.trim();
  if (!/^(select|with)\b/i.test(s)) throw new Error('拒绝执行：只允许 SELECT / WITH 语句');
  if (WRITE_WORDS.test(s)) throw new Error('拒绝执行：语句里出现写操作关键字');
  if (DANGER_WORDS.test(s)) throw new Error('拒绝执行：语句里出现非只读关键字（INTO / OPENROWSET / WAITFOR / USE / SET 等）');
  /* SELECT … INTO 造表：已经在 DANGER 里挡掉，这里再确认一次语义 */
  if (/\bselect\b[\s\S]*\binto\b/i.test(s)) throw new Error('拒绝执行：不允许 SELECT … INTO');
  /* 临时表/表变量：只读分析用不到，出现就说明有人在往里写或借道暂存 */
  if (/#[A-Za-z_@]/.test(s)) throw new Error('拒绝执行：不允许使用临时表');
  return true;
}

let poolPromise = null;
function pool() {
  const cfg = buildCfg();
  if (!cfg) {
    const e = new Error('数据库还没配置。请先跑一次「首次配置_数据库连接」，或者在 ~/.config/sinan/mes.local.json 里填好连接信息。');
    e.code = 'DB_NOT_CONFIGURED';
    return Promise.reject(e);
  }
  /* ★ v6.0 修的真 bug：原来连接失败后 poolPromise 会一直缓存那个「失败的 promise」，
     于是 VPN 断过一次之后，即使网络恢复，工具也会一直报「连不上」直到重启。
     现在失败就把缓存清掉，下一次自动重连。 */
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(cfg).connect().catch(e => {
      poolPromise = null;
      throw e;
    });
  }
  return poolPromise;
}

/* ★ v6.0：每条 SELECT 都过语句闸（最多 4 条同时在飞）。
   多出来的在这里排队，不会堆到 SQL Server 上变成并发压力。 */
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

module.exports = { q, sql, health, assertReadOnly, buildCfg, maskLiterals, isConfigured: () => CFGX.resolve('mes').configured, describe: () => CFGX.describe('mes') };
