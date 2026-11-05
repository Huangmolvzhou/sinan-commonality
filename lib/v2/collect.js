/* ================================================================
   取数编排 v2：NG 池 → 板级追溯 → 材料 → 载具/SPI → OK 基准
   ★ 只读：所有 SQL 都来自 lib/v2/sql.js 里的 SELECT 构造器
   ★ 两级对照：
       · 批内对照（免费、精确）：同板同位号其余穴位的贴装
       · OK 基准（抽样）：前 N 天同线体同机台的板子，给载具/线体/工单算暴露占比
   ================================================================ */
const { q } = require('../conn');
const DU = require('./date_utils');
const SM = require('./sampling');   /* v6.1：抽样口径与文案统一在这里 */
const S = require('./sql');
const E = require('./engine');

const MAX_PANELS = 1500;
/* v6.7：删掉死常量 MAX_NG（全仓只有定义处引用，真正生效的是 SM.MAX_ANALYZED）。
   贴装明细改并行后，同样的板数不再受串行拖累 —— 见 PLACE_CHUNK / PLACE_CONC。 */
const PLACE_CHUNK = 30;        // v6.7：贴装明细每批多少块板（原来跟 CHUNK=800 一批，串行）
const PLACE_CONC = 6;          // v6.7：贴装明细并发几批（实测 6 与 8 差不多，选 6 对 MES 更礼貌）

/* v6.7：通用的「小批并发」执行器。
   原来 4 处（贴装明细 / 载具钢片 / SPI / 钢网）都是 chunk(usedPanels, CHUNK=800) 再串行 await，
   板数一多就是在硬等。改成小批 + 并发后，同一批板的耗时从 O(板数) 变成 O(板数/并发)。
   注意：结果按批顺序回填（buckets[i]），所以下游拿到的顺序与串行版完全一致，不影响任何口径。 */
async function runBatched(items, size, conc, fn) {
  const parts = chunk(items, size);
  const out = new Array(parts.length);
  let cur = 0;
  const worker = async () => {
    while (cur < parts.length) {
      const i = cur++;
      out[i] = await fn(parts[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, parts.length) || 1 }, () => worker()));
  const rows = [];
  for (const r of out) if (r) for (const x of r) rows.push(x);
  return rows;
}
const MAX_CROSS_FIXTURES = 120; // 跨工单载具最多查多少个（368 个载具 → 5 万块板，太重）
const CHUNK = 800;
const SAMPLE_SLOTS = [8, 14, 20];   // 每天抽 3 个整点小时窗

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* UniqueCode: 0,<MPN>,<MatrCode>,<Lot>,<DateCode>,<Qty>,<ReelID>,<Vendor> */
function parseUnique(u) {
  if (!u) return {};
  const f = String(u).split(',');
  if (f.length < 4) return {};
  return {
    mpn: f[1] || null, matr: f[2] || null, lot: f[3] || null,
    dateCode: f[4] || null,
    vendor: f.length >= 8 ? (f[f.length - 1] || null) : null
  };
}

async function timed(name, fn, stats) {
  const t = Date.now();
  const r = await fn();
  stats.push({ name, ms: Date.now() - t, rows: Array.isArray(r) ? r.length : undefined });
  return r;
}

const BASE_CACHE = new Map();  // key -> {at, data}
const BASE_TTL = 30 * 60 * 1000;

/* OK 基准：同线体 + 同工单 + 前 N 天的全部面板（走 IX_LineOrderNoResult，实测 2.9s/6447 板）
   为什么要限定工单：不同产品/不同工单的载具池完全不同，混在一起算出来的倍数没有意义 */
