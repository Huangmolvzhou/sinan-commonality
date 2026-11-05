/* ================================================================
   共因洞察 v3 · 本机小服务
   只绑 127.0.0.1；数据库只发 SELECT（conn.js 有熔断）
   ================================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { q, health } = require('./lib/conn');
const S = require('./lib/v2/sql');
const E = require('./lib/v2/engine');
const C = require('./lib/v2/collect');
const BS = require('./lib/v2/be_sql');
const BEC = require('./lib/v2/be_collect');
const BEE = require('./lib/v2/be_engine');
const CFGX = require('./lib/config');   /* v6.1：凭据外置 */
const os = require('os');
const BE = require('./lib/conn_be');
const T = require('./lib/v2/sn_trace');
const RET = require('./lib/v2/retention');
const PM = require('./lib/v2/prodmap');
const LK = require('./lib/v2/link');

const DU = require('./lib/v2/date_utils');
const APP_VER = 'v6.7';
/* v6.1：日期取上海时区的今天（原来用本地 getFullYear，跨时区/早班会对不上） */
const APP_DATE = DU.todayCN().replace(/-/g, '.');
const SIGN = `Powered by PQM Morgan · ${APP_VER} · ${APP_DATE}`;
const PORT = Number(process.env.PORT || 8519);
const PUB = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'application/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json;charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.txt': 'text/plain;charset=utf-8' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ★ v6.0：查询窗口上限 31 天（含）。超过直接拒绝，不派到数据库。
   实测 90 天窗口 59 秒、300 天窗口 104 秒，对共享的 MES 副本不礼貌；
   而共性分析本来也不需要拉三个月——超过 31 天用「扩样验证」按钮分次看。 */
const MAX_WIN_DAYS = 31;
function winDays(t0, t1) {
  /* v6.1：纯日历算，不再走本地 new Date（跨时区/夏令时会差一天） */
  try { return DU.inclusiveDayCount(String(t0).slice(0, 10), String(t1).slice(0, 10)); }
  catch (e) { return 0; }
}

function normFilter(b) {
  const side = b.side === 'front' ? 'front' : 'rear';
  const pad = n => String(n).padStart(2, '0');
  const d0 = String(b.t0 || '').slice(0, 10);
  const d1 = String(b.t1 || '').slice(0, 10) || d0;
  const h0 = (b.t0h === undefined || b.t0h === null || b.t0h === '') ? 0 : Math.min(23, Math.max(0, Number(b.t0h)));
  const h1 = (b.t1h === undefined || b.t1h === null || b.t1h === '') ? 23 : Math.min(23, Math.max(0, Number(b.t1h)));
  const t0 = `${d0} ${pad(h0)}:00:00`;
  const t1 = `${d1} ${pad(h1)}:59:59`;
  const arr = v => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
  const wn = winDays(d0, d1);
  if (wn > MAX_WIN_DAYS) {
    const e = new Error('时间窗口是 ' + wn + ' 天，超过了 ' + MAX_WIN_DAYS + ' 天上限。'
      + '一次分析最多查 ' + MAX_WIN_DAYS + ' 天——这是为了保护 MES 数据库（实测 90 天要跑 59 秒）。'
      + '要看更长的趋势，请缩小到 ' + MAX_WIN_DAYS + ' 天以内，或者用「扩样验证」按钮分几次看。');
    e.code = 'WINDOW_TOO_WIDE'; e.winDays = wn;
    throw e;
  }
  return {
    side, t0, t1, winDays: wn,
    product: String(b.product || '').trim() || null,
    machine: String(b.machine || '').trim() || null,
    station: String(b.station || '').trim() || null,
    position: String(b.position || '').trim() || null,
    issues: arr(b.issues),
    panels: arr(b.panels),
    /* ★ v6.0：基准回看和跨工单回看都在后端夹住上限，不让前端传个 999 就把窗口拉爆 */
    baseDays: Math.min(30, Math.max(1, Number(b.baseDays) || 7)),
    crossDays: Math.min(30, Math.max(1, Number(b.crossDays) || 14)),
    withProd: !!b.withProd,
    excludePending: b.excludePending !== false,
    /* 后段（BE）：段别下拉里写 'be|AVI'，这里拆出来；line/order/lane/points 只有后段用 */
    beProc: (String(b.side || '').split('|')[1] && String(b.side || '').split('|')[0] === 'be')
      ? String(b.side).split('|')[1]
      : (String(b.beProc || '').trim() || null),
    line: String(b.line || '').trim() || null,
    order: String(b.order || '').trim() || null,
    lane: String(b.lane || '').trim() || null,
    points: Array.isArray(b.points) ? b.points.filter(Boolean) : (b.points ? [b.points] : [])
  };
}

/* 后段用的过滤：日期只到天（过站/不良表都是按天分区查询最快），不带前段那些字段 */
function normBe(b) {
  const f = normFilter(b);
  return {
    beProc: f.beProc,
    t0: String(b.t0 || '').slice(0, 10),
    t1: String(b.t1 || '').slice(0, 10),
    machine: f.machine, product: f.product, line: f.line, order: f.order, lane: f.lane,
    issues: f.issues, points: f.points,
    excludePending: false
  };
}


/* 极简路由 */
const routes = [];
const get = (p, fn) => routes.push({ method: 'GET', p, fn });
const post = (p, fn) => routes.push({ method: 'POST', p, fn });

get('/api/health', async () => {
  const cfg = CFGX.describe('mes');
  if (!cfg.configured) {
    return { ok: true, ver: APP_VER, date: APP_DATE, sign: SIGN, dbConfigured: false, db: null,
      hint: '数据库还没配置：请先跑一次「首次配置_数据库连接」，或设置 MES_SQL_* 环境变量。' };
  }
  const h = await health();
  return { ok: true, ver: APP_VER, date: APP_DATE, sign: SIGN, dbConfigured: true, db: h.db, login: h.login,
    version: String(h.v).split('\n')[0] };
});

/* 明细保留期：主表还剩哪一段 + 这个窗口有没有被清理 */
get('/api/retention', async (req, url) => {
  const f = normFilter({
    side: url.searchParams.get('side'),
    t0: url.searchParams.get('t0'), t1: url.searchParams.get('t1'),
    t0h: url.searchParams.get('t0h'), t1h: url.searchParams.get('t1h')
  });
  return RET.checkWindow(f.side, f.t0, f.t1);
});

/* 两张主表的保留期（前端启动时拿一次，用来提示可选的最早日期） */
get('/api/retention/span', async () => RET.probeAll());

/* ★ 开源前新增：作者联系方式（意见反馈按钮用）。
   以前邮箱和手机号写死在 public/index.html 里，一公开就是 PII 被爬。
   现在从 config/环境变量读，没配就返回空，前端显示「这一份没有预置联系方式」。
   只读配置、不碰数据库，所以不进 HEAVY 队列。 */
get('/api/contact', async () => CFGX.resolveContact());

/* ★ v6.0：自查接口 —— 给 MES 那封说明里承诺过「提供一个自查接口」，就是这个。
   只读 sys.dm_exec_sessions / dm_exec_requests 两个轻量系统视图，
   任何时刻都能看到本工具在数据库上占了几条连接、有没有在跑。 */
