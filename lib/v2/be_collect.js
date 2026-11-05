/* ================================================================
   后段（BE）取数编排 —— 把 be_sql 的一堆查询并发跑，拼成引擎要的 ctx
   ================================================================
   为什么要并发：分母 5 个维度顺序跑要 80 秒以上，并发 26 秒。
   实测（1 天窗、AVI）：
     不良全维 3.5s ｜ 现象 2.1s ｜ 点位 2.1s ｜ 时间 5.8s ｜ 重测 2.1s ｜ 总量 1.7s
     分母 机台 9.2s ｜ 线体 11.6s ｜ 工位 29.1s ｜ 工单 23.0s ｜ 产品 25.7s
   → 所以：分子那批一起发、分母那批一起发，总共两轮。

   窗口策略（踩过的坑）：
     · 3 天窗分母单维 45.8s、把范围收窄到 NG 涉及的产品反而 102.5s（走错执行计划）
     · 所以「收窄」不能提速，只能靠窗口短 → 默认 1 天，超过 2 天在 UI 上提示会慢
   ================================================================ */
const B = require('./be_sql');
const { q } = require('../conn_be');

const HIST_DAYS = 30;          // 慢性判定看过去多少天
const MAX_DETAIL = 500;

const DU = require('./date_utils');

function pad(n) { return String(n).padStart(2, '0'); }
function dayStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function shiftDay(s, delta) { return DU.addDays(s, delta); }   /* v6.1：改走纯日历算法 */

/* 半开区间 [t0, t1)：SQL Server 上写 < t1 比写 <= '... 23:59:59' 更安全 */
function normOpt(f) {
  const o = { ...f };
  o.t0 = String(f.t0 || '').slice(0, 10);
  o.t1 = String(f.t1 || '').slice(0, 10);
  if (!o.t0 || !o.t1) throw new Error('后段分析需要开始与结束日期');
  if (o.t1 <= o.t0) o.t1 = shiftDay(o.t0, 1);      // 同一天也至少跑 1 天
  o.winDays = Math.max(1, DU.inclusiveDayCount(o.t0, o.t1) - 1);   /* 半开区间：t0 到 t1 相隔天数 */
  o.h0 = shiftDay(o.t0, -HIST_DAYS);
  o.histDays = HIST_DAYS;    /* v6.2：首因判读的追溯天数，文案里要说出来 */
  return o;
}

async function timed(label, fn, stats) {
  const t = Date.now();
  try {
    const r = await fn();
    if (stats) stats.push({ label, ms: Date.now() - t });
    return r;
  } catch (e) {
    if (stats) stats.push({ label, ms: Date.now() - t, err: e.message });
    throw e;
  }
}