async function okBase(opt, stats) {
  const key = [opt.side, opt.lineIds || '', opt.orders || '', opt.b0, opt.b1].join('|');
  const hit = BASE_CACHE.get(key);
  if (hit && Date.now() - hit.at < BASE_TTL) { stats.push({ name: 'OK 基准（缓存命中）', ms: 0 }); return hit.data; }

  const t = S.TBL[opt.side === 'front' ? 'front' : 'rear'].main;
  const panels = new Map();   // panel -> LineID
  const lines = opt.lineIds || [];
  const orders = opt.orders || [];
  if (!lines.length || !orders.length) { stats.push({ name: 'OK 基准跳过（缺线体或工单）', ms: 0 }); return null; }

  /* b0/b1 可能已经是完整时间戳（兜底重取时），只在缺时间时才补，否则会拼出 23:59:59 00:00:00 */
  const norm = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? String(v).trim() + ' 00:00:00' : String(v).trim();
  const p = { b0: norm(opt.b0), b1: norm(opt.b1) };
  const ln = lines.map((v, i) => { p['l' + i] = Number(v); return '@l' + i; }).join(',');
  const on = orders.map((v, i) => { p['o' + i] = v; return '@o' + i; }).join(',');
  /* TOP 限流：不加的话 SQL 有时会扫几千万行，单次分析从 5 秒飙到 40 秒 */
  const _t1 = Date.now();
  const rows = await q(
    `SELECT DISTINCT TOP 3000 PanelCode, LineID FROM dbo.${t}
     WHERE LineID IN (${ln}) AND OrderNo IN (${on})
       AND CreateTime >= @b0 AND CreateTime < @b1`, p);
  stats.push({ name: '  ↳ 基准面板码查询', ms: Date.now() - _t1 });
  for (const r of rows) if (r.PanelCode) panels.set(r.PanelCode, r.LineID);

  const list = [...panels.keys()].slice(0, 3000);
  const dist = { total: 0, fixture: {}, line: {}, order: {} };
  const _t2 = Date.now();
  for (const part of chunk(list, CHUNK)) {
    const { sql, params } = S.boardQuery(part);
    const br = await q(sql, params);
    for (const r of br) {
      dist.total++;
      if (r.FixtureCode) dist.fixture[r.FixtureCode] = (dist.fixture[r.FixtureCode] || 0) + 1;
      if (r.WorkOrderNo) dist.order[r.WorkOrderNo] = (dist.order[r.WorkOrderNo] || 0) + 1;
      const line = panels.get(r.PanelCode);
      if (line) dist.line['L' + line] = (dist.line['L' + line] || 0) + 1;
    }
  }
  stats.push({ name: '  ↳ 基准载具/工单查询', ms: Date.now() - _t2 });
  BASE_CACHE.set(key, { at: Date.now(), data: dist });
  stats.push({ name: 'OK 基准 ' + list.length + ' 板（' + lines.join('/') + ' ' + orders.join('/') + '）', ms: 0 });
  return dist;
}