get('/api/selfcheck', async () => {
  const G = require('./lib/gate');
  let live = null, err = null;
  try {
    const rows = await q(`
      SELECT COUNT(*) AS sessions,
             SUM(CASE WHEN r.session_id IS NOT NULL THEN 1 ELSE 0 END) AS busy,
             MAX(ISNULL(r.cpu_time, 0)) AS maxCpuMs,
             MAX(ISNULL(r.granted_query_memory, 0)) AS maxGrantPages,
             CAST(IS_MEMBER('db_owner') AS int) AS isDbOwner
      FROM sys.dm_exec_sessions s WITH(NOLOCK)
      LEFT JOIN sys.dm_exec_requests r WITH(NOLOCK) ON r.session_id = s.session_id
      WHERE s.program_name = 'PQM-Commonality'`);
    const r0 = rows[0] || {};
    live = {
      program: 'PQM-Commonality',
      sessions: Number(r0.sessions || 0),
      busy: Number(r0.busy || 0),
      maxCpuMs: Number(r0.maxCpuMs || 0),
      maxGrantMB: Math.round(Number(r0.maxGrantPages || 0) * 8 / 1024),
      isDbOwner: Number(r0.isDbOwner || 0) === 1
    };
  } catch (e) { err = String(e.message || e).split('\n')[0]; }
  /* ★ v6.1 Task5：把「本机限流」这件事说清楚。
     闸门是 Node 进程内的变量：每个人双击启动就是一套独立的 2 个名额，
     部门整体并发并没有因此受控。这一行就是给页面和文档用的准确口径。 */
  const mode = String(process.env.QUEUE_MODE || 'local').toLowerCase() === 'central' ? 'central' : 'local';
  return {
    ok: !err, ver: APP_VER, sign: SIGN,
    concurrencyScope: 'process',
    concurrencyMode: mode,
    concurrencyNote: mode === 'central'
      ? '共享排队服务已配置，排队由服务端协调。'
      : '仅本机限流：本机同时最多运行 2 个分析；多人共用时，需要部门共享服务才能实现全局排队。',
    processId: process.pid,
    hostname: os.hostname(),
    coordinatorUrl: mode === 'central' ? String(process.env.QUEUE_COORDINATOR_URL || '') : null,
    limits: {
      maxWindowDays: MAX_WIN_DAYS, maxConcurrentJobs: G.JOB.stats().max,
      maxConcurrentStatements: G.STMT.stats().max, poolMax: 4, maxdop: 4
    },
    now: { jobs: G.JOB.stats(), statements: G.STMT.stats() },
    db: live, dbConfig: CFGX.describe('mes'), err
  };
});

/* 字典：kind = product|machine|position|issue */
get('/api/dict', async (req, url) => {
  const kind = url.searchParams.get('kind') || 'position';
  const f = normFilter({
    side: url.searchParams.get('side'),
    t0: url.searchParams.get('t0'), t1: url.searchParams.get('t1'),
    t0h: url.searchParams.get('t0h'), t1h: url.searchParams.get('t1h'),
    product: url.searchParams.get('product'),
    machine: url.searchParams.get('machine'),
    position: url.searchParams.get('position'),
    station: url.searchParams.get('station'),
    excludePending: url.searchParams.get('excludePending') !== '0'
  });
  let qy;
  if (kind === 'station') qy = S.dictStation({ t0: f.t0, t1: f.t1, product: f.product, excludePending: f.excludePending });
  else if (kind === 'product') qy = S.dictProductNg({ t0: f.t0, t1: f.t1, station: f.station, excludePending: f.excludePending });
  else if (kind === 'machine') qy = S.dictMachine({ side: f.side, t0: f.t0, t1: f.t1, product: f.product, position: f.position, station: f.station, excludePending: f.excludePending });
  else if (kind === 'issue') qy = S.dictIssue({ side: f.side, t0: f.t0, t1: f.t1, product: f.product, machine: f.machine, position: f.position, station: f.station });
  else qy = S.dictPosition({ side: f.side, t0: f.t0, t1: f.t1, product: f.product, machine: f.machine, station: f.station, excludePending: f.excludePending });
  let rows = await q(qy.sql, qy.params);
  /* 项目字典补产品名：名称 JOIN 很贵（7 天 0.54s → 3.0s），只给前 80 个补 */
  if (kind === 'product' && rows.length) {
    const top = rows.slice(0, 80).map(r => String(r.code));
    try {
      const nq = S.productNamesQuery(top);
      const names = await q(nq.sql, nq.params);
      const map = {};
      for (const r of names) map[String(r.code)] = r.name;
      rows = rows.map(r => ({ ...r, name: map[String(r.code)] || '' }));
    } catch (e) { /* 名称取不到不影响主流程，只是标签少一行 */ }
  }
  return { kind, rows };
});

/* 预览：这个条件有多少条不良（1 秒级） */
post('/api/preview', async (req) => {
  const f = normFilter(await parseBody(req));
  const qy = S.ngCountQuery(f);
  const t = Date.now();
  const rows = await q(qy.sql, qy.params);
  const n = (rows[0] || {}).n || 0;
  /* 顺手带一句保留期体检：窗口超出主表保留期时，n=0 不是「真的没不良」 */
  let ret = null;
  try { ret = await RET.checkWindow(f.side, f.t0, f.t1); } catch (e) { ret = null; }
  return { n, ms: Date.now() - t, ret };
});

/* 正式分析 */
post('/api/run', async (req) => {
  const b = await parseBody(req);
  const f = normFilter(b);
  if (!f.position) throw new Error('请先选「不良点位」——没有点位就拉不到贴装/吸嘴数据');
  if (f.t1 <= f.t0) throw new Error('结束时间必须晚于开始时间');
  const t = Date.now();
  const { ctx, stats, meta } = await C.collect(f);
  if (!ctx.ng.length) {
    /* 0 条时区分「真的没不良」和「明细已被 MES 清理」——后者必须说清楚 */
    let ret = null;
    try { ret = await RET.checkWindow(f.side, f.t0, f.t1); } catch (e) { ret = null; }
    return { empty: true, meta, stats, ms: Date.now() - t, ret };
  }
  const res = E.analyze(ctx, {});
  /* 窗口部分跨过保留期 → 结果里带上提醒（结论只覆盖保留期内的那段） */
  let ret = null;
  try { ret = await RET.checkWindow(f.side, f.t0, f.t1); } catch (e) { ret = null; }
  return {
    meta, stats, ms: Date.now() - t, ret: (ret && ret.warn) ? ret : null,
    summary: {
      level: res.level, headline: res.headline, statNote: res.statNote,
      counts: res.counts, coverage: res.coverage,
      confoundNotes: res.confoundNotes, spreadNotes: res.spreadNotes,
      suggestions: res.suggestions, trend: res.trend, chronicity: res.chronicity,
      /* ★ v6.1 Task4：白名单必须带上这两个，否则引擎算出来了页面也看不见
         （v6.0 的 parseFail 就是这么丢的） */
      correction: res.correction, approx: res.approx, scattered: res.scattered,
      /* ★ v6.4：被动共现分离。白名单已经三次吞字段（v6.0 parseFail / v6.1 correction），
         这次连测试一起加：tests/v2_passive_test.js 断言这个 key 在返回体里。 */
      passive: res.passive,
      /* ★ v6.4：时间段不良数量分布 + 有无突然上升（用户 m14832 要的 SMT 版直方图） */
      timeProfile: res.timeProfile
    },
    overflow: res.overflow || {},
    ranked: res.ranked.map(r => ({
      key: r.key, label: r.label, kind: r.kind, value: r.item.value,
      ng: r.item.ng, exp: r.item.exp, lift: r.item.lift, share: r.item.share,
      expShare: r.item.expShare, pAdj: r.item.pAdj,
      pAdjGlobal: r.item.pAdjGlobal, pAdjDimension: r.item.pAdjDimension,
      passive: r.passive || null
    })),
    weak: res.weak.slice(0, 30).map(r => ({
      key: r.key, label: r.label, value: r.item.value, ng: r.item.ng,
      exp: r.item.exp, lift: r.item.lift, pAdj: r.item.pAdj,
      pAdjGlobal: r.item.pAdjGlobal, pAdjDimension: r.item.pAdjDimension
    })),
    dims: res.dims.map(d => ({
      key: d.key, label: d.label, kind: d.kind, exp: d.exp, ng: d.ng,
      spread: d.spread, tested: d.tested, baseSrc: d.baseSrc, baseN: d.baseN, window: d.window || null,
      baseRate: d.baseRate || 0,
      unavailable: d.unavailable || null,
      items: d.items.slice(0, 40).map(i => ({
        value: i.value, ng: i.ng, exp: i.exp, lift: i.lift, share: i.share,
        expShare: i.expShare, thin: i.thin, sig: i.sig, pAdj: i.pAdj,
        orders: i.orders || null, ngOrders: i.ngOrders || null,
        panelsByOrder: i.panelsByOrder || null, ngByOrder: i.ngByOrder || null
      }))
    })),
    matrices: {
      nozzle: { label: '吸嘴', machines: res.matrices.nozzle.machines, crossable: res.matrices.nozzle.crossable,
        verdict: res.matrices.nozzle.verdict,
        rows: res.matrices.nozzle.rows.slice(0, 40) },
      feeder: { label: '飞达', machines: res.matrices.feeder.machines, crossable: res.matrices.feeder.crossable,
        verdict: res.matrices.feeder.verdict,
        rows: res.matrices.feeder.rows.slice(0, 40) }
    },
    ngDetail: res.ngDetail
  };
});