async function collect(f) {
  const opt = normOpt(f);
  const stats = [];
  const warnings = [];

  /* ── 第一轮：分子侧 + 分母总量 + 历史 + 工位×现象（全都互不依赖，一起发） ── */
  const [agg, issues, points, times, retest, ngTotal, denomTotal, history, matrix, codes, firstCause] = await Promise.all([
    timed('不良·全维', () => run(B.beNgAggQuery(opt)), stats),
    timed('不良·现象', () => run(B.beNgIssueQuery(opt)), stats),
    timed('不良·点位', () => run(B.beNgPointQuery(opt)), stats),
    timed('不良·时间', () => run(B.beNgTimeQuery(opt)), stats),
    timed('不良·重测', () => run(B.beNgRetestQuery(opt)), stats),
    timed('不良·总量', () => run(B.beNgTotalQuery(opt)), stats),
    timed('过站·总量', () => run(B.beDenomTotalQuery(opt)), stats),
    timed('历史·按天', () => run(B.beNgHistoryQuery(opt)), stats).catch(() => ({ rows: [] })),
    timed('工位×现象', () => run(B.beNgMatrixQuery(opt, 'lane')), stats).catch(() => ({ rows: [] })),
    /* v6.0：编码维分子（ResCode → 机台/工位/穴位/轨道），125ms */
    timed('不良·编码', () => run(B.beNgCodeQuery(opt)), stats).catch(() => ({ rows: [] })),
    /* v6.2：板级首因明细（板号 + 本工序 ResCode + 全链最早 NG 的工序与 ResCode），757ms */
    timed('不良·首因', () => run(B.beFirstCauseQuery(opt)), stats).catch(() => ({ rows: [] }))
  ]);

  const ngRows = agg.rows || [];
  const dt = (denomTotal.rows || [])[0] || {};
  if (!ngRows.length) {
    return {
      empty: true, opt, stats, warnings,
      meta: metaOf(opt, dt, 0, 0)
    };
  }

  /* ── 第二轮：分母按维并发（这几条最慢，必须并行） ── */
  /* ★ v5.1 起不再查「工单」的分母：工单已从共性维度里删掉（一个工单几十万块板，
     它自己的不良率和全场几乎相同，倍数恒在 1.0 附近，说了等于没说）。
     denom.order 也就没人用了，省一条慢查询。 */
  /* ★ v6.0：分母改成「按小时切片并发」。
     整窗一次 `GROUP BY SerialNo` 实测 34~42 秒（VSWR 2 天，248 万行），走不了索引；
     切成 24 个小时片并发 → 5.5 秒，结果完全一致（492 组 / 2,480,359 行 校验过）。
     片数上限 48（2 天），更长窗口自动按天切片，别让它无限并发。 */
  const shards = hourShards(opt);
  const codeDen = await timed('过站·编码', () => codeDenom(shards, opt), stats).catch(e => {
    warnings.push(`编码维度分母查询失败：${e.message}——机台/工位/穴位/轨道本轮不出结果`);
    return { map: {}, hourDen: {} };
  });
  /* ★ v6.0：机台 / 工位 / 穴位 / 轨道 / 生产小时 五维全部从「编码分母」派生，
     不再单独查 machine / line / lane / product 四条老分母 —— 实测那四条
     合计 14.8 + 18.0 + 57.1 + 52.9 秒，而编码分母切片只要 5.9 秒，
     而且编码分母本身就是「同工序过站行数」，口径比 LineName 更准。 */
  const dims = [];
  const denom = {};

  const ctx = {
    opt,
    /* v6.1：把窗口和 t0/t1 一起给引擎，chronicity 直接用 coveredDays，不再猜 */
    t0: opt.t0, t1: opt.t1,
    window: { t0: opt.t0 + ' 00:00:00', t1: opt.t1 + ' 23:59:59',
      coveredHours: DU.coveredHours(opt.t0 + ' 00:00:00', opt.t1 + ' 23:59:59'),
      coveredDays: DU.coveredDays(opt.t0 + ' 00:00:00', opt.t1 + ' 23:59:59') },
    winDays: opt.winDays,
    ngAgg: ngRows,
    issues: issues.rows || [],
    points: points.rows || [],
    times: times.rows || [],
    retest: retest.rows || [],
    ngTotal: (ngTotal.rows || [])[0] || { ng: 0 },
    denomTotal: dt,
    denom,
    history: history.rows || [],
    matrix: matrix.rows || [],
    codes: codes.rows || [],
    codeDenom: codeDen.map || {},
    hourDenom: codeDen.hourDen || {},
    firstCause: firstCause.rows || []
  };

  const meta = metaOf(opt, dt, ctx.ngTotal.ng, ngRows.length);
  if (opt.winDays > 2) {
    warnings.push(`后段窗口 ${opt.winDays} 天，分母（过站记录）会明显变慢；` +
      `实测 3 天单维 45 秒以上。建议按 1~2 天跑，需要更长就先看结论再扩。`);
  }
  if (!Number(dt.exp)) {
    warnings.push('这个时间窗里过站记录为空（可能还没同步到今天），只能看不良分布，算不出不良率与倍数。');
  }
  return { ctx, opt, stats, meta, warnings };
}

function metaOf(opt, dt, ng, groups) {
  return {
    be: true, beProc: opt.beProc,
    t0: opt.t0, t1: opt.t1, winDays: opt.winDays,
    machine: opt.machine || '', product: opt.product || '', line: opt.line || '',
    order: opt.order || '', lane: opt.lane || '',
    panels: Number(dt.exp) || 0,
    products: Number(dt.products) || 0,
    orders: Number(dt.orders) || 0,
    firstAt: dt.firstAt || null, lastAt: dt.lastAt || null,
    ngTotal: ng, groups,
    baseDays: HIST_DAYS
  };
}

