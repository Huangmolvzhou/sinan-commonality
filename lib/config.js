/* v6.1 Task 6：数据库凭据外置
   ★ 为什么必须外置：v6.0 把账号密码写死在源码里，发行包一拷出去就等于把凭据一起发出去了。
     现在源码里没有任何密码，按下面顺序找配置：

     ① 环境变量
          MES_SQL_HOST / MES_SQL_PORT / MES_SQL_DATABASE / MES_SQL_USER / MES_SQL_PASSWORD
          BE_SQL_HOST  / BE_SQL_PORT  / BE_SQL_DATABASE  / BE_SQL_USER  / BE_SQL_PASSWORD
     ② 本机私有配置文件（不进发行包、不进 git）
          ~/.config/sinan/mes.local.json
          ~/.config/sinan/be.local.json
          形如：{ "host": "…", "port": 1433, "database": "mes40", "user": "…", "password": "…" }
          也可以用 SINAN_CONFIG_DIR 换目录（测试与临时环境用）
     ③ 发行包自带的 config/ 目录（v6.4 新增）
        config/mes.local.json、config/be.local.json
        用途：打包发给同事时把公司内网的只读账号直接配好，双击就能用，不用每人再填一遍。
        优先级低于上面两项 —— 谁想用自己的账号，照旧写 ① 或 ② 就能覆盖。
   ④ 都没有 → 工具照常启动，但数据库状态是「未配置」，任何查询前都明确报错

   硬约束：任何日志、错误信息、/api/selfcheck、报告都不许回显密码或完整连接串。
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIELDS = ['host', 'port', 'database', 'user', 'password'];

function configDir() {
  return process.env.SINAN_CONFIG_DIR || path.join(os.homedir(), '.config', 'sinan');
}

/** 发行包自带的配置目录（和 server.js 同级的 config/）
    ★ SINAN_NO_PKG_CFG=1 可以关掉它（回归测试要模拟「完全没有配置」的场景，
      否则包里的 config/ 会一直把 configured 顶成 true，测不出「未配置」的分支） */
function pkgConfigDir() {
  return path.join(__dirname, '..', 'config');
}
function pkgDisabled() {
  const v = String(process.env.SINAN_NO_PKG_CFG || '').trim();
  return v === '1' || v.toLowerCase() === 'true';
}

function fileNameFor(key) {
  return key === 'be' ? 'be.local.json' : 'mes.local.json';
}

function envPrefix(key) {
  return key === 'be' ? 'BE_SQL_' : 'MES_SQL_';
}

/** 读一个具体路径的配置；读不到/坏掉都返回 null（不抛，启动不能因为配置缺失就崩） */
function readCfgAt(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = {};
    for (const f of FIELDS) if (j[f] !== undefined && j[f] !== '') out[f] = j[f];
    return Object.keys(out).length ? { cfg: out, file: p } : null;
  } catch (e) { return null; }
}

/** 先找本机私有配置（~/.config/sinan），再找发行包自带配置（config/） */
function readFileCfg(key) {
  const name = fileNameFor(key);
  const own = readCfgAt(path.join(configDir(), name));
  if (own) return own;
  if (pkgDisabled()) return null;
  return readCfgAt(path.join(pkgConfigDir(), name));
}