/* 下钻：某维度取值对应的不良单板清单 */
post('/api/drill', async (req) => {
  const b = await parseBody(req);
  const f = normFilter(b);
  const { ctx } = await C.collect(f);
  const res = E.analyze(ctx, {});
  const key = b.key, value = b.value;
  const rows = res.ngDetail.filter(r => {
    if (key === 'seq') return String(r.seq) === String(value);
    if (key === 'machine') return r.machine === value;
    if (key === 'nozzle') return r.nozzle === value;
    if (key === 'feeder') return r.feeder === value;
    if (key === 'table') return String(r.table) === String(value);
    if (key === 'pickPos') return String(r.pickPos) === String(value);
    if (key === 'vendor') return r.vendor === value;
    if (key === 'matr') return r.matr === value;
    if (key === 'lot') return r.lot === value;
    return String(r[key]) === String(value);
  });
  return { rows };
});

/* 工站投入 / 产出（v4.9 导出用）：这个窗口、这个段别的 Input / Output / 良率
   Input  = SUM(PCBCount)  过站检验过的单板次数
   Output = SUM(OkCount)   判 OK 的次数
   ★ 走 TRS_Busi_StationTrace。按用户选的机台在 Node 侧汇总（SQL 里加 MachineType
     过滤会让 7 天从 3.3s 涨到 22s，实测）。 */
get('/api/io', async (req, url) => {
  const f = normFilter({
    side: url.searchParams.get('side'),
    t0: url.searchParams.get('t0'), t1: url.searchParams.get('t1'),
    t0h: url.searchParams.get('t0h'), t1h: url.searchParams.get('t1h'),
    product: url.searchParams.get('product'),
    machine: url.searchParams.get('machine'),
    station: url.searchParams.get('station')
  });
  if (!f.station) return { ok: false, msg: '没选段别，算不了 Input/Output' };
  const t = Date.now();
  const qy = S.stationIoQuery({ t0: f.t0, t1: f.t1, station: f.station, product: f.product });
  const rows = await q(qy.sql, qy.params);
  /* 选了机台就只算那一台，否则全汇总 */
  const pick = f.machine ? rows.filter(r => String(r.mt) === String(f.machine)) : rows;
  const inp = pick.reduce((s, r) => s + (Number(r.inp) || 0), 0);
  const ok = pick.reduce((s, r) => s + (Number(r.ok) || 0), 0);
  return {
    ok: true, ms: Date.now() - t,
    station: f.station, machine: f.machine || null,
    product: f.product || null, t0: f.t0, t1: f.t1,
    input: inp, output: ok, ng: Math.max(0, inp - ok),
    yieldRate: inp ? ok / inp : null,
    byMachine: rows.map(r => ({
      machine: r.mt, input: Number(r.inp) || 0, output: Number(r.ok) || 0,
      ng: Math.max(0, (Number(r.inp) || 0) - (Number(r.ok) || 0))
    })).sort((a, b) => b.input - a.input)
  };
});

/* ================================================================
   后段（BE）反向查询 —— <BE_HOST> / mes40
   8 道 Process：AVI / AVI-EB / CR / ICT / LEAKAGE / PRESSURE / SENSITIVITY / VSWR
   ★ 全部只读 SELECT（conn_be.js 有同样的熔断）
   ★ 后段不需要「不良点位」——点位只是过滤项，不是必填
   ================================================================ */

/* 8 道 Process 各有多少不良板（给下拉标数字，免得选了空段） */
post('/api/be/procs', async (req) => {
  const b = await parseBody(req);
  const f = normBe(b);
  if (!f.t0 || !f.t1) throw new Error('请选开始与结束日期');
  const t = Date.now();
  const rows = await BEC.procStats(f);
  const map = {};
  for (const r of rows) map[String(r.proc)] = { ng: Number(r.ng) || 0, rows: Number(r.rows_) || 0 };
  return {
    ms: Date.now() - t,
    procs: BS.BE_PROC.map(o => ({ key: o.key, label: o.label, ng: (map[o.key] || {}).ng || 0 })),
    raw: rows
  };
});

/* 后段预览：这个条件有多少块不良板（秒级） */
post('/api/be/preview', async (req) => {
  const b = await parseBody(req);
  const f = normBe(b);
  if (!f.beProc) throw new Error('请先选后段工序（AVI / VSWR / ICT …）');
  if (!f.t0 || !f.t1) throw new Error('请选开始与结束日期');
  const t = Date.now();
  const qy = BS.beNgTotalQuery(f);
  const rows = await BE.q(qy.sql, qy.params);
  return { n: (rows[0] || {}).ng || 0, ms: Date.now() - t };
});

/* 后段下拉：机台 / 线体 / 产品 / 工位 / 现象 / 点位 */
post('/api/be/dict', async (req) => {
  const b = await parseBody(req);
  const kind = String(b.kind || 'machine');
  const f = normBe(b);
  if (!f.beProc) return { kind, rows: [] };
  const t = Date.now();
  const raw = await BEC.dict(f, kind);
  /* 统一成前端的 { code, name, n } —— 后段字典两种形态：机台/线体/产品给 code/name/n，现象/点位给 v/ng */
  let rows = (raw || []).map(r => ({
    code: r.code != null ? String(r.code) : String(r.v == null ? '' : r.v),
    name: r.name != null ? String(r.name) : '',
    n: Number(r.n != null ? r.n : r.ng) || 0
  })).filter(r => r.code !== '');
  /* 产品：前后段两个库对同一产品的命名不同（一边是料号、一边是机型代码）。归一到 MdcdatProduct 补上机型名，
     否则后段只看得到料号，看不出是哪台机器的产品（v6.0） */
  if (kind === 'product' && rows.length) {
    try {
      const named = await PM.attachNames(rows);
      rows = named.map(r => ({ code: r.code, name: r.name || r.code, n: r.n, smtCode: r.smtCode || '' }));
    } catch (e) { /* 补名失败不影响下拉 */ }
  }
  return { kind, rows, ms: Date.now() - t };
});