/* ── 分母按小时切片（v6.0） ──
   为什么要切：整窗 GROUP BY SerialNo 实测 34~42 秒；切片并发 5.5 秒。
   为什么按小时而不是按天：按天 2 片实测返回 0 组（时间边界拼错会静默返回空），
   按小时片每片 5 万行左右，稳定。 */
function pad2(n) { return String(n).padStart(2, '0'); }
function hm(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':00:00';
}
function hourShards(opt) {
  const out = [];
  const a = new Date(String(opt.t0).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(opt.t1).slice(0, 10) + 'T00:00:00');
  const hours = Math.max(1, Math.round((b - a) / 3600000));
  const N = Math.min(48, hours);
  const step = hours / N;
  for (let i = 0; i < N; i++) {
    const s = new Date(a.getTime() + i * step * 3600000);
    const e = new Date(a.getTime() + (i + 1) * step * 3600000);
    out.push([hm(s), hm(e)]);
  }
  return out;
}
async function codeDenom(shards, optRef) {
  /* 分片本身就是「按小时/按等分时间」切的，所以顺手就能把「每小时过站行数」
     数出来（hourDen），不用再单独查一条 DATEPART(hour)。 */
  const parts = await Promise.all(shards.map(([a, b]) => {
    const qq = B.beDenomCodeShardQuery(optRef, a, b);
    return q0(qq.sql, qq.params).catch(() => []);
  }));
  const m = {};
  const hourDen = {};
  parts.forEach((rows, i) => {
    let sum = 0;
    for (const r of rows) { const e = Number(r.exp) || 0; m[String(r.sn)] = (m[String(r.sn)] || 0) + e; sum += e; }
    const hh = Number(shards[i][0].slice(11, 13));
    /* 片可能跨小时（长窗口按等分切），跨小时就按片起点归到那一小时上，
       误差可接受：结论只用来提示「某个时段偏高」，不参与显著性 */
    if (shards.length >= 24) hourDen['H' + hh] = (hourDen['H' + hh] || 0) + sum;
  });
  return { map: m, hourDen };
}
async function q0(sql, params) { return q(sql, params); }

async function run(b) {
  if (!b) return { rows: [] };
  const rows = await q(b.sql, b.params);
  return { rows };
}

/* ── 供 server 直接用的几件小事 ── */
async function procStats(f) {
  const opt = normOpt(f);
  /* 带产品过滤时先拿工单列表：直接 JOIN 产品表 1 天 27.8s 且 0 行、7 天 200s 超时（实测） */
  if (opt.product) {
    const ow = B.beOrdersQuery(opt);
    const wos = (await q(ow.sql, ow.params)).map(r => String(r.wo));
    opt.wos = wos;
    if (!wos.length) return [];
  }
  const b = B.beProcStatsQuery(opt);
  return q(b.sql, b.params);
}

async function dict(f, kind) {
  const opt = normOpt(f);
  const map = { machine: B.beDictMachine, line: B.beDictLine, product: B.beDictProduct,
    lane: B.beDictLane, issue: B.beDictIssue, point: B.beDictPoint };
  const fn = map[kind];
  if (!fn) return [];
  const b = fn(opt);
  if (!b) return [];
  return q(b.sql, b.params);
}

async function detail(f, topN) {
  const opt = normOpt(f);
  const b = B.beNgDetailQuery(opt, topN || MAX_DETAIL);
  return q(b.sql, b.params);
}

async function drill(f, dim, value) {
  const opt = normOpt(f);
  const b = B.beDrillQuery(opt, dim, value);
  if (!b) throw new Error('后段不支持按「' + dim + '」下钻');
  return q(b.sql, b.params);
}

/* 按 SN 查：一次给一批 SN（后段板号 ProBar），返回后段过站 + 不良 */
async function bySn(bars, panels) {
  const list = (bars || []).map(s => String(s).trim()).filter(Boolean).slice(0, 200);
  if (!list.length) return { bars: [], rows: [], stations: [] };
  const b1 = B.beBySnQuery(list), b2 = B.beStationBySnQuery(list, panels);
  const [def, sta] = await Promise.all([
    q(b1.sql, b1.params).catch(() => []),
    q(b2.sql, b2.params).catch(() => [])
  ]);
  return { bars: list, rows: def, stations: sta };
}

module.exports = { collect, procStats, dict, detail, drill, bySn, normOpt, HIST_DAYS };
