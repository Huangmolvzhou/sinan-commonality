/* Task 6 回归测试：凭据外置 + 只读熔断加固
   ★ 背景：v6.0 把账号密码写死在 lib/conn.js 里，发行包拷出去等于把凭据一起发出去；
     而且只挡了 insert/update 这类，SELECT … INTO、OPENROWSET、WAITFOR、多条语句都放得过去。
   本测试锁定：① 源码/发行物里没有密码；② 配置按 环境变量 → 私有文件 → 未配置 的顺序解析；
              ③ 危险语句一律拒，正常业务 SQL 一律放行（不能误杀）。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* 测试要在「没有配置」的干净环境下跑，所以先把环境变量清掉再 require */
const ENV_KEYS = ['MES_SQL_HOST', 'MES_SQL_PORT', 'MES_SQL_DATABASE', 'MES_SQL_USER', 'MES_SQL_PASSWORD',
  'BE_SQL_HOST', 'BE_SQL_PORT', 'BE_SQL_DATABASE', 'BE_SQL_USER', 'BE_SQL_PASSWORD'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sinan-cfg-'));
for (const k of ENV_KEYS) delete process.env[k];
process.env.SINAN_CONFIG_DIR = TMP;
process.env.SINAN_NO_PKG_CFG = '1';   /* v6.4：发行包自带 config/ 会干扰「未配置」分支，测试里关掉 */

const CFGX = require('../lib/config');
const { assertReadOnly } = require('../lib/conn');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
function rejects(sql) {
  try { assertReadOnly(sql); return false; } catch (e) { return true; }
}
function accepts(sql) {
  try { assertReadOnly(sql); return true; } catch (e) { return e.message; }
}

console.log('\n【Task 6】凭据外置与只读熔断');

/* ---------- 凭据：源码里不许有密码 ---------- */
ok('lib/conn.js 源码里没有 CIT 密码', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'conn.js'), 'utf8');
  assert.ok(!/password:\s*['"][^'"]+['"]/.test(s), 'conn.js 里还有写死的密码');
  assert.ok(!/CIT/.test(s), 'conn.js 里还有 CIT 字面量');
});

ok('lib/conn_be.js 源码里没有 CIT 密码', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'conn_be.js'), 'utf8');
  assert.ok(!/password:\s*['"][^'"]+['"]/.test(s), 'conn_be.js 里还有写死的密码');
  assert.ok(!/CIT/.test(s));
});

ok('全仓 js 里不出现 CIT 作为账号/密码（.bat/.command/.txt 除外）', () => {
  const bad = [];
  const root = path.join(__dirname, '..');
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (f !== 'node_modules' && f !== '.git' && f !== 'tests') walk(p); continue; }
      if (!/\.(js|html)$/.test(f)) continue;
      const s = fs.readFileSync(p, 'utf8');
      if (/'CIT'|"CIT"/.test(s)) bad.push(path.relative(root, p));
    }
  })(root);
  assert.deepStrictEqual(bad, []);
});

/* ---------- 配置解析顺序 ---------- */
ok('没有任何配置时 → configured=false，列出缺哪些字段', () => {
  const r = CFGX.resolve('mes');
  assert.strictEqual(r.configured, false);
  assert.strictEqual(r.source, 'none');
  assert.ok(r.missing.length === 5, '缺失字段数 ' + r.missing.length);
});

ok('只写私有文件 → source=file 且 configured=true', () => {
  fs.writeFileSync(path.join(TMP, 'mes.local.json'), JSON.stringify({
    host: '10.0.0.1', port: 1433, database: 'mes40', user: 'u1', password: 'p1'
  }));
  const r = CFGX.resolve('mes');
  assert.strictEqual(r.configured, true);
  assert.strictEqual(r.source, 'file');
  assert.strictEqual(r.cfg.host, '10.0.0.1');
});

ok('再设环境变量 → 环境变量优先覆盖文件里的同名字段', () => {
  process.env.MES_SQL_HOST = '10.0.0.2';
  const r = CFGX.resolve('mes');
  assert.strictEqual(r.cfg.host, '10.0.0.2');
  assert.strictEqual(r.cfg.user, 'u1');      /* 没给 user，应该从文件补 */
  assert.ok(r.source.indexOf('env') >= 0, 'source=' + r.source);
  delete process.env.MES_SQL_HOST;
});

ok('describe() 不回显密码', () => {
  const d = CFGX.describe('mes');
  const t = JSON.stringify(d);
  assert.ok(!/p1/.test(t), 'describe 泄露了密码: ' + t);
  assert.strictEqual(d.hasPassword, true);
});

ok('未配置时 describe() 明确说没配置', () => {
  const d = CFGX.describe('be');
  assert.strictEqual(d.configured, false);
  assert.ok(/配置/.test(d.hint) && /未配置|没有配置|还没配置/.test(d.hint), '实际: ' + d.hint);
});