/* 后段正式分析 */
post('/api/be/run', async (req) => {
  const b = await parseBody(req);
  const f = normBe(b);
  if (!f.beProc) throw new Error('请先选后段工序（AVI / VSWR / ICT …）');
  if (!f.t0 || !f.t1) throw new Error('请选开始与结束日期');
  if (f.t1 <= f.t0) f.t1 = f.t0;
  const t = Date.now();
  const { ctx, stats, meta, empty, warnings } = await BEC.collect(f);
  if (empty) {
    return { empty: true, meta: { ...meta, be: true }, stats, warnings: warnings || [], ms: Date.now() - t,
      summary: { level: 'scattered', headline: `这个条件下没有「${BS.BE_PROC_LABEL(f.beProc)}」的不良板。`,
        counts: { ng: 0, boards: 0, placements: meta.panels || 0, baseRate: 0 } } };
  }
  const res = BEE.analyze(ctx);
  return {
    meta: { ...meta, be: true }, stats, warnings: warnings || [], ms: Date.now() - t,
    summary: {
      level: res.level, headline: res.headline, statNote: res.statNote,
      counts: res.counts, coverage: res.coverage,
      confoundNotes: res.confoundNotes, spreadNotes: res.spreadNotes,
      suggestions: res.suggestions, trend: res.trend, chronicity: res.chronicity,
      correction: res.correction, approx: res.approx, scattered: res.scattered,
      hour: res.hour, laneIssues: res.laneIssues,
      issuePareto: res.issuePareto, pointPareto: res.pointPareto,
      retestNote: res.retestNote,
      /* ★ v6.2：首因判读结果。加进白名单才不会静默丢失（v6.0/v6.1 各栽过一次） */
      firstNote: res.firstNote
    },
    overflow: res.overflow || {},
    ranked: res.ranked.map(r => ({
      key: r.key, label: r.label, kind: r.kind, value: r.item.value,
      ng: r.item.ng, exp: r.item.exp, lift: r.item.lift, share: r.item.share,
      expShare: r.item.expShare, pAdj: r.item.pAdj,
      pAdjGlobal: r.item.pAdjGlobal, pAdjDimension: r.item.pAdjDimension,
      rate: r.item.rate, baseRate: r.item.baseRate, yieldPct: r.item.yieldPct,
      firstRate: r.item.firstRate, fcPrior: r.item.fcPrior,
      verdict: r.verdict || null
    })),
    weak: res.weak.slice(0, 30).map(r => ({
      key: r.key, label: r.label, value: r.item.value, ng: r.item.ng,
      exp: r.item.exp, lift: r.item.lift, pAdj: r.item.pAdj, rate: r.item.rate,
      firstRate: r.item.firstRate, fcPrior: r.item.fcPrior, verdict: r.verdict || null
    })),
    dims: res.dims.map(d => ({
      key: d.key, label: d.label, kind: d.kind, exp: d.exp, ng: d.ng,
      spread: d.spread, tested: d.tested, baseRate: d.baseRate || 0,
      unavailable: d.unavailable || null, note: d.note || null,
      items: (d.items || []).slice(0, 40).map(i => ({
        value: i.value, ng: i.ng, exp: i.exp, lift: i.lift, share: i.share,
        rate: i.rate, baseRate: i.baseRate, yieldPct: i.yieldPct,
        expShare: i.expShare, thin: i.thin, sig: i.sig, pAdj: i.pAdj
      }))
    })),
    matrices: {
      nozzle: { label: '吸嘴', machines: [], crossable: false, verdict: null, rows: [] },
      feeder: { label: '飞达', machines: [], crossable: false, verdict: null, rows: [] }
    },
    ngDetail: []
  };
});

/* 前后段联动：后段 NG 板 → 前段 SMT 面板码 → 前段共性（v6.0） */
post('/api/be/link', async (req) => {
  const b = await parseBody(req);
  const f = normBe(b);
  if (!f.beProc) throw new Error('请先选后段工序（AVI / VSWR / ICT …）');
  if (!f.t0 || !f.t1) throw new Error('请选开始与结束日期');
  /* ★ 必须过 BEC.normOpt：后段按整天取数，起止同一天时它把 t1 后移一天；
     直接用 normBe 的 t0/t1 会拼出 CreateTime>=X AND <X，恒 0 行（实测踩过）。 */
  return LK.run(BEC.normOpt(f));
});

/* 后段下钻：某维度取值的板子清单 */
post('/api/be/drill', async (req) => {
  const b = await parseBody(req);
  const f = normBe(b);
  if (!f.beProc) throw new Error('请先选后段工序');
  const rows = await BEC.drill(f, String(b.key || ''), b.value);
  return { rows: rows, ms: 0 };
});

/* 后段明细导出 */
post('/api/be/detail', async (req) => {
  const b = await parseBody(req);
  const f = normBe(b);
  if (!f.beProc) throw new Error('请先选后段工序');
  const rows = await BEC.detail(f, Number(b.topN) || 500);
  return { rows };
});

/* 按 SN 查：一批 SN 在「后段 + 前段 SMT」两侧的全程记录
   后段板号（ProBar/PCBCode）→ 前段 SMT 库 TRS_Base_PCBCode → PanelCode + SeqNo → AOI
   实测：200 个 SN 批量映射 50~130ms，一块板回查 AOI 33~83ms */
post('/api/sn/lookup', async (req) => {
  const b = await parseBody(req);
  const raw = Array.isArray(b.sns) ? b.sns : String(b.sns || '').split(/[\s,;，；\n\r\t]+/);
  const sns = [...new Set(raw.map(s => String(s || '').trim()).filter(Boolean))].slice(0, 200);
  if (!sns.length) throw new Error('请贴入至少一个 SN');
  const t = Date.now();

  /* ① 后段板号 → 前段 PanelCode + SeqNo（先做，后段过站查询要靠 PanelCode 走索引） */
  const inl = sns.map((s, i) => '@sn' + i).join(',');
  const params = {};
  sns.forEach((s, i) => { params['sn' + i] = s; });
  let maps = [];
  let mapErr = null;
  try {
    maps = await q(`SELECT PCBCode, PanelCode, CAST(SeqNo AS varchar(20)) SeqNo
                    FROM dbo.TRS_Base_PCBCode WITH(NOLOCK) WHERE PCBCode IN (${inl})`, params);
  } catch (e) { mapErr = e.message; }
  const panels = [...new Set(maps.map(m => m.PanelCode).filter(Boolean))];
  /* 用户可能直接贴的就是面板码，映射不到 PCBCode 就把它自己当 PanelCode 试 */
  const unmapped = sns.filter(s => !maps.some(m => m.PCBCode === s));
  for (const u of unmapped) if (/^[HG]\d{6,}/i.test(u)) panels.push(u);

  /* ② 后段：不良 + 过站（带上 PanelCode 才能走 IX_PanelPCBCode，否则全表扫 100 秒）
     注意：后段过站表的 PanelCode 列存的常常就是板号本身，所以 candidates 里两个都放。 */
  const panelCand = [...new Set([...panels, ...sns])];
  const be = await BEC.bySn(sns, panelCand).catch(e => ({ bars: sns, rows: [], stations: [], err: e.message }));

  /* ③ 用 PanelCode 回查前段 AOI（按 PanelCode 走索引，按 PCBCode 会 240 秒超时） */
  let front = [], frontErr = null;
  if (panels.length) {
    const p2 = {};
    const inl2 = panels.map((s, i) => { p2['pn' + i] = s; return '@pn' + i; }).join(',');
    try {
      front = await q(`SELECT CAST(PanelCode AS varchar(60)) PanelCode, CAST(SeqNo AS varchar(20)) SeqNo,
                              CAST(MachineType AS varchar(60)) MachineType, MIN(CreateTime) t, COUNT(*) rows_
                       FROM dbo.TS_AOI_Rear WITH(NOLOCK)
                       WHERE PanelCode IN (${inl2}) AND CreateTime >= DATEADD(day,-60,GETDATE())
                       GROUP BY PanelCode, SeqNo, MachineType
                       UNION ALL
                       SELECT CAST(PanelCode AS varchar(60)) PanelCode, CAST(SeqNo AS varchar(20)) SeqNo,
                              CAST(MachineType AS varchar(60)) MachineType, MIN(CreateTime) t, COUNT(*) rows_
                       FROM dbo.TS_AOI_Front WITH(NOLOCK)
                       WHERE PanelCode IN (${inl2}) AND CreateTime >= DATEADD(day,-60,GETDATE())
                       GROUP BY PanelCode, SeqNo, MachineType`, p2);
    } catch (e) { frontErr = e.message; }
  }

  /* ④ 汇总：每个 SN 一行 */
  const byBar = {};
  for (const s of sns) byBar[s] = { sn: s, be: [], beStations: [], panels: [], front: [], map: null };
  for (const r of (be.rows || [])) (byBar[r.bar] || {}).be && byBar[r.bar].be.push(r);
  for (const r of (be.stations || [])) (byBar[r.bar] || {}).beStations && byBar[r.bar].beStations.push(r);
  for (const m of maps) {
    if (!byBar[m.PCBCode]) continue;
    byBar[m.PCBCode].map = { PanelCode: m.PanelCode, SeqNo: m.SeqNo };
    byBar[m.PCBCode].panels.push(m.PanelCode);
  }
  /* 没映射到 PCBCode 的（用户贴的就是面板码），把它自己当一个面板码 */
  for (const s of sns) {
    if (!byBar[s].panels.length && panels.includes(s)) byBar[s].panels.push(s);
  }
  for (const r of front) {
    for (const s of sns) {
      if (byBar[s].panels.includes(r.PanelCode)) byBar[s].front.push(r);
    }
  }
  const rows = Object.values(byBar);
  return {
    ms: Date.now() - t, sns, rows,
    errors: [mapErr && '前段板号映射失败：' + mapErr, frontErr && '前段 AOI 回查失败：' + frontErr, be.err && '后段查询失败：' + be.err].filter(Boolean)
  };
});