function readEnvCfg(key) {
  const pre = envPrefix(key);
  const out = {};
  for (const f of FIELDS) {
    const v = process.env[pre + f.toUpperCase()];
    if (v !== undefined && v !== '') out[f] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 解析一个库的连接参数
 * @returns {{configured:boolean, source:'env'|'file'|'none', cfg:object|null, missing:string[], file?:string}}
 */
function resolve(key) {
  const k = key === 'be' ? 'be' : 'mes';
  const env = readEnvCfg(k);
  const file = readFileCfg(k);
  /* 环境变量优先，但允许「环境变量只给了一半、其余从文件补」 */
  let cfg = null, source = 'none', filePath;
  if (env && file) { cfg = Object.assign({}, file.cfg, env); source = 'env+file'; filePath = file.file; }
  else if (env) { cfg = env; source = 'env'; }
  else if (file) { cfg = file.cfg; source = 'file'; filePath = file.file; }
  const missing = cfg ? FIELDS.filter(f => cfg[f] === undefined || cfg[f] === '') : FIELDS.slice();
  const configured = !!cfg && missing.length === 0;
  return { configured, source: configured ? source : 'none', cfg: configured ? cfg : null, missing, file: filePath };
}

/** 给日志/错误用的脱敏描述：只有 host:port/db 和用户名，绝不含密码 */
function describe(key) {
  const r = resolve(key);
  if (!r.configured) {
    return { configured: false, source: r.source, missing: r.missing, hint: '还没有配置数据库连接' };
  }
  const c = r.cfg;
  return {
    configured: true,
    source: r.source,
    host: String(c.host),
    port: Number(c.port) || 1433,
    database: String(c.database),
    user: String(c.user),
    /* 只给出是否设置了密码，不回显、不回显长度以外的任何信息 */
    hasPassword: !!c.password
  };
}

/* ── ClickHouse（AOI / SPI 测量值分布）───────────────────────────────
   ★ 开源前从源码里挪出来的：以前 CH 地址是 `const CH_BASE = 'http://<内网IP>:8123/'`
     写死在 server_v2.js 和 lib/v2/sn_trace.js 两处，等于把公司内网地址一起发出去了。
   现在按同一套优先级找，只是它不需要用户名密码，只认一个 url：
     ① 环境变量 SINAN_CH_URL
     ② ~/.config/sinan/ch.local.json  → { "url": "http://<host>:8123/" }
     ③ 发行包 config/ch.local.json
     ④ 都没有 → null，前端会把「测量值分布」整块标成不可用，不影响其余功能
   硬约束：这个地址只用于发 SELECT，和 MES 连接一样不写入任何东西。 */
function resolveCh() {
  const env = String(process.env.SINAN_CH_URL || '').trim();
  if (env) return { configured: true, source: 'env', url: env };

  const own = readCfgAt(path.join(configDir(), 'ch.local.json'));
  if (own && own.cfg.url) return { configured: true, source: 'file', url: String(own.cfg.url), file: own.file };

  if (!pkgDisabled()) {
    const pkg = readCfgAt(path.join(pkgConfigDir(), 'ch.local.json'));
    if (pkg && pkg.cfg.url) return { configured: true, source: 'pkg', url: String(pkg.cfg.url), file: pkg.file };
  }
  return { configured: false, source: 'none', url: null };
}

/** 给日志/前端用的脱敏描述：只给「配没配」，不回显内网地址 */
function describeCh() {
  const r = resolveCh();
  return { configured: r.configured, source: r.source };
}

/* ── 作者联系方式（意见反馈按钮用）───────────────────────────────────
   ★ 开源前从源码里挪出来的：以前邮箱和手机号直接写在 public/index.html 的
     HTML 与 onclick 里（4 处），一公开就是 PII 被爬。手机号尤其不能留。
     现在读同一套配置，三个层级：
       ① 环境变量 SINAN_CONTACT_MAIL / SINAN_CONTACT_TEL
       ② ~/.config/sinan/contact.local.json  → { "mail": "…", "tel": "…" }
       ③ 发行包 config/contact.local.json（发给同事时预置好，双击就能用）
       ④ 都没有 → 前端把「意见反馈」里的邮箱电话两行换成一句
          「维护者没有公开联系方式」，按钮和复制当前条件仍然可用。
     为什么不在源码里留一个默认值：留默认值等于没脱敏，只是换了个地方写。 */
function readContactAt(p) {
  const r = readCfgAtRaw(p);
  if (!r) return null;
  const out = {};
  if (r.mail) out.mail = String(r.mail).trim();
  if (r.tel) out.tel = String(r.tel).trim();
  return Object.keys(out).length ? out : null;
}
/** 与 readCfgAt 一样，但只认任意字段（contact 的字段名不是 FIELDS） */
function readCfgAtRaw(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && typeof j === 'object') ? j : null;
  } catch (e) { return null; }
}

function resolveContact() {
  const mailEnv = String(process.env.SINAN_CONTACT_MAIL || '').trim();
  const telEnv = String(process.env.SINAN_CONTACT_TEL || '').trim();
  const out = {};
  if (mailEnv) out.mail = mailEnv;
  if (telEnv) out.tel = telEnv;

  const own = readContactAt(path.join(configDir(), 'contact.local.json'));
  if (own) { out.mail = out.mail || own.mail; out.tel = out.tel || own.tel; }

  if (!pkgDisabled()) {
    const pkg = readContactAt(path.join(pkgConfigDir(), 'contact.local.json'));
    if (pkg) { out.mail = out.mail || pkg.mail; out.tel = out.tel || pkg.tel; }
  }
  return { configured: !!(out.mail || out.tel), mail: out.mail || '', tel: out.tel || '' };
}

module.exports = {
  resolve, describe, configDir, pkgConfigDir, pkgDisabled, fileNameFor, FIELDS,
  resolveCh, describeCh, resolveContact
};