ok('配置文件损坏时不抛异常，按未配置处理', () => {
  fs.writeFileSync(path.join(TMP, 'be.local.json'), '{ 这不是 json');
  const r = CFGX.resolve('be');
  assert.strictEqual(r.configured, false);
});

/* ---------- 只读熔断：该拒的 ---------- */
const BAD = [
  ['INSERT', 'INSERT INTO t VALUES (1)'],
  ['UPDATE', 'UPDATE t SET a=1'],
  ['DELETE', 'DELETE FROM t'],
  ['DROP', 'DROP TABLE t'],
  ['EXEC', 'EXEC sp_who'],
  ['SELECT INTO 造表', 'SELECT * INTO #tmp FROM dbo.T'],
  ['SELECT INTO 变量', "SELECT @x = 1 INTO @y"],
  ['OPENROWSET', "SELECT * FROM OPENROWSET('SQLNCLI','x','y')"],
  ['OPENQUERY', "SELECT * FROM OPENQUERY(srv, 'select 1')"],
  ['WAITFOR', "WAITFOR DELAY '00:00:30'"],
  ['USE', 'USE master'],
  ['SET', 'SET NOCOUNT ON'],
  ['多语句', 'SELECT 1; DROP TABLE t'],
  ['多语句纯 SELECT 也拒', 'SELECT 1; SELECT 2'],
  ['分号后新语句', 'SELECT 1 ;\nDELETE FROM t'],
  ['WITH 后面接写操作', 'WITH c AS (SELECT 1 a) DELETE FROM t'],
  ['临时表写入', 'SELECT * FROM #tmp']
];
for (const [name, s] of BAD) {
  ok('拒绝：' + name, () => { assert.ok(rejects(s), '放过了: ' + s); });
}

/* ---------- 只读熔断：不能误杀 ---------- */
ok('放行：普通 SELECT', () => {
  assert.strictEqual(accepts('SELECT TOP 10 a, b FROM dbo.T WITH(NOLOCK) WHERE a >= @t0'), true);
});

ok('放行：WITH … SELECT（CTE）', () => {
  assert.strictEqual(accepts('WITH c AS (SELECT 1 a) SELECT * FROM c'), true);
});

ok('放行：字符串字面量里的 delete/update/into/set', () => {
  assert.strictEqual(accepts("SELECT * FROM dbo.T WHERE IssueName <> N'待复判' AND Note = 'delete into set use'"), true);
});

ok('放行：注释里的危险词', () => {
  assert.strictEqual(accepts('SELECT 1 -- 这里写 delete into waitfor\n'), true);
  assert.strictEqual(accepts('/* UPDATE DROP INTO */ SELECT 1'), true);
});

ok('放行：方括号标识符 [Use] / [Set]', () => {
  assert.strictEqual(accepts('SELECT [Set], [Use] FROM dbo.T'), true);
});

ok('放行：列名里含 SET/INTO 子串（如 SETUP、INTOUCH）', () => {
  assert.strictEqual(accepts('SELECT SETUP, INTOUCH FROM dbo.T'), true);
});

ok('放行：结尾带一个分号', () => {
  assert.strictEqual(accepts('SELECT 1;'), true);
});

ok('拒绝：空语句', () => {
  assert.ok(rejects('   '));
});

/* ---------- 真实业务 SQL 必须全部放行 ---------- */
ok('业务 SQL 全部通过只读熔断（取 sql.js 全部构造器跑一遍）', () => {
  const S = require('../lib/v2/sql');
  const BS = require('../lib/v2/be_sql');
  const opt = {
    side: 'rear', t0: '2026-10-09 00:00:00', t1: '2026-10-10 23:59:59',
    position: 'COMP-A', product: 'PRODUCT-A-003', machine: 'MACH-2',
    baseDays: 7, crossDays: 14, excludePending: true, beProc: 'AVI',
    lane: 'L1', order: 'O1', line: 'L1'
  };
  const built = [];
  for (const fn of ['ngQuery', 'ngCountQuery', 'baseNgQuery', 'baseProdQuery']) {
    if (typeof S[fn] === 'function') { try { built.push([fn, S[fn](opt).sql]); } catch (e) { /* 参数不足就跳 */ } }
  }
  for (const fn of Object.keys(BS)) {
    if (typeof BS[fn] !== 'function') continue;
    try {
      const r = BS[fn](opt);
      if (r && r.sql) built.push(['be_sql.' + fn, r.sql]);
    } catch (e) { /* 参数不匹配的跳过 */ }
  }
  assert.ok(built.length >= 4, '只构造出 ' + built.length + ' 条 SQL，样本太少');
  const failed = [];
  for (const [name, s] of built) {
    try { assertReadOnly(s); } catch (e) { failed.push(name + ': ' + e.message); }
  }
  assert.deepStrictEqual(failed, []);
});

console.log('\n' + (fail ? 'FAIL' : 'OK') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