/* ================================================================
   按 SN 全链路追溯：过站 + SPI/AOI 测试值 + 前后各 200 块正常板对照
   明细/汇总两个导出走 /api/sn/export（复用同一份缓存，不重复查库）
   ================================================================ */
const SN_CACHE = new Map();          /* token → {at, raw, report} */
const SN_TTL = 30 * 60 * 1000;

function snKey(b) {
  const raw = Array.isArray(b.sns) ? b.sns : String(b.sns || '').split(/[\s,;，；\n\r\t]+/);
  return [...new Set(raw.map(s => String(s || '').trim()).filter(Boolean))].slice(0, 200);
}

post('/api/sn/trace', async (req) => {
  const b = await parseBody(req);
  const sns = snKey(b);
  if (!sns.length) throw new Error('请贴入至少一个 SN');
  /* v6.6：拆两条路 —— 用户说「BE 追溯 SN 太多的时候很慢」。
     实测慢的不是后段查询（100 个 SN 149ms），是 SMT 侧取对照板（每个 SN 2.8~15 秒）。
     所以：
       mode:'be'   → 只查后段，不碰 SMT 侧，100 个 SN 几秒内出结论
       mode:'both' → 原来的全链路，SN 多时慢，这是已知边界                */
  const mode = String(b.mode || 'both') === 'be' ? 'be' : 'both';

  if (mode === 'be') {
    const out = await T.traceBe(sns, { maxSns: 200 });
    const rows = out.report.rows;
    /* 只用 BE 那 6 个维度算共性，SMT/AOI/SPI 维度全给空数组（前端不会渲染） */
    const beDims = T.COMMON_DIMS.filter(d => d.group === 'BE');
    const cross = T.crossSnFor(rows, beDims);
    out.report.be.cross = { n: rows.length, dims: cross.dims };

    const token = 'sn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (SN_CACHE.size > 12) SN_CACHE.delete(SN_CACHE.keys().next().value);
    SN_CACHE.set(token, { at: Date.now(), raw: out.raw, report: out.report, mode: 'be' });

    return {
      token, ms: out.report.ms, sns, mode: 'be',
      report: out.report, rows, cross,
      common: cross.dims,
      multi: sns.length >= 2
    };
  }

  /* v6.5：默认 pcs 口径（前后各 N 个单板，N=30/100/300）。
     老字段 neighborN 仍认（对拍工具的老 case 靠它走块数口径）。 */
  const npcs = Number(b.neighborPcs);
  const nn = Number(b.neighborN);
  const out = await T.trace(sns, nn
    ? { neighborN: nn }
    : { neighborPcs: (Number.isFinite(npcs) && npcs > 0) ? Math.min(500, npcs) : 30 });
  const rows = T.buildRows(out);
  const cross = T.crossSn(rows);

  const token = 'sn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  if (SN_CACHE.size > 12) SN_CACHE.delete(SN_CACHE.keys().next().value);
  SN_CACHE.set(token, { at: Date.now(), raw: out.raw, report: out.report, mode: 'both' });

  return {
    token,
    ms: out.report.ms,
    sns,
    mode: 'both',
    report: out.report,
    rows,
    cross,
    common: cross.dims,
    multi: sns.length >= 2
  };
});

post('/api/sn/export', async (req) => {
  const b = await parseBody(req);
  const hit = SN_CACHE.get(String(b.token || ''));
  if (!hit || Date.now() - hit.at > SN_TTL) throw new Error('这次查询的结果已经过期，请重新点一次「开始追溯」再导出');
  const kind = String(b.kind || 'detail');
  let csv, name, dRef = null;
  const stamp = DU.stampCN();   /* v6.1：早班 00:00–07:59 原来会标成前一天 */
  if (kind === 'be') {
    /* v6.6：仅 BE 段导出 —— 一行一个事件（过站 / 不良），不掺 SMT 列。
       这条与 mode:'be' 配套；如果当前缓存是联合追溯的，也允许导（只出 BE 那部分事件）。 */
    const d = T.exportBe(hit.raw, hit.report && hit.report.be ? hit.report.be.cross : null);
    dRef = d;
    csv = T.toCsv(d.head, d.rows);
    name = `SN追溯_BE段_${stamp}.csv`;
  } else if (kind === 'detail') {
    const d = T.exportDetail(hit.raw, b.which === 'neighbor' ? 'neighbor' : 'all');
    dRef = d;
    csv = T.toCsv(d.head, d.rows);
    name = `SN追溯_明细_${stamp}${d.truncated ? '_已截断' : ''}.csv`;
  } else if (kind === 'summary') {
    /* 对照板的过站记录在导出时才取（主查询不拉，省 150 秒） */
    if (!hit.raw.neighStations) {
      hit.raw.neighStations = await T.exportStations(hit.raw.neighPanels || []);
    }
    const d = T.exportSummary(hit.raw);
    dRef = d;
    csv = T.toCsv(d.head, d.rows);
    name = `SN追溯_汇总_${stamp}.csv`;
  } else if (kind === 'full') {
    /* v6.5 新增：全链路一张表 —— 过站 + 检验结果 + 测量值（含规格限），一行一个事件。
       用户原话「要有导出查询的 SN 的过站记录（包含测试值的）」。 */
    if (!hit.raw.neighStations) {
      hit.raw.neighStations = await T.exportStations(hit.raw.neighPanels || []);
    }
    const d = T.exportFull(hit.raw, hit.report.compare);
    dRef = d;
    csv = T.toCsv(d.head, d.rows);
    name = `SN追溯_全链路_${stamp}${d.truncated ? '_已截断' : ''}.csv`;
  } else {
    const d = T.exportCompare(hit.report.compare);
    dRef = d;
    csv = T.toCsv(d.head, d.rows);
    name = `SN追溯_测试值对照_${stamp}.csv`;
  }
  /* ★ v6.0：空表要给出原因（空表本身不是错误，但没有解释就是 bug）。
     前端拿到 empty + reason 后弹一句人话，不再让用户对着只有表头的文件发呆。 */
  const empty = !!(dRef && dRef.empty);
  return { name, csv, bytes: Buffer.byteLength(csv, 'utf8'), rows: dRef ? dRef.rows.length : 0,
    empty, reason: (dRef && dRef.reason) || '' };
});