async function collect(opt) {
  const stats = [];
  const side = opt.side === 'front' ? 'front' : 'rear';
  const t0 = opt.t0, t1 = opt.t1;
  const pos = opt.position;

  /* 1) NG 池 */
  const nq = S.ngQuery({ ...opt, side });
  const ngRaw = await timed('NG 明细', () => q(nq.sql, nq.params), stats);
  /* v6.1：SQL 侧已 TOP 301。拿到 301 条 = 一定超限，这时才去跑一次 COUNT 求总体；
     没超限就不查，省掉一次全表聚合。 */
  const ngTruncated = ngRaw.length > SM.MAX_ANALYZED;
  let ngAll = ngTruncated
    ? await timed('不良总数', async () => { const c = S.ngCountQuery({ ...opt, side }); const r = await q(c.sql, c.params); return Number((r[0] || {}).n) || ngRaw.length; }, stats)
    : ngRaw.length;
  const sampling = SM.buildMeta(ngAll, ngTruncated ? SM.MAX_ANALYZED : ngRaw.length);
  const ng = (ngTruncated ? ngRaw.slice(0, SM.MAX_ANALYZED) : ngRaw).map(r => ({
    panel: r.PanelCode, seq: r.SeqNo, pcb: r.PCBCode, time: r.CreateTime,
    issue: r.IssueName, issueCode: r.IssueCode, machine: r.MachineType,
    line: r.LineID, morder: r.MOrderNo, order: r.OrderNo, program: r.Program,
    lane: r.Lane, station: r.Ext10
  }));

  const panels = [...new Set(ng.map(r => r.panel).filter(Boolean))];
  const truncated = panels.length > MAX_PANELS;
  const usedPanels = truncated ? panels.slice(0, MAX_PANELS) : panels;

  /* 2) 贴装明细
     ★ v6.7：从「分批串行」改成「小批并发」。
       原因：板数一多，串行就是硬等 —— 实测 795 板串行 77,109ms；
       改成 30 板/批 × 6 并发后同量 3,438ms。这段是唯一随板数线性变慢的地方。 */
  const placeRows = [];
  {
    const parts = chunk(usedPanels, PLACE_CHUNK);
    const buckets = new Array(parts.length);
    let cur = 0;
    const worker = async () => {
      while (cur < parts.length) {
        const i = cur++;
        const part = parts[i];
        const { sql, params } = S.placeQuery(part, pos);
        buckets[i] = await timed('贴装明细 ' + part.length + ' 板', () => q(sql, params), stats);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PLACE_CONC, parts.length) || 1 }, () => worker()));
    for (const rows of buckets) if (rows) for (const r of rows) placeRows.push(r);
  }

  /* 3) 材料 */
  const mtids = [...new Set(placeRows.map(r => r.MachineTraceID).filter(Boolean))];
  const matMap = new Map();
  for (const part of chunk(mtids, CHUNK)) {
    const { sql, params } = S.materialQuery(part);
    const rows = await timed('材料条码 ' + part.length + ' 台次', () => q(sql, params), stats);
    for (const r of rows) {
      const k = String(r.MachineTraceID) + '|' + String(r.TableNo) + '|' + String(r.PickPos);
      if (!matMap.has(k)) matMap.set(k, parseUnique(r.UniqueCode));
    }
  }

  const place = {};
  for (const r of placeRows) {
    const k = String(r.MachineTraceID) + '|' + String(r.TableNo) + '|' + String(r.PickPos);
    const mt = matMap.get(k) || {};
    (place[r.PanelCode] = place[r.PanelCode] || []).push({
      seq: r.SeqNo, nozzle: r.NozzleNo, feeder: r.FeederNo,
      table: r.TableNo, pickPos: r.PickPos, mtid: r.MachineTraceID,
      machine: r.MachineName, setup: r.SetupName, begin: r.BeginTime, mtLine: r.LineName,
      matr: mt.matr, vendor: mt.vendor, lot: mt.lot, dateCode: mt.dateCode
    });
  }

  /* 4) 载具 / 钢片 / 工单 */
  const boardRows = await runBatched(usedPanels, PLACE_CHUNK, PLACE_CONC, async (part) => {
    const { sql, params } = S.boardQuery(part);
    return timed('载具钢片 ' + part.length + ' 板', () => q(sql, params), stats);
  });
  /* 5) SPI */
  const spiRows = await runBatched(usedPanels, PLACE_CHUNK, PLACE_CONC, async (part) => {
    const { sql, params } = S.spiQuery(part);
    return timed('SPI ' + part.length + ' 板', () => q(sql, params), stats);
  });
  const spiMap = new Map(spiRows.map(r => [r.PanelCode, r.spi]));

  /* 4b) 钢网：Printer 台次里 Description='钢网' 的那条，取最后一次印刷 */
  const stencilOf = new Map();
  const stencilRows = await runBatched(usedPanels, PLACE_CHUNK, PLACE_CONC, async (part) => {
    const { sql, params } = S.stencilQuery(part);
    return timed('钢网 ' + part.length + ' 板', () => q(sql, params), stats);
  });
  for (const r of stencilRows) {
    const cur = stencilOf.get(r.PCBCode);
    if (!cur || new Date(r.BeginTime) > new Date(cur.t)) stencilOf.set(r.PCBCode, { t: r.BeginTime, pn: r.stencil_pn });
  }

  const board = {};
  for (const p of usedPanels) {
    const b = boardRows.find(x => x.PanelCode === p) || {};
    const ngOne = ng.find(x => x.panel === p) || {};
    board[p] = {
      fixture: b.FixtureCode || null, steel: b.SteelCode || null, fixture2: b.FixtureCode2 || null,
      order: b.WorkOrderNo || ngOne.order, morder: ngOne.morder,
      line: ngOne.line ? 'L' + ngOne.line : null,
      program: (place[p] || []).map(x => x.setup).find(Boolean) || ngOne.program || null,
      spi: spiMap.has(p) ? spiMap.get(p) : null, lane: ngOne.lane,
      stencil: (stencilOf.get(p) || {}).pn || null
    };
  }

  /* 6) 基准 */
  const baseDays = Math.max(1, Number(opt.baseDays) || 7);
  const b1 = String(t0).slice(0, 10);
  const b0 = DU.addDays(b1, -baseDays);   /* v6.1 修时区回退：原来走 toISOString 会少一天 */
  const ngByDay = {};

  /* 历史 30 天：判断这批是「慢性」还是「突发」 */
  let history = null;
  try {
    const h0 = DU.addDays(String(t1).slice(0, 10), -30);   /* v6.1 同上 */
    const machinesInBatch = [...new Set(ng.map(r => r.machine).filter(Boolean))];
    const hq = S.historyQuery({ side, t0: h0 + ' 00:00:00', t1: String(t1).slice(0, 10) + ' 23:59:59',
      machine: opt.machine, machines: machinesInBatch,
      position: pos, issues: opt.issues, excludePending: opt.excludePending });
    const hraw = await timed('历史 30 天', () => q(hq.sql, hq.params), stats);
    const days = hraw.map(r => ({ d: r.d, n: Number(r.n) }));
    const ns = days.map(x => x.n).sort((a, b) => a - b);
    const med = ns.length ? ns[Math.floor(ns.length / 2)] : 0;
    const p90 = ns.length ? ns[Math.min(ns.length - 1, Math.floor(ns.length * 0.9))] : 0;
    history = { days, median: med, p90, total: ns.reduce((a, b) => a + b, 0), windowDays: 30 };
    /* 7 天基准的每日数直接从这里取，不再单独查一次 */
    for (const x of days) if (x.d >= b0) ngByDay[x.d] = x.n;
  } catch (e) { stats.push({ name: '历史 30 天失败（忽略）', ms: 0, err: e.message }); }

