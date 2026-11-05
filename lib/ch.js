/* ================================================================
   ClickHouse 连接（只读，只发 SELECT）
   ★ 开源前从 server_v2.js 与 lib/v2/sn_trace.js 里抽出来的。
   以前地址写死成 `const CH_BASE = 'http://<内网IP>:8123/'`，两个文件各一份，
   等于把公司内网地址一起发到仓库里。现在统一走 lib/config.js 的 resolveCh()。

   配置优先级（见 lib/config.js）：
     ① 环境变量 SINAN_CH_URL
     ② ~/.config/sinan/ch.local.json     { "url": "http://<host>:8123/" }
     ③ 发行包 config/ch.local.json
     ④ 都没有 → 抛 CH_NOT_CONFIGURED，调用方把「测量值分布」标成不可用，
        其余功能（MES 共性分析 / BE 段 / SN 追溯的过站部分）完全不受影响。

   为什么不做重试：CH 挂掉时前端要快速拿到「这块不可用」的结论，
   而不是让用户对着转圈等 30 秒。
   ================================================================ */
const CFG = require('./config');

/* 缓存解析结果，避免每次查询都读一遍盘。
   故意不在模块加载时就抛错 —— 未配置是合法状态，服务要能起来。 */
let CACHE = null;

function baseUrl() {
  if (CACHE) return CACHE;
  const r = CFG.resolveCh();
  if (!r.configured || !r.url) {
    const e = new Error('ClickHouse 未配置：测量值分布与 AOI/SPI 对照不可用（其余功能正常）');
    e.code = 'CH_NOT_CONFIGURED';
    throw e;
  }
  /* 补结尾斜杠：fetch 对 `http://h:8123` 会 301 到 `http://h:8123/`，
     多一次往返，而且某些代理会吞掉 POST body。 */
  let u = String(r.url).trim();
  if (!/\/$/.test(u)) u += '/';
  CACHE = u;
  return u;
}

function isConfigured() {
  try { baseUrl(); return true; } catch (e) { return false; }
}

/** 只给「配没配」和来源，不回显内网地址（日志、/api/health、前端提示都可能被截图外发） */
function describe() {
  const r = CFG.resolveCh();
  return { configured: r.configured, source: r.source };
}

async function chQuery(sql) {
  const r = await fetch(baseUrl(), { method: 'POST', body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(String(t).slice(0, 300));
  return t;
}

module.exports = { chQuery, baseUrl, isConfigured, describe };