/* ================================================================
   ClickHouse：AOI / SPI 测量值分布（NG vs OK 大数据）
   只读，只发 SELECT。
   ★ 开源前：地址不再写死，统一走 lib/ch.js（读配置，未配置就整块标不可用）。
     chQuery 保持同名，下面几百行调用一行都不用改。
   ================================================================ */
const CH = require('./lib/ch');
const chQuery = CH.chQuery;
const CH_BASE = { configured: CH.isConfigured() };

/* 规格列：AOI 的每个指标对应哪些 LSL/USL 列（没有就 null） */
/* 规格线：直接给 ClickHouse 表达式（AOI 的规格列是 String，SPI 是 Int64/Decimal）
   口径对齐「AOI 深度分析」原工具：
   · AOI：*_LSL / *_USL 原值；Rotation 只有 USL，LSL 由前端补负值
   · SPI 百分比：Volume/Area/Height 取 *_LSL(%) / *_USL(%)（常见 40 / 160）
   · SPI 绝对值(mm)：用该行 Standard(mm) × 百分比上下限 / 100 换算
   · SPI 偏移(mm)：|OffsetX(%)_Spec| / 100 × Spec_Pad_W(mm)（Y 用 Pad_H），双边 ± */
const SPEC_AOI = {
  OffsetX: ['toFloat64OrNull(OffsetX_LSL)', 'toFloat64OrNull(OffsetX_USL)'],
  OffsetY: ['toFloat64OrNull(OffsetY_LSL)', 'toFloat64OrNull(OffsetY_USL)'],
  Rotation: [null, 'toFloat64OrNull(Rotation_USL)'],
  Lift: [null, null],
  Height: ['toFloat64OrNull(Height_LSL)', 'toFloat64OrNull(Height_USL)'],
  Match_Rate: [null, null]
};
const SPEC_SPI = {
  'Volume(%)': ['toFloat64(`Volume_LSL(%)`)', 'toFloat64(`Volume_USL(%)`)'],
  'Area(%)': ['toFloat64(`Area_LSL(%)`)', 'toFloat64(`Area_USL(%)`)'],
  'Height(%)': ['toFloat64(`Height_LSL(%)`)', 'toFloat64(`Height_USL(%)`)'],
  'Volume(mm)': ['toFloat64(`Volume_Standard(mm)`)*toFloat64(`Volume_LSL(%)`)/100',
                 'toFloat64(`Volume_Standard(mm)`)*toFloat64(`Volume_USL(%)`)/100'],
  'Area(mm)': ['toFloat64(`Area_Standard(mm)`)*toFloat64(`Area_LSL(%)`)/100',
               'toFloat64(`Area_Standard(mm)`)*toFloat64(`Area_USL(%)`)/100'],
  'Height(mm)': ['toFloat64(`Height_Standard(mm)`)*toFloat64(`Height_LSL(%)`)/100',
                 'toFloat64(`Height_Standard(mm)`)*toFloat64(`Height_USL(%)`)/100'],
  'OffsetX(mm)': ['-abs(toFloat64(`OffsetX(%)_Spec`))*toFloat64OrNull(`Spec_Pad_W(mm)`)/100',
                  'abs(toFloat64(`OffsetX(%)_Spec`))*toFloat64OrNull(`Spec_Pad_W(mm)`)/100'],
  'OffsetY(mm)': ['-abs(toFloat64(`OffsetY(%)_Spec`))*toFloat64OrNull(`Spec_Pad_H(mm)`)/100',
                  'abs(toFloat64(`OffsetY(%)_Spec`))*toFloat64OrNull(`Spec_Pad_H(mm)`)/100']
};
const SPEC_COLS = { aoi: SPEC_AOI, spi: SPEC_SPI };

/* 统一先 cast 成字符串再 toFloat64OrNull：AOI 这些列是 String，SPI 是 Decimal(18,5)，
   直接对 Decimal 用 toFloat64OrNull 会报 Code:43，前端就误显示成"没数据" */
const FSTR = col => `toFloat64OrNull(${col})`;   // AOI：列是 String
const FNUM = col => `toFloat64(${col})`;         // SPI：列是 Decimal(18,5)，直转最快
const METRICS = {
  aoi: {
    OffsetX: FSTR('OffsetX'), OffsetY: FSTR('OffsetY'),
    Rotation: FSTR('Rotation'), Lift: FSTR('Lift'),
    Height: FSTR('Height'), Match_Rate: FSTR('Match_Rate')
  },
  spi: {
    'Volume(mm)': FNUM('`Volume(mm)`'), 'Volume(%)': FNUM('`Volume(%)`'),
    'Area(mm)': FNUM('`Area(mm)`'), 'Height(mm)': FNUM('`Height(mm)`'),
    'OffsetX(mm)': FNUM('`OffsetX(mm)`'), 'OffsetY(mm)': FNUM('`OffsetY(mm)`')
  }
};