/* ── 同载具跨工单 ──
   目的：回答「这个载具在别的工单也出不良吗」。
   做法：拿这批不良板用到的载具 → 反查这些载具在一段时间内跑过的所有板（跨工单）
        → 再和「同机台同点位出过不良的板」取交集。
   注意：暴露是「板数」，不是贴装次数；载具之间是互斥的，所以口径自洽。 */
async function crossFixture(opt, fixtures, stats) {
  if (!fixtures.length) return null;
  const from = opt.crossFrom, to = opt.crossTo;
  const rows = [];
  for (const part of chunk(fixtures, CHUNK)) {
    const { sql, params } = S.crossPanelQuery(part, from, to);
    rows.push(...(await q(sql, params)));
  }
  const _c1 = Date.now();
  const ngq = S.ngPanelsQuery({ side: opt.side, t0: from, t1: to, machine: opt.machine, position: opt.pos, issues: opt.issues });
  const ngRows = await q(ngq.sql, ngq.params);
  const ngSet = new Set(ngRows.map(r => r.PanelCode));

  const byFixture = {};
  const panelSeen = new Set();
  for (const r of rows) {
    if (!r.FixtureCode || !r.PanelCode) continue;
    const key = String(r.PanelCode);
    if (panelSeen.has(r.FixtureCode + '|' + key)) continue;
    panelSeen.add(r.FixtureCode + '|' + key);
    const f = byFixture[r.FixtureCode] = byFixture[r.FixtureCode] || { panels: 0, ng: 0, orders: {}, panelsByOrder: {} };
    f.panels++;
    const wo = r.WorkOrderNo || '(无工单)';
    f.panelsByOrder[wo] = (f.panelsByOrder[wo] || 0) + 1;
    if (ngSet.has(r.PanelCode)) {
      f.ng++;
      f.orders[wo] = (f.orders[wo] || 0) + 1;
    }
  }
  for (const f of Object.values(byFixture)) {
    f.orderList = Object.keys(f.panelsByOrder).sort();
    f.ngOrders = Object.keys(f.orders).sort();
  }
  stats.push({ name: '  ↳ 跨工单面板/NG 查询', ms: Date.now() - _c1 });
  stats.push({ name: '同载具跨工单 ' + fixtures.length + ' 个载具 / ' + rows.length + ' 板', ms: 0 });
  return { byFixture, total: rows.length, ngTotal: ngRows.length, from, to, fixtures: fixtures.length };
}

  const morders = [...new Set(ng.map(r => r.morder).filter(Boolean))];
  const lineIds = [...new Set(ng.map(r => r.line).filter(Boolean))];
  const orders = [...new Set(ng.map(r => r.order).filter(Boolean))];
  let panelsBase = null;
  let baseFallback = false;
  try {
    panelsBase = await okBase({ ...opt, side, b0, b1, lineIds, orders }, stats);
    /* 兜底：跨了多个工单时，「前 N 天」可能全在工单开工之前 → 0 块板，载具维度就废了。
       这时把基准窗挪到「分析窗本身」再取一次（口径改成"同期"，会在 meta 里标出来）。 */
    if (!panelsBase || !panelsBase.total) {
      const b0b = String(t0).slice(0, 10);
      const b1b = String(t1).slice(0, 10) + ' 23:59:59';
      panelsBase = await okBase({ ...opt, side, b0: b0b + ' 00:00:00', b1: b1b, lineIds, orders }, stats);
      baseFallback = !!(panelsBase && panelsBase.total);
    }
  } catch (e) {
    stats.push({ name: 'OK 基准失败（忽略）', ms: 0, err: e.message });
  }

  /* 检测量（可选，30s 级；默认不算） */
  let prodMap = new Map();
  if (opt.withProd) {
    const bpq = S.baseProdQuery({ side, b0, b1, machine: opt.machine, station: opt.station });
    try {
      const baseProd = await timed('基准检测量（' + baseDays + ' 天）', () => q(bpq.sql, bpq.params), stats);
      prodMap = new Map(baseProd.map(r => [r.d, r.n]));
    } catch (e) { stats.push({ name: '基准检测量失败（忽略）', ms: 0, err: e.message }); }
  }
  const days = [];
  for (let i = baseDays; i >= 1; i--) {
    const d = DU.addDays(b1, -i);   /* v6.1 同上 */
    days.push({ d, n: prodMap.get(d) || 0 });
  }

  /* 6b) 钢网分母：同工单 + 同时间窗的真实面板，逐块查钢网（钢网会换，前 7 天做分母会出假信号） */
  let stencilWindow = null;
  try {
    const lineIds = [...new Set(ng.map(r => r.line).filter(Boolean))];
    const ordersInBatch = [...new Set(ng.map(r => r.order).filter(Boolean))];
    const wpq = S.windowPanelsQuery({ side, t0, t1, lineIds, orders: ordersInBatch });
    const wp = await timed('窗内面板清单', () => q(wpq.sql, wpq.params), stats);
    const winPanels = [...new Set(wp.map(r => r.PanelCode).filter(Boolean))];
    const byPanel = new Map();
    for (const part of chunk(winPanels, CHUNK)) {
      const { sql, params } = S.stencilQuery(part);
      const rs = await q(sql, params);
      for (const r of rs) {
        const cur = byPanel.get(r.PCBCode);
        if (!cur || new Date(r.BeginTime) > new Date(cur.t)) byPanel.set(r.PCBCode, { t: r.BeginTime, pn: r.stencil_pn });
      }
    }
    stencilWindow = { byStencil: {}, total: 0 };
    for (const v of byPanel.values()) if (v.pn) { stencilWindow.byStencil[v.pn] = (stencilWindow.byStencil[v.pn] || 0) + 1; stencilWindow.total++; }
    stats.push({ name: '钢网同期用量 ' + stencilWindow.total + ' 板', ms: 0 });
  } catch (e) { stats.push({ name: '钢网同期用量失败（忽略）', ms: 0, err: e.message }); }

  /* 7) 同载具跨工单 */
  const crossDays = Math.max(1, Number(opt.crossDays) || 14);
  const crossTo = String(t1).slice(0, 10) + ' 23:59:59';
  const crossFrom = DU.addDays(String(t1).slice(0, 10), -crossDays) + ' 00:00:00';   /* v6.1 同上 */
  const fixturesAll = [...new Set(boardRows.map(b => b.FixtureCode).filter(Boolean))];
  const fixtures = fixturesAll.slice(0, MAX_CROSS_FIXTURES);
  let cross = null;
  try {
    cross = await crossFixture({ ...opt, side, pos, crossFrom, crossTo }, fixtures, stats);
    if (cross) cross.fixturesTotal = fixturesAll.length;
  } catch (e) {
    stats.push({ name: '跨工单载具失败（忽略）', ms: 0, err: e.message });
  }

  /* v6.1：窗口信息显式传给引擎（chronicity 用它当分母，不再自己猜「有几天有不良」） */
  const winHours = DU.coveredHours(t0, t1);
  const window0 = { t0, t1, coveredHours: winHours, coveredDays: winHours > 0 ? winHours / 24 : 0 };
  const ctx = {
    pos, ng, place, board, t0, t1, window: window0,
    base: { days, ngByDay, panels: panelsBase, baseDays, b0, b1, cross, history, stencilWindow }
  };
  return {
    ctx, stats,
    meta: {
      side, t0, t1, position: pos, machine: opt.machine || null, product: opt.product || null,
      issues: opt.issues || [], baseDays, panels: usedPanels.length, truncated,
      ngTotal: ng.length,
      posCoverage: usedPanels.length ? Object.keys(place).length / usedPanels.length : 0,
      basePanels: panelsBase ? panelsBase.total : 0,
      window: window0,
      baseFallback,
      ngTotalAll: ngAll, ngTruncated, maxNg: SM.MAX_ANALYZED, sampling,
      samplingNote: SM.describe(sampling), fixturesTotal: fixturesAll.length,
      crossDays, crossPanels: cross ? cross.total : 0, crossFixtures: fixtures.length
    }
  };
}

module.exports = { collect, parseUnique, chunk };