function distSql(kind, comp, metric, t0, t1) {
  const safe = v => String(v).replace(/'/g, "''");
  const v = METRICS[kind][metric];
  if (!v) throw new Error('不支持的指标：' + metric);
  const table = kind === 'spi' ? 'bigdata.SPI_SX_detail_panelcode' : 'bigdata.AOI_D3F_detail_panelcode';
  const timeCol = kind === 'spi' ? 'Inspection_Time' : 'Inspect_Date';
  const compFilter = kind === 'spi'
    ? `startsWith(Component_ID, '${safe(comp)}_')`
    : `Location_Name = '${safe(comp)}'`;
  const ngExpr = kind === 'spi' ? `Result = 'FAIL'` : "`Comp.Result` = 'NG'";
  const whereBase = `WHERE ${timeCol} >= '${t0}' AND ${timeCol} < '${t1}' AND ${compFilter}
    AND UPPER(panelcode) NOT LIKE 'SY%' AND UPPER(panelcode) NOT LIKE 'SAMPLE%'
    AND UPPER(panelcode) NOT LIKE 'TESTCODE%'`;
  const where = `${whereBase} AND ${v} IS NOT NULL`;
  return { table, v, where, whereBase, ngExpr, timeCol, compFilter };
}

get('/api/dist/meta', async () => {
  const rows = [];
  for (const k of ['aoi', 'spi']) for (const m of Object.keys(METRICS[k])) rows.push({ kind: k, metric: m });
  return { rows, ch: CH_BASE };
});

get('/api/dist', async (req, url) => {
  const kind = url.searchParams.get('kind') === 'spi' ? 'spi' : 'aoi';
  const comp = url.searchParams.get('comp') || '';
  const metric = url.searchParams.get('metric') || Object.keys(METRICS[kind])[0];
  const t0 = url.searchParams.get('t0') || '';
  const t1 = url.searchParams.get('t1') || '';
  const defect = (url.searchParams.get('defect') || '').trim();   // 只对 NG 侧按不良类型过滤
  if (!comp) throw new Error('缺少元件/点位');
  const q = distSql(kind, comp, metric, t0, t1);
  const safe = v => String(v).replace(/'/g, "''");

  /* NG 判定：AOI 可再按不良类型收口（否则缺件/异物也会混进来，测量值当然分不开） */
  let ngExpr = q.ngExpr;
  if (kind === 'aoi' && defect) ngExpr = `(${q.ngExpr} AND Rep.Defect LIKE '%${safe(defect)}%')`;
  const okExpr = kind === 'spi' ? "Result <> 'FAIL'" : "`Comp.Result` <> 'NG'";

  const statSql = `
    SELECT count() AS n, quantile(0.01)(v) AS p01, quantile(0.05)(v) AS p05,
           quantile(0.25)(v) AS p25, quantile(0.5)(v) AS p50,
           quantile(0.75)(v) AS p75, quantile(0.95)(v) AS p95, quantile(0.99)(v) AS p99,
           avg(v) AS mean, stddevPop(v) AS sd
    FROM (SELECT ${q.v} AS v FROM ${q.table} ${q.where} AND (${okExpr})) FORMAT JSON`;
  const stat = JSON.parse(await chQuery(statSql)).data[0];

  const ngCntSql = `SELECT count() AS ng FROM ${q.table} ${q.where} AND (${ngExpr}) FORMAT JSON`;
  const ngCnt = JSON.parse(await chQuery(ngCntSql)).data[0].ng;

  const okSql = `SELECT ${q.v} AS v FROM ${q.table} ${q.where} AND (${okExpr})
    ORDER BY cityHash64(id) LIMIT 3000 FORMAT TSV`;
  const okText = await chQuery(okSql);
  const okPts = okText.trim() ? okText.trim().split('\n').map(Number).filter(function(x){ return isFinite(x); }) : [];

  const ngSql = `SELECT ${q.v} AS v FROM ${q.table} ${q.where} AND (${ngExpr})
    ORDER BY cityHash64(id) LIMIT 2000 FORMAT TSV`;
  const ngText = await chQuery(ngSql);
  const ngPts = ngText.trim() ? ngText.trim().split('\n').map(Number).filter(function(x){ return isFinite(x); }) : [];

  let lsl = null, usl = null;
  if (kind === 'aoi' && /^Offset[XY]$/.test(metric)) {
    const s2 = await chQuery(`SELECT quantile(0.5)(toFloat64OrNull(${metric}_LSL)) l, quantile(0.5)(toFloat64OrNull(${metric}_USL)) u
      FROM ${q.table} ${q.where} FORMAT TSV`);
    const pp = s2.trim().split('\t');
    lsl = pp[0] && pp[0] !== 'nan' ? Number(pp[0]) : null;
    usl = pp[1] && pp[1] !== 'nan' ? Number(pp[1]) : null;
  }

  return { kind, comp, metric, defect: defect || null, n: Number(stat.n), ng: Number(ngCnt),
    stat, okPts, ngPts, lsl, usl };
});


/* 六个指标一起扫：一次返回「各指标统计 + OK 采样 + NG 取值」，前端画小图组 */
get('/api/dist/scan', async (req, url) => {
  const kind = url.searchParams.get('kind') === 'spi' ? 'spi' : 'aoi';
  const comp = url.searchParams.get('comp') || '';
  const t0 = url.searchParams.get('t0') || '';
  const t1 = url.searchParams.get('t1') || '';
  const defect = (url.searchParams.get('defect') || '').trim();
  if (!comp) throw new Error('缺少元件/点位');
  const ck = scanKey({ kind, comp, defect, t0, t1 });
  const cached = scanGet(ck);
  if (cached) return Object.assign({}, cached, { cached: true });
  const metrics = Object.keys(METRICS[kind]);
  const q0 = distSql(kind, comp, metrics[0], t0, t1);
  const safe = v => String(v).replace(/'/g, "''");
  let ngExpr = q0.ngExpr;
  if (kind === 'aoi' && defect) ngExpr = `(${q0.ngExpr} AND Rep.Defect LIKE '%${safe(defect)}%')`;
  const okExpr = kind === 'spi' ? "Result <> 'FAIL'" : "`Comp.Result` <> 'NG'";

  /* 1) OK 侧分位数（一次扫描） */
  const parts = [];
  metrics.forEach((m, i) => {
    const v = METRICS[kind][m];
    /* 用 quantileTDigest：6 指标 × 7 分位一次算，精确 quantile 会涨到 40 秒 */
    parts.push(`quantileTDigest(0.01)(${v}) AS p01_${i}`, `quantileTDigest(0.05)(${v}) AS p05_${i}`,
      `quantileTDigest(0.25)(${v}) AS p25_${i}`, `quantileTDigest(0.5)(${v}) AS p50_${i}`,
      `quantileTDigest(0.75)(${v}) AS p75_${i}`, `quantileTDigest(0.95)(${v}) AS p95_${i}`, `quantileTDigest(0.99)(${v}) AS p99_${i}`);
  });
  const okStat = JSON.parse(await chQuery(
    `SELECT count() AS okTotal, ${parts.join(', ')} FROM ${q0.table} ${q0.whereBase} AND (${okExpr}) FORMAT JSON`)).data[0];

  /* 2) OK 采样（画小提琴用） */
  /* OK 侧均匀采样：id 是 UUID，cityHash64(id) % N 恒为 0（会导致 OK 侧全空），
     所以用 ORDER BY cityHash64(id) LIMIT N —— 均匀、可重复，200 万行也只要 2 秒左右 */
  const OK_SAMPLE = 5000;
  const okSampleSql = `SELECT ${metrics.map(m => METRICS[kind][m]).join(', ')}
    FROM ${q0.table} ${q0.whereBase} AND (${okExpr}) ORDER BY cityHash64(id) LIMIT ${OK_SAMPLE} FORMAT TSV`;
  const okText = await chQuery(okSampleSql);
  const okRows = okText.trim() ? okText.trim().split('\n').map(l => l.split('\t').map(Number)) : [];

  /* 3) NG 全部取值 */
  const ngSql = `SELECT ${metrics.map(m => METRICS[kind][m]).join(', ')}
    FROM ${q0.table} ${q0.whereBase} AND (${ngExpr}) LIMIT 3000 FORMAT TSV`;
  const ngText = await chQuery(ngSql);
  const ngRows = ngText.trim() ? ngText.trim().split('\n').map(l => l.split('\t').map(Number)) : [];

  /* 规格线：从数据里取中位数（自动），前端可手动覆盖；SPI 没有规格列，跳过这次扫描 */
  const specSel = [];
  metrics.forEach((m, i) => {
    const sp = (SPEC_COLS[kind] || {})[m] || [null, null];
    specSel.push(sp[0] ? `quantile(0.5)(${sp[0]}) AS lsl_${i}` : `NULL AS lsl_${i}`);
    specSel.push(sp[1] ? `quantile(0.5)(${sp[1]}) AS usl_${i}` : `NULL AS usl_${i}`);
  });
  const specStat = JSON.parse(await chQuery(
    `SELECT ${specSel.join(', ')} FROM ${q0.table} ${q0.whereBase} FORMAT JSON`)).data[0];

  const out = metrics.map((m, i) => {
    const p = k => Number(okStat[k + '_' + i]);
    const ngVals = ngRows.map(r => r[i]).filter(v => isFinite(v));
    const okSample = okRows.map(r => r[i]).filter(v => isFinite(v));
    const p01 = p('p01'), p99 = p('p99'), p25 = p('p25'), p75 = p('p75'), p50 = p('p50');
    const outside = ngVals.filter(v => v < p01 || v > p99).length;
    const share = ngVals.length ? outside / ngVals.length : 0;
    const iqr = Math.abs(p75 - p25) || 1e-9;
    const ngMed = ngVals.length ? ngVals.slice().sort((a, b) => a - b)[Math.floor(ngVals.length / 2)] : null;
    const shift = ngMed == null ? 0 : Math.abs(ngMed - p50) / iqr;
    return {
      metric: m, kind, ng: ngVals.length, outside, outsideShare: share,
      p01, p05: p('p05'), p25, p50, p75, p95: p('p95'), p99,
      ngMed, shift: Number(shift.toFixed(2)),
      score: Number((share * 0.7 + Math.min(2, shift) / 2 * 0.3).toFixed(3)),
      lsl: (function(){ var v = specStat['lsl_' + i]; return (v == null || isNaN(Number(v))) ? null : Number(v); })(),
      usl: (function(){ var v = specStat['usl_' + i]; return (v == null || isNaN(Number(v))) ? null : Number(v); })(),
      okSample: okSample.map(v => Number(v.toFixed(4))),
      ngVals: ngVals.map(v => Number(v.toFixed(4)))
    };
  }).filter(r => r.ng > 0 || r.okSample.length);

  out.sort((a, b) => b.score - a.score);
  const best = out[0] || null;
  const payload = {
    kind, comp, defect: defect || null, okTotal: Number(okStat.okTotal || 0), metrics: out,
    advice: best
      ? (best.outsideShare >= 0.5
        ? '建议看 ' + best.metric + '：' + (best.outsideShare * 100).toFixed(0) + '% 的 NG 落在 OK 的 P1~P99 之外'
        : (best.outsideShare >= 0.15
          ? best.metric + ' 有一定区分度（' + (best.outsideShare * 100).toFixed(0) + '% 在 OK 范围外）'
          : '六个方向都分不开 —— 这批不良可能不在尺寸/角度上，转去看料号/机台/穴位'))
      : '没有可用的测量数据'
  };
  /* 只缓存有结果的成功响应：把一次空结果缓存 10 分钟，会让人以为这个点位一直没数据 */
  if (payload.metrics.length) scanPut(ck, payload);
  return payload;
});

/* 测量值扫描结果缓存：同样的点位+时间窗 10 分钟内不重复扫（一次 40 秒，来回切换很难受） */
const SCAN_CACHE = new Map();
const SCAN_TTL = 10 * 60 * 1000;
function scanKey(o) { return [o.kind, o.comp, o.defect || '', o.t0, o.t1].join('|'); }
function scanGet(k) { const v = SCAN_CACHE.get(k); if (v && Date.now() - v.at < SCAN_TTL) return v.data; SCAN_CACHE.delete(k); return null; }
function scanPut(k, data) { if (SCAN_CACHE.size > 40) SCAN_CACHE.delete(SCAN_CACHE.keys().next().value); SCAN_CACHE.set(k, { at: Date.now(), data }); }

/* ★ v6.0：任务闸 —— 同一时刻最多 2 个「一次分析」在跑。
   实测 5 人同时点会把服务器并发从 20 推到 142、单条查询 16 秒变 166 秒，
   所以多出来的人在本地排队，并告诉他们前面还有几个、大概要等多久。 */
const GATE = require('./lib/gate');
const HEAVY = new Set([
  '/api/run', '/api/drill', '/api/preview', '/api/io',
  '/api/be/run', '/api/be/link', '/api/be/drill', '/api/be/detail', '/api/be/preview',
  '/api/sn/trace', '/api/sn/export', '/api/dist/scan'
]);

/* ★ v6.0：把数据库的原始报错翻成人话。
   以前断网直接甩「Failed to connect to <MES_HOST>:1433 in 10000ms」或「read ECONNRESET」，
   用户看不出该干什么。现在一律告诉「发生了什么 + 怎么办」。 */
function humanError(e) {
  const raw = String((e && e.message) || e || '').split('\n')[0];
  if (/Failed to connect|ETIMEOUT|ESOCKET|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(raw)) {
    return '连不上 MES 数据库（' + raw + '）。请确认在公司网络或 VPN 里，连上后直接再点一次就行，不用重启工具。';
  }
  if (/timeout/i.test(raw) && /request/i.test(raw)) {
    return '数据库超过 3 分钟没返回（' + raw + '）。多半是条件太宽，请缩小日期范围或加上项目/机台筛选。';
  }
  if (/WINDOW_TOO_WIDE/.test(String(e && e.code))) return raw;
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const hit = routes.find(r => r.method === req.method && r.p === url.pathname);
  if (hit) {
    let waited = 0;
    try {
      const runIt = () => hit.fn(req, url);
      const out = HEAVY.has(url.pathname)
        ? await GATE.JOB.run(runIt, w => { waited = w.etaMs; })
        : await runIt();
      if (waited > 0 && out && typeof out === 'object' && !Array.isArray(out)) {
        out.queued = { ms: waited, note: '前面有别的分析在跑，你排队等了约 ' + Math.round(waited / 1000) + ' 秒' };
      }
      if (waited > 0) res.setHeader('X-Queue-Wait-Ms', String(waited));
      sendJSON(res, 200, out);
    } catch (e) {
      /* ★ v6.0：排队头在出错时也要报出去，否则前端不知道「慢」是因为排队还是因为真出错 */
      if (waited > 0) { try { res.setHeader('X-Queue-Wait-Ms', String(waited)); } catch (e1) {} }
      const code = e && e.code === 'WINDOW_TOO_WIDE' ? 400 : 500;
      sendJSON(res, code, { error: humanError(e), code: (e && e.code) || null });
    }
    return;
  }
  /* 静态：先找 public/，再找工具根目录（操作SOP.html、截图/ 都在根目录） */
  let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  p = p.replace(/\.\./g, '');
  const roots = [PUB, __dirname];
  (function tryNext(i) {
    if (i >= roots.length) { res.writeHead(404); res.end('Not Found'); return; }
    const file = path.join(roots[i], p);
    fs.readFile(file, (err, buf) => {
      if (err || !buf) { tryNext(i + 1); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  })(0);
});

function openBrowser(url) {
  const { exec } = require('child_process');
  try {
    if (process.platform === 'win32') exec('start "" "' + url + '"');
    else if (process.platform === 'darwin') exec('open "' + url + '"');
    else exec('xdg-open "' + url + '"');
  } catch (e) { /* 打不开就让用户自己点 */ }
}

/* ★ v6.1 Task5：启动时校验排队模式。central 却没给地址 → 直接启动失败，
   不许悄悄回退成本机模式（回退会让人以为已经全局排队了）。 */
let QUEUE = null;
try {
  QUEUE = require('./lib/gate').queueConfig();
} catch (e) {
  console.error('\n启动失败：' + e.message + '\n');
  process.exit(1);
}
/* ★ v6.1 Task6：凭据没配也能启动，但要把话说清楚（页面与终端都提示） */
const DB_READY = CFGX.resolve('mes').configured;

let port = PORT;
const srv = http.createServer();
srv.on('request', server.listeners('request')[0]);
srv.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < PORT + 6) {
    console.log('端口 ' + port + ' 被占用，换 ' + (port + 1) + ' …');
    port++;
    setTimeout(() => srv.listen(port, '127.0.0.1'), 200);
  } else {
    console.error('启动失败：' + e.message);
    process.exit(1);
  }
});
srv.listen(port, '127.0.0.1', () => {
  console.log(SIGN);
  console.log('  排队模式：' + QUEUE.mode + '（' + QUEUE.note + '）');
  if (!DB_READY) {
    console.log('  ⚠ 数据库还没配置：请先跑一次「首次配置_数据库连接」，或设置 MES_SQL_* 环境变量。');
  }
  console.log('\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
  '    \u53f8\u5357\u3000SINAN\u3000\u00b7\u3000SMT \u4e0d\u826f\u6839\u56e0\u805a\u7126\n' +
  '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
  '  已启动: http://127.0.0.1:' + port + '  (关闭本窗口即停止)');
  openBrowser('http://127.0.0.1:' + port);
});
