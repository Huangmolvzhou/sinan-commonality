/* ================================================================
   单个 / 多个 SN 的全链路追溯（客诉反查用）

   一条链：
     SN ──┬─ 前段 MES：TRS_Busi_StationTrace（过站）+ TS_AOI_Rear/Front（AOI 结果）+ TS_SPI
          ├─ ClickHouse：AOI 测量值（OffsetX/Y/Rotation/Lift/Height）+ SPI 测量值
          └─ 后段 MES：T_Bllb_TestDefectInformation（不良）+ TRS_Busi_StationTrace（过站）

   还要给「同一产品 + 同一机台，按时间前后各 N 块正常板」做对照。

   ★ 全部只读 SELECT。conn.js / conn_be.js 里各有熔断，写语句根本到不了数据库。
   ★ 性能点（实测，改代码前先看这几条）：
     1. TRS_Busi_StationTrace 的索引是 IX_PanelPCBCode(PanelCode, PCBCode)，
        PCBCode 不是最左列 —— 只按 PCBCode 查 = 全表扫 10 亿行，111 秒。
        一定要先拿到 PanelCode 再查。
     2. 该表 PanelCode 的 IN 列表超过 ~380 个会走错计划（400 个一次 75 秒），
        分块 300 个只要 160 毫秒。所以下面统一 CHUNK=300。
     3. TS_AOI_Rear / TS_SPI 按 PanelCode IN 400 个仍然 100 毫秒以内，不用分块。
     4. 邻居板必须带小时窗（CreateTime >= ts - N 小时），不带下界是 43~118 秒。
     5. ClickHouse 的 AOI 表要按 24 位全码查（panelcode 列），
        SPI 表要按「去掉日期后缀的基码」查（Board_Barcode 列），两者口径不一样。
     6. ClickHouse 的 ModuleID 就是 MES 的 SeqNo（实测 90 穴一一对上）；
        seqno 列全库恒为 0，不能用。
   ================================================================ */
const { q: qSmt } = require('../conn');
const { q: qBe } = require('../conn_be');
const BEC = require('./becode');
/* ★ 开源前：CH 地址不再写死（原来这里是一行硬编码的内网 IP），改走 lib/ch.js。
   chQuery 保持同名，下面三处调用一行都不用改；未配置时抛 CH_NOT_CONFIGURED，
   调用方会把它转成「没有测量值数据」，不影响过站追溯。 */
const CH = require('../ch');
const chQuery = CH.chQuery;

const CHUNK = 300;              // 过站表 IN 列表分块，超过 380 会掉进慢计划
const NEIGHBOR_N = 200;
const MAX_PANELS = 420;         // 一次最多追多少块板（目标板 + 前后各 200 块对照）
const MAX_AOI_ROWS = 400000;    // 明细导出的 AOI 行数上限
/* SPI 每板一次检验 ≈ 3,870 行 / 288 KB。按「整批一个时间窗」取会把整天的检验都拉回来
   （实测单板无窗 = 46 MB，Node 直接 V8 崩溃；200 板更不可能），所以改成逐板按自己的
   MES 时间 ±5 分钟取，并且限制参与对照的板数。 */
const SPI_WIN_MIN = 5;          // 每板时间窗 ±5 分钟
const MAX_SPI_PANELS = 12;      // 最多给多少块板拉 SPI 测量值（目标板必拉；仅用于明细导出，不参与对照统计）
const MAX_DETAIL_ROWS = 500000; // 明细 CSV 总行数上限
/* v6.5：把 ClickHouse 的选择列抽成常量 —— chAoi / chAoiPcs 共用，
   并且把规格限（LSL/USL）一起取回来，全链路导出才能给出「实测值 vs 规格」。 */
const AOI_SEL = 'panelcode, ModuleID modid, Location_Name loc, Component_Code comp, `Comp.Result` res, Rep.Defect defect,' +
  'OffsetX, OffsetX_LSL, OffsetX_USL, OffsetY, OffsetY_LSL, OffsetY_USL, Rotation, Rotation_USL,' +
  'Lift, BodyLift_USL, Height, Height_LSL, Height_USL, Match_Rate matchRate, Inspect_Date t';
const SPI_SEL = 'Board_Barcode barcode, imulti modid, Component_ID comp, PAD_ID pad, Result res,' +
  '`Volume(%)` vol, `Volume_USL(%)` volUsl, `Volume_LSL(%)` volLsl,' +
  '`Area(%)` area, `Area_USL(%)` areaUsl, `Area_LSL(%)` areaLsl,' +
  '`Height(mm)` hgt, `Height_USL(%)` hgtUsl, `Height_LSL(%)` hgtLsl,' +
  '`OffsetX(mm)` offx, `OffsetY(mm)` offy, `OffsetX(%)_Spec` offxSpec, `OffsetY(%)_Spec` offySpec, Inspection_Time t';


/* ClickHouse 的 TSV → 对象数组。
   ★ 必须用 TSVWithNames —— 纯 FORMAT TSV 不带表头行，第一行就是数据，
     按「首行当表头」解析会把第一块板整行数据当成列名（实测踩过：
     解析出来的对象是 {"1":"1","<面板码>-…":"<面板码>-…"}）。 */
function tsv(text) {
  const lines = String(text || '').split('\n').filter(l => l.length);
  if (lines.length < 2) return [];
  const head = lines[0].split('\t');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = c[j];
    out.push(o);
  }
  return out;
}
const num = v => (v === '' || v == null || v === '\\N' ? null : (Number.isFinite(+v) ? +v : null));
const str = v => (v == null || v === '\\N' ? '' : String(v));
/* ★ 时间统一写成 'YYYY-MM-DD HH:mm:ss'。
   mssql 返回的是 Date 对象，直接 String() 会变成 'Sun Oct 18 2026 00:49:11 GMT+0800 (China Standard Time)'，
   在 Excel 里既不能排序也不能算差；ClickHouse 回来的是 'YYYY-MM-DD HH:mm:ss' 字符串，原样保留。 */
const tfmt = v => {
  if (v == null || v === '\\N') return '';
  /* v6.6：Date 分支原来是本地 getter，会让 MES 墙钟时间整体 +8 小时（同 dayOf 那个 bug）。
     导出 CSV 里时间列错位 8 小时，用户拿去和 MES 界面对就对不上。改 UTC 分量。 */
  if (v instanceof Date && !isNaN(v.getTime())) {
    const d = v;
    const p2 = n => (n < 10 ? '0' : '') + n;
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' +
      p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
  }
  const t = String(v);
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6] : t;
};
const esc = s => "'" + String(s).replace(/'/g, "''") + "'";
const uniq = a => [...new Set(a.filter(Boolean))];
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/* 前段板号 → 去掉日期后缀的基码（SPI 用）：<面板码>-2610200004 → <面板码> */
function baseCode(panel) { return String(panel || '').replace(/-\d{8,12}$/, ''); }

/* ★ ClickHouse 的 AOI 表 ORDER BY (Inspect_Date, panelcode, id) —— 不带日期窗时
   `WHERE panelcode=...` 只能全表扫（单板 14~18 秒）；加 Inspect_Date 窗后同一条 SQL
   降到 0.7 秒。所以凡是按板号查 CH 都必须带日期窗。 */
function chRange(range, col) {
  if (!range || !range.a || !range.b) return '';
  const c = col || 'Inspect_Date';
  return ` AND ${c} >= '${ymd(range.a)}' AND ${c} < '${ymd(range.b)}'`;
}

/* ★ 时间口径：mssql（tedious 默认 useUTC）把库里的 datetime 原样当 UTC 返回，
   所以 `2026-10-18T03:57:18Z` 的 UTC 部分就是库里的墙上时间 03:57。
   这里必须用 getUTC* 取，否则会整体偏 8 小时 —— ClickHouse 的 Inspection_Time 是本地
   墙上时间，偏 8 小时就永远匹配不到那一次 SPI 检验（实测 chSpi 返回 0 行就是这个原因）。 */
function ymd(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

/* ────────────────────────────────────────────────────────────────
   ① 解析 SN：一块板长什么样、什么时候做的、哪个产品/机台
   ──────────────────────────────────────────────────────────────── */
async function resolve(sns) {
  const out = {};
  for (const s of sns) out[s] = { sn: s, panel: null, seq: null, product: null, machine: null, t: null, src: null };

  /* 先试后段映射表（后段 SN 在这里能拿到前段面板码 + 穴位） */
  const beMap = {};
  for (const c of chunk(sns, CHUNK)) {
    const rows = await qBe(
      `SELECT CAST(PCBCode AS varchar(60)) sn, CAST(PanelCode AS varchar(60)) panel,
              SeqNo seq, CAST(Product AS varchar(80)) product, CAST(MachineType AS varchar(60)) machine,
              Createtime t FROM dbo.TRS_Base_PCBCode WITH(NOLOCK)
       WHERE PCBCode IN (${c.map(esc).join(',')}) AND PanelCode IS NOT NULL`, {});
    for (const r of rows) if (!beMap[r.sn]) beMap[r.sn] = r;
  }
  for (const s of sns) {
    const m = beMap[s];
    if (m) { Object.assign(out[s], { panel: m.panel, seq: m.seq, product: m.product, machine: m.machine, t: m.t, src: 'be-map' }); }
  }

  /* ★ 后段库的 TRS_Base_PCBCode 里 PanelCode 常常就是板号本身（如 SN00000002），
     不是前段面板码。真正能连回 SMT 的映射在【前段库】的 TRS_Base_PCBCode 里
     （实测 SN00000003 → PANEL00002-2610190001 / SeqNo 272）。
     所以凡是后段映射到「自己」的，都再拿前段库查一遍并优先用前段面板码。 */
  const needSmt = sns.filter(s => !out[s].panel || String(out[s].panel) === String(s));
  if (needSmt.length) {
    for (const c of chunk(needSmt, CHUNK)) {
      const rows = await qSmt(
        `SELECT CAST(PCBCode AS varchar(60)) pcbc, CAST(PanelCode AS varchar(60)) panel,
                SeqNo seq, CAST(Product AS varchar(80)) product, CAST(MachineType AS varchar(60)) machine,
                Createtime t FROM dbo.TRS_Base_PCBCode WITH(NOLOCK)
         WHERE PCBCode IN (${c.map(esc).join(',')}) AND PanelCode IS NOT NULL`, {});
      for (const r of rows) {
        const s = c.find(x => x === String(r.pcbc));
        if (!s) continue;
        Object.assign(out[s], { panel: r.panel, seq: r.seq, product: r.product, machine: r.machine, t: r.t, src: 'smt-map' });
      }
    }
  }

  /* 还没映射到的：也许用户贴的就是前段面板码本身 */
  const rest = sns.filter(s => !out[s].panel);
  if (rest.length) {
    for (const c of chunk(rest, CHUNK)) {
      for (const side of ['Rear', 'Front']) {
        const rows = await qSmt(
          `SELECT CAST(PanelCode AS varchar(60)) panel, MIN(SeqNo) seq, MAX(CAST(Ext8 AS varchar(80))) product,
                  MAX(CAST(MachineType AS varchar(60))) machine, MIN(CreateTime) t
           FROM dbo.TS_AOI_${side} WITH(NOLOCK) WHERE PanelCode IN (${c.map(esc).join(',')})
           GROUP BY PanelCode`, {});
        for (const r of rows) {
          const s = c.find(x => x === r.panel);
          if (s && !out[s].panel) {
            Object.assign(out[s], { panel: r.panel, seq: r.seq, product: r.product, machine: r.machine, t: r.t, src: 'panel-' + side });
          }
        }
      }
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   ② 邻居板：同产品 + 同机台，按时间往前 / 往后各 N 块
      小时窗从 2h 起逐级放大，够 N 块就停（实测 2h 只要 2.7 秒）

   ★ v6.6 两处提速（实测，见注释里的数字）：
     1. 加 `Ext10` 站别过滤。`TS_AOI_Rear` 的 6 小时窗里 AOI-Rear 只占 988,764 行
        （其它是 UV-AOI 315,898 / UV-VI 342,790 / UV-VI2 / UV-VI1 / PSA-AOI …），
        `TS_AOI_Front` 里 AOI-Front 占 978,852（其它是 AOI-Flip 767,414 / X-Ray 216,436 …）。
        加过滤后走 `IX_TS_AOI_Rear_MachineTypeProcess(MachineType,Ext10,SideIndex,CreateTimeHour)`
        三列全用上，实测 h=2 从 3,653ms → 1,590ms、h=24 从 22,178ms → 6,766ms。
        ★ 代价与兜底：理论上存在「只过了 UV-AOI、没有 AOI-Rear 行」的板会被漏掉。
          所以最后一个窗口仍不够 N 块时，再跑一次「不带 Ext10」的查询兜底 ——
          宁可慢这一条，也不让对照板莫名少一块。
     2. 前 / 后两个方向并行（原来串行 2 轮 × 最多 5 个窗口 = 10 条串行查询）。
   ──────────────────────────────────────────────────────────────── */
const EXT10_MAIN = { Rear: 'AOI-Rear', Front: 'AOI-Front' };

async function nbQuery(tg, ts, h, n, dir, useE10) {
  const cmp = dir === 'before' ? '<' : '>';
  const rng = dir === 'before'
    ? `CreateTime < '${ts}' AND CreateTime >= DATEADD(hour,-${h},'${ts}')`
    : `CreateTime > '${ts}' AND CreateTime <= DATEADD(hour,${h},'${ts}')`;
  const agg = dir === 'before' ? 'MAX(t) DESC' : 'MIN(t) ASC';
  const col = dir === 'before' ? 'MAX(t)' : 'MIN(t)';
  const e10 = side => (useE10 ? ` AND Ext10 = '${EXT10_MAIN[side]}'` : '');
  return qSmt(
    `SELECT TOP ${n} PanelCode, ${col} t FROM (
       SELECT PanelCode, CreateTime t FROM dbo.TS_AOI_Rear WITH(NOLOCK)
        WHERE ${rng} AND Ext8 = ${esc(tg.product)} AND MachineType = ${esc(tg.machine)}${e10('Rear')}
       UNION ALL
       SELECT PanelCode, CreateTime FROM dbo.TS_AOI_Front WITH(NOLOCK)
        WHERE ${rng} AND Ext8 = ${esc(tg.product)} AND MachineType = ${esc(tg.machine)}${e10('Front')}
     ) u GROUP BY PanelCode ORDER BY ${agg}`, {});
}

async function nbDir(tg, ts, n, dir, seen) {
  const windows = [2, 6, 12, 24, 48];
  const acc = [];
  const push = rows => {
    for (const r of rows) {
      if (seen.has(r.PanelCode)) continue;
      seen.add(r.PanelCode);
      acc.push({ panel: r.PanelCode, t: r.t, of: tg.sn });
    }
  };
  let everRows = false;
  for (const h of windows) {
    const rows = await nbQuery(tg, ts, h, n, dir, true);
    if (rows.length) everRows = true;
    push(rows);
    if (acc.length >= n) return acc;
    /* ★ v6.6：前两个窗口一条都没查到，说明这块板在这个机台根本没有 AOI-Rear/Front
       行（只过了 UV-AOI / X-Ray 之类），继续放大窗口纯属浪费 —— 实测有 target
       在 2h~48h 全部返回 0 行，等于白跑 5 条查询。直接跳去兜底。 */
    if (!everRows && h >= 6) break;
  }
  /* 兜底：Ext10 过滤会漏掉「只过 UV-AOI / X-Ray、没有 AOI-Rear 行」的板。
     ★ 只在【一条都没查到】时才跑兜底 —— 实测这条不带 Ext10 的查询在慢机台上要
       10~16 秒（S3-SIM 三档分别 15.9s / 11.5s / 10.7s），而只要 Ext10 那档已经
       找到板（哪怕是别的 panel），样本就够用来做对照，没必要再为多凑几块付这个代价。 */
  if (!everRows) {
    try {
      const rows = await nbQuery(tg, ts, 24, n, dir, false);
      push(rows);
    } catch (e) { /* 兜底失败不影响主路径 */ }
  }
  return acc;
}

async function neighbors(targets, n = NEIGHBOR_N, exact) {
  const before = [], after = [];
  const seen = new Set(targets.map(t => t.panel));
  /* 「前后各 200 块」按整批算，不按每个 SN 算 —— 否则贴 3 个 SN 就会拉回 1200 块板，
     ClickHouse 那边光 AOI 就 60 万行。贴几个 SN 就把这 200 块均分。
     v6.5：pcs 口径走 exact（每侧恰好 n 块），因为「前后各 30 个 pcs」必须精确，
     不能被 max(40,…) 抬到 40，也不能被 targets 数除。 */
  if (!exact) n = Math.max(40, Math.floor(n / Math.max(1, targets.length)));

  for (const tg of targets) {
    if (!tg.product || !tg.machine || !tg.t) continue;
    const ts = ymd(tg.t);
    /* ★ v6.0 修的真 bug：以前只查 TS_AOI_Rear。
       实测 SN00000001+4MG 这个产品（PRODUCT-A-006 / LINE-B）：
       TS_AOI_Rear 0 行、TS_AOI_Front 226 万行 —— 也就是说这块板只过了前段 AOI。
       只看 Rear 就永远取不到对照板，于是「测试值对照」全空、连邻居都没得比。现在两段并起来取。 */
    const [b, a] = await Promise.all([
      nbDir(tg, ts, n, 'before', seen),
      nbDir(tg, ts, n, 'after', seen)
    ]);
    for (const x of b) before.push(x);
    for (const x of a) after.push(x);
  }
  return { before, after };
}

/* ────────────────────────────────────────────────────────────────
   ②-b 邻居 pcs（v6.5 新增）
       ★ 为什么不再按 panel 数：用户原话「不要是 panel 的，因为 SMT 段 1 panel
         对应好几十个产品」。实测（2026-10-29，TS_AOI_Rear 两天窗）：
         一块 panel 平均 102 个穴位、最多 360 个 —— 「前后各 200 块 panel」
         等于前后各 2 万个单板，这就是用户说「导出数据感觉很多」的根因。
       ★ 为什么分两步查：按 PCBCode 直接 TOP N 实测 11~14 秒（TS_AOI_Rear 没有
         PCBCode 索引）；先按 panel 取附近几块（1.2~2.4 秒），再对这些 panel 取
         全部 pcs（320 毫秒），然后在内存里按时间切出「目标前后各 N 个 pcs」，
         整条 3.3 秒。而且 30/100/300 pcs 通常只落在 1~4 块 panel 上。
   ──────────────────────────────────────────────────────────────── */
async function pcsOfPanels(panels) {
  const out = [];
  const seen = new Set();
  for (const c of chunk(panels, CHUNK)) {
    const inl = c.map(esc).join(',');
    /* Rear / Front 并行：两条都是 index seek，串行纯浪费 */
    const both = await Promise.all(['Rear', 'Front'].map(side => qSmt(
      `SELECT CAST(PCBCode AS varchar(60)) pcb, CAST(PanelCode AS varchar(60)) panel,
              SeqNo seq, MIN(CreateTime) t
         FROM dbo.TS_AOI_${side} WITH(NOLOCK) WHERE PanelCode IN (${inl})
        GROUP BY PCBCode, PanelCode, SeqNo`, {}).catch(() => [])));
    for (const rows of both) {
      for (const r of rows) {
        const pcb = str(r.pcb);
        if (!pcb || seen.has(pcb)) continue;   /* 同一块 pcs 在 Rear / Front 都有行，按条码去重 */
        seen.add(pcb);
        out.push({ pcb, panel: str(r.panel), seq: Number(r.seq) || null, t: r.t });
      }
    }
  }
  return out;
}

/* 单个 target 取「前后各 want 个 pcs」 */
async function pcsAroundOne(tg, want, k, notes) {
  const before = [], after = [];
  const seen = new Set([String(tg.sn)]);
  let nb = { before: [], after: [] };
  try { nb = await neighbors([tg], k, true); }
  catch (e) { notes.push('取邻近 panel 失败：' + e.message); }
  const panels = uniq([tg.panel, ...nb.before.map(x => x.panel), ...nb.after.map(x => x.panel)]);
  let pcs = [];
  try { pcs = await pcsOfPanels(panels); }
  catch (e) { notes.push('取 panel 内 pcs 失败：' + e.message); return { before, after }; }
  pcs.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

  /* 定位目标 pcs：先按条码（SMT 的 PCBCode 就是 SN），再按 板号+穴位，再按时间 */
  let idx = pcs.findIndex(p => p.pcb === String(tg.sn));
  if (idx < 0) idx = pcs.findIndex(p => p.panel === str(tg.panel) && p.seq === Number(tg.seq));
  if (idx < 0) {
    const ts = new Date(tg.t).getTime();
    idx = pcs.findIndex(p => new Date(p.t).getTime() >= ts);
  }
  if (idx < 0) idx = pcs.length;

  for (let i = idx - 1; i >= 0 && before.length < want; i--) {
    const p = pcs[i];
    if (seen.has(p.pcb)) continue;
    seen.add(p.pcb);
    before.push({ ...p, of: tg.sn, side: 'before' });
  }
  for (let i = idx + 1; i < pcs.length && after.length < want; i++) {
    const p = pcs[i];
    if (seen.has(p.pcb)) continue;
    seen.add(p.pcb);
    after.push({ ...p, of: tg.sn, side: 'after' });
  }
  return { before, after };
}

/* 同一 product|machine 组的 target 共享一次 panel 搜索：
   100 个真实 BE NG SN 按 product|machine 实际只落在 16 组里
   （Top：PRODUCT-A-008|LINE-D 31 个、PRODUCT-A-009|N54-HB 11、PRODUCT-A-001|LINE-A 10）。
   同组 SN 的邻居板池高度重叠，逐 SN 各查一遍等于把同一条 SQL 跑 N 次。 */
async function pcsAroundGroup(grp, want, k, notes) {
  /* 组内取时间最早的那个 SN 当锚点（邻居池覆盖它前后，其余 SN 落在池子里） */
  const anchor = grp.slice().sort((a, b) => new Date(a.t) - new Date(b.t))[0];
  let nb = { before: [], after: [] };
  try { nb = await neighbors([anchor], k + Math.min(6, grp.length), true); }
  catch (e) { notes.push('取邻近 panel 失败：' + e.message); }
  const panels = uniq([anchor.panel, ...nb.before.map(x => x.panel), ...nb.after.map(x => x.panel)]);
  let pcs = [];
  try { pcs = await pcsOfPanels(panels); }
  catch (e) { notes.push('取 panel 内 pcs 失败：' + e.message); return grp.map(() => ({ before: [], after: [] })); }
  pcs.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

  return grp.map(tg => {
    const before = [], after = [];
    const seen = new Set([String(tg.sn)]);
    let idx = pcs.findIndex(p => p.pcb === String(tg.sn));
    if (idx < 0) idx = pcs.findIndex(p => p.panel === str(tg.panel) && p.seq === Number(tg.seq));
    if (idx < 0) {
      const ts = new Date(tg.t).getTime();
      idx = pcs.findIndex(p => new Date(p.t).getTime() >= ts);
    }
    if (idx < 0) idx = pcs.length;
    for (let i = idx - 1; i >= 0 && before.length < want; i--) {
      const p = pcs[i];
      if (seen.has(p.pcb)) continue;
      seen.add(p.pcb);
      before.push({ ...p, of: tg.sn, side: 'before' });
    }
    for (let i = idx + 1; i < pcs.length && after.length < want; i++) {
      const p = pcs[i];
      if (seen.has(p.pcb)) continue;
      seen.add(p.pcb);
      after.push({ ...p, of: tg.sn, side: 'after' });
    }
    return { before, after };
  });
}

async function neighborsPcs(targets, N) {
  const want = Math.max(1, Math.min(500, Number(N) || 30));
  /* 需要多少块 panel 才装得下 N 个 pcs：一块 panel 保守按 40 个 pcs 估，
     再多要 3 块兜底（同一个 panel 里的 pcs 时间很挤，缺口只能往邻板扩）。 */
  const k = Math.max(3, Math.min(30, Math.ceil(want / 40) + 3));
  const notes = [];
  const list = targets.filter(tg => tg.panel && tg.t);
  if (!list.length) return { before: [], after: [], want, panelsEachSide: k, notes };

  /* 按 product|machine 分组，同组共享一次 panel 搜索 */
  const gmap = new Map();
  for (const tg of list) {
    const gk = str(tg.product) + '|' + str(tg.machine);
    if (!gmap.has(gk)) gmap.set(gk, []);
    gmap.get(gk).push(tg);
  }
  const groups = [...gmap.values()];
  /* ★ v6.6：多个 SN 时逐个串行曾经是 5 个 SN 45.8 秒的主因之一。
     现在按组并发 3（每组内部还有 2 条并行 SQL），实测 5 个 SN 从 45.8s → 5s 上下。
     并发上限取 3 是因为每组内部还有 2 条并行查询，合计 6 条，
     压在 conn.js 连接池（max 4~6）之上会被排队，再高反而慢 —— 这个值是实测扫出来的。 */
  const CONC = 5;
  const out = new Array(groups.length);
  let i = 0;
  async function worker() {
    while (i < groups.length) {
      const gi = i++;
      out[gi] = await pcsAroundGroup(groups[gi], want, k, notes);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, groups.length) || 1 }, () => worker()));

  const before = [], after = [];
  for (const arr of out) {
    if (!arr) continue;
    for (const r of arr) {
      for (const x of r.before) before.push(x);
      for (const x of r.after) after.push(x);
    }
  }
  /* 多个 SN 时每侧合计仍限 want × SN 数（同 neighbors 的「按整批算」口径） */
  const cap = list.length > 1 ? want * list.length : want;
  const trim = a => a.slice(0, cap);
  return { before: trim(before), after: trim(after), want, panelsEachSide: k, notes, groups: groups.length };
}

/* ────────────────────────────────────────────────────────────────
   ③ 前段过站（SMT 全工序）+ 前段 AOI / SPI 结果
   ──────────────────────────────────────────────────────────────── */
const ST_COLS = 'CAST(PanelCode AS varchar(60)) panel,[Process] procn,Station station,MachineType machine,LineName line,SerialNo lane,' +
  'FixtureCode fixture,SteelCode steel,PCBCode pcb,WorkOrderNo morder,Product product,' +
  'PCBCount pcbCount,OkCount okCount,CreateTime t';

async function smtStations(panels) {
  const out = [];
  for (const c of chunk(panels, CHUNK)) {
    const rows = await qSmt(
      `SELECT ${ST_COLS} FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK)
       WHERE PanelCode IN (${c.map(esc).join(',')}) ORDER BY PanelCode, CreateTime`, {});
    for (const x of rows) out.push(x);
  }
  return out;
}

/* v6.0 新增：把 SMT 段「用户关心的维度」一次取齐 —— 载具 / 钢网 / 吸嘴 / 飞达 /
   材料厂商 / 材料批次。以前「按 SN 查」只取机台/工站/载具，吸嘴飞达材料全没有，
   于是「这两个 SN 在 SMT 有没有共性」只能看机台，等于没答。
   实测两块板的代价：载具 73ms、吸嘴飞达 38ms、材料 112ms，可以忽略。 */
async function smtDims(panels) {
  const out = { board: [], sub: [], mat: [], sta: [] };
  if (!panels || !panels.length) return out;
  for (const c of chunk(panels, CHUNK)) {
    const inl = c.map(esc).join(',');
    const [b, s2, m, st] = await Promise.all([
      qSmt(`SELECT CAST(PanelCode AS varchar(60)) pan, CAST(FixtureCode AS varchar(60)) fx,
              CAST(SteelCode AS varchar(60)) st, CAST(FixtureCode2 AS varchar(60)) fx2
            FROM dbo.SMT_PanelCode WITH(NOLOCK) WHERE PanelCode IN (${inl})`, {}).catch(() => []),
      qSmt(`SELECT DISTINCT CAST(PanelCode AS varchar(60)) pan, CAST(NozzleNo AS varchar(40)) nz,
              CAST(FeederNo AS varchar(60)) fd
            FROM dbo.TRS_Busi_SubCodeTrace WITH(NOLOCK) WHERE PanelCode IN (${inl})`, {}).catch(() => []),
      /* 材料厂商 / 批次：TrackTrace 按 MachineTraceID + TableNo + PickPos 对上，
         再挂 PUB_UniqueCode 拿 Supplier / LotNo。
         ★ 列名是 Supplier 不是 Vendor（PUB_UniqueCode 里没有 Vendor 列，写错会报
           `Invalid column name 'Vendor'`）。 */
      qSmt(`SELECT DISTINCT CAST(s.PanelCode AS varchar(60)) pan, CAST(tt.MatrCode AS varchar(60)) matr,
              CAST(u.Supplier AS varchar(80)) vd, CAST(u.LotNo AS varchar(60)) lot
            FROM dbo.TRS_Busi_SubCodeTrace s WITH(NOLOCK)
            JOIN dbo.TRS_Busi_TrackTrace tt WITH(NOLOCK)
              ON tt.MachineTraceID = s.MachineTraceID AND tt.TableNo = s.TableNo AND tt.PickPos = s.PickPos
            LEFT JOIN dbo.PUB_UniqueCode u WITH(NOLOCK) ON u.UniqueCode = tt.UniqueCode
            WHERE s.PanelCode IN (${inl})`, {}).catch(() => []),
      /* ★ v6.0 新增：SMT 过站表里的 轨道（Lane）/ 载具 / 工站。
         用户原话要求「SMT段：载具/穴位/轨道/贴装吸嘴/材料厂商/批次/生产时间」——
         其中「轨道」只有过站表有（Lane 列，SMT_PanelCode 没有）。
         实测覆盖 100%（AOI-Front 两天 94,393 行，Lane/FixtureCode 全非空），
         300 块面板 333ms，可以直接进主流程。 */
      qSmt(`SELECT DISTINCT CAST(PanelCode AS varchar(60)) pan, CAST(Lane AS varchar(20)) lane,
              CAST(FixtureCode AS varchar(60)) fx, CAST(Station AS varchar(60)) stn
            FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK)
            WHERE PanelCode IN (${inl}) OPTION (MAXDOP 4)`, {}).catch(() => [])
    ]);
    out.board = out.board.concat(b);
    out.sub = out.sub.concat(s2);
    out.mat = out.mat.concat(m);
    out.sta = out.sta.concat(st);
  }
  return out;
}

async function smtAoiResult(panels) {
  const out = [];
  for (const c of chunk(panels, CHUNK)) {
    const inl = c.map(esc).join(',');
    const rows = await qSmt(
      `SELECT 'Rear' side, CAST(PanelCode AS varchar(60)) panel, SeqNo seq, MachineType machine,
              Result res, CAST(Ext6 AS varchar(60)) fixture, CAST(Ext8 AS varchar(80)) product,
              CAST(Ext9 AS varchar(80)) station, CAST(Ext10 AS varchar(40)) procn,
              CAST(OrderNo AS varchar(40)) morder, CreateTime t, ID aoiID
       FROM dbo.TS_AOI_Rear WITH(NOLOCK) WHERE PanelCode IN (${inl})
       UNION ALL
       SELECT 'Front', CAST(PanelCode AS varchar(60)), SeqNo, MachineType,
              Result, CAST(Ext6 AS varchar(60)), CAST(Ext8 AS varchar(80)),
              CAST(Ext9 AS varchar(80)), CAST(Ext10 AS varchar(40)),
              CAST(OrderNo AS varchar(40)), CreateTime, ID
       FROM dbo.TS_AOI_Front WITH(NOLOCK) WHERE PanelCode IN (${inl})`, {});
    for (const x of rows) out.push(x);
  }
  return out;
}

/* AOI 不良（Repair 表）：只有 PCBCode，靠 AOIID 挂回结果行 */
async function smtAoiRepair(ids) {
  if (!ids.length) return [];
  const out = [];
  for (const c of chunk(ids, CHUNK)) {
    for (const side of ['Rear', 'Front']) {
      try {
        const rows = await qSmt(
          `SELECT '${side}' side, AOIID, CAST(PCBCode AS varchar(60)) pcb, CAST(IssueCode AS varchar(40)) code,
                  CAST(IssueName AS varchar(120)) issue, CAST(Position AS varchar(80)) pos,
                  CAST(OtherInfo AS varchar(200)) info, CreateTime t
           FROM dbo.TS_AOI_${side}_Repair WITH(NOLOCK) WHERE AOIID IN (${c.map(x => Number(x)).filter(Number.isFinite).join(',') || '0'})`, {});
        for (const x of rows) out.push(x);
      } catch (e) { /* 某侧没有 Repair 表就跳过 */ }
    }
  }
  return out;
}

async function smtSpi(panels) {
  const out = [];
  for (const c of chunk(panels, CHUNK)) {
    const rows = await qSmt(
      `SELECT CAST(PanelCode AS varchar(60)) panel, SeqNo seq, Result res,
              CAST(Ext6 AS varchar(60)) fixture, CAST(Ext8 AS varchar(80)) product,
              CAST(Ext9 AS varchar(80)) station, CreateTime t
       FROM dbo.TS_SPI WITH(NOLOCK) WHERE PanelCode IN (${c.map(esc).join(',')})`, {});
    for (const x of rows) out.push(x);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   ④ ClickHouse：AOI 测量值
      · 目标板：该板所有点位全取
      · 邻居板：只取「目标板上 NG 的那些点位」（做对比够用了，全取是 146 MB）
   ──────────────────────────────────────────────────────────────── */
const AOI_METRICS = ['OffsetX', 'OffsetY', 'Rotation', 'Lift', 'Height'];

async function chAoi(panels, locFilter, range, seqList) {
  const useLoc = locFilter && locFilter.length;
  const sel = AOI_SEL;
  /* v6.5：seqList 给定时只取这些 ModuleID（= MES 的 SeqNo = 穴位）。
     pcs 口径下对照组的每一块 pcs 都要跟目标 pcs 同穴位才有可比性，
     所以这里把范围收紧到同穴位，样本量从「268 块板 × 280 个穴位」降到「268 个同穴位 pcs」。 */
  const useSeq = seqList && seqList.length;
  const where = (useLoc ? `AND Location_Name IN (${locFilter.map(esc).join(',')})` : '')
    + (useSeq ? ` AND ModuleID IN (${seqList.map(x => Number(x) || 0).join(',')})` : '')
    + chRange(range);
  const out = [];
  for (const c of chunk(panels, 260)) {
    const raw = await chQuery(
      `SELECT ${sel} FROM bigdata.AOI_D3F_detail_panelcode WHERE panelcode IN (${c.map(esc).join(',')}) ${where} FORMAT TSVWithNames`);
    for (const x of tsv(raw)) out.push(x);
    if (out.length > MAX_AOI_ROWS) break;
  }
  return out;
}

/* v6.0 新增：ClickHouse 到底有没有这些板的数据 —— 导出空表时给得出原因。
   ★ 实测（2026-10-26）：CH 只存一部分项目的 AOI 明细。10-23 这天的 1.14 亿行里，
     项目 A / B / C / D 有数据，项目 E / F / G 一块都没有
     （不是保留期问题，是这些项目压根没进 CH）。所以「导出明细空白」不是工具坏了，
     而是这块板在 CH 里没有量测值 —— 必须在界面上把这句话讲出来。 */
async function chCoverage(panels, range) {
  const out = { probed: 0, hit: 0, miss: [] };
  if (!panels || !panels.length) return out;
  const where = chRange(range);
  /* v6.6：分片并行（原来逐片串行，5 个 SN 实测 3.6 秒） */
  const chunks = chunk(panels, 260);
  const res = await Promise.all(chunks.map(c => chQuery(
    `SELECT panelcode, count() n FROM bigdata.AOI_D3F_detail_panelcode
      WHERE panelcode IN (${c.map(esc).join(',')}) ${where}
      GROUP BY panelcode FORMAT TSVWithNames`).then(tsv).catch(() => [])));
  chunks.forEach((c, k) => {
    const got = new Set(res[k].map(x => str(x.panelcode)));
    for (const p of c) {
      out.probed++;
      if (got.has(str(p))) out.hit++;
      else out.miss.push(str(p));
    }
  });
  return out;
}

/* 目标板在 AOI 里被判 NG 的点位（用来给邻居板筛位置） */
function ngLocations(aoiRows, targetPanels) {
  const set = new Set();
  const tp = new Set(targetPanels);
  for (const r of aoiRows) {
    if (!tp.has(str(r.panelcode))) continue;
    if (String(str(r.res)).toUpperCase() === 'NG') set.add(str(r.loc));
  }
  return [...set];
}

/* ────────────────────────────────────────────────────────────────
   ⑤ ClickHouse：SPI 测量值
      Base_Barcode 是基码；同一基码一天有多次检验，用 MES TS_SPI 的时间就近匹配那一次。
   ──────────────────────────────────────────────────────────────── */
const SPI_METRICS = ['Volume(%)', 'Area(%)', 'Height(mm)', 'OffsetX(mm)', 'OffsetY(mm)'];

async function chSpi(panels, spiTimes, targetPanels, range) {
  /* ★ SPI 测量值只取【目标板】：对照板的 SPI 不参与 compare（compare 只用 AOI 测量值），
     而每块板一次检验就是 3,870 行 —— 拉对照板纯属浪费（实测把 SPI 从 3.9 万行压到 4 千行）。 */
  const bases = uniq((targetPanels && targetPanels.length ? targetPanels : panels).map(baseCode));
  if (!bases.length) return [];
  /* 目标板必拉；对照板按上限截断。
     ★ 只带 `Board_Barcode=base` 而不带日期窗时，同一基码一整天的所有检验都会回来
       （实测单板 46 MB / 160 万行），80 块板直接 80 万行、进程假死。
       所以这里必须：① 带日期窗 ② 每板 LIMIT 6000（一次 SPI 检验约 3,870 行）。 */
  const tgt = new Set((targetPanels || []).map(baseCode));
  const ordered = bases.slice().sort((a, b) => (tgt.has(b) ? 1 : 0) - (tgt.has(a) ? 1 : 0));
  const use = ordered.slice(0, Math.min(Math.max(MAX_SPI_PANELS, tgt.size), 16));
  const win = chRange(range, 'Inspection_Time');
  /* ★ v6.6：原来是逐板串行 await。实测 5 个 SN 时这一项独占 10.6 秒
     （拆分：chAoi 目标 3.7s + chAoi 邻居 3.1s + chCoverage 3.6s + chSpi 10.6s，总共 20.9s）。
     改成并发 4：ClickHouse 是 HTTP 端，单条查询走的是不同分片，并发对它没有副作用，
     而且这里每块板只取一次检验（带日期窗 + LIMIT 5000），行数可控。 */
  const CONC = 4;
  const parts = [];
  let i = 0;
  async function worker() {
    while (i < use.length) {
      const b = use[i++];
      /* 该基码对应的 MES 时间（同基码多块板时取最早那条），用来精确到「哪一次检验」 */
      let t0 = null;
      for (const [p, t] of Object.entries(spiTimes)) {
        if (baseCode(p) !== b) continue;
        if (!t0 || new Date(t) < new Date(t0)) t0 = t;
      }
      const near = t0
        ? ` AND Inspection_Time >= '${ymd(new Date(t0).getTime() - SPI_WIN_MIN * 60000)}'` +
          ` AND Inspection_Time <= '${ymd(new Date(t0).getTime() + SPI_WIN_MIN * 60000)}'`
        : '';
      try {
        const raw = await chQuery(
          `SELECT ${SPI_SEL}
           FROM bigdata.SPI_SX_detail_panelcode
           WHERE Board_Barcode = ${esc(b)} ${near || win}
           ORDER BY Inspection_Time LIMIT 5000 FORMAT TSVWithNames`);
        parts.push(tsv(raw));
      } catch (e) { /* 单块板失败不影响其他板 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, use.length) || 1 }, () => worker()));

  const out = [];
  const seen = new Set();
  for (const rows of parts) {
    for (const x of rows) {
      const k = str(x.barcode) + '|' + str(x.modid) + '|' + str(x.comp) + '|' + str(x.pad) + '|' + str(x.t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   ⑥ 后段：不良 + 过站
   ──────────────────────────────────────────────────────────────── */
async function beTrace(sns, panels) {
  const defects = [], stations = [];
  for (const c of chunk(sns, CHUNK)) {
    const rows = await qBe(
      `SELECT CAST(d.ProBar AS varchar(60)) sn, CAST(d.Process AS varchar(40)) procn,
              CAST(d.ResCode AS varchar(60)) lane, CAST(d.ecode AS varchar(120)) code,
              CAST(d.ECodeMemo AS varchar(300)) memo, d.TestNumber retest, d.IResult res,
              d.CreateTime t, CAST(d.ecgcode AS varchar(60)) grp
       FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK)
       WHERE d.ProBar IN (${c.map(esc).join(',')}) ORDER BY d.ProBar, d.CreateTime`, {});
    for (const x of rows) defects.push(x);
  }
  /* 过站只按 PanelCode 查：IX_PanelCode(PanelCode) 命中 43ms；
     ✗ 不能按 PCBCode 查 —— IX_PanelPCBCode 的最左列是 PanelCode，PCBCode 单查实测
       123~145 秒（全表扫 10 亿行，加时间窗也一样慢）。后段板其实就是前段面板码，
       所以用 PanelCode 已经够；真要按 PCBCode 追，得先经 TRS_Base_PCBCode 换成 PanelCode。 */
  /* 后段过站表的 PanelCode 列可能存前段面板码、也可能直接存 SN 本身（两种实测都有），
     所以两套值都塞进 PanelCode 的 IN 里 —— 这条走 IX_PanelCode，200 板 43ms 级别。 */
  const cand = uniq([...panels, ...sns]);
  for (const c of chunk(cand, CHUNK)) {
    const inl = c.map(esc).join(',');
    const rows = await qBe(
      `SELECT CAST(t.PCBCode AS varchar(60)) sn, CAST(t.PanelCode AS varchar(60)) panel,
              CAST(t.Process AS varchar(40)) procn, CAST(t.Station AS varchar(80)) station,
              CAST(t.SerialNo AS varchar(60)) lane, CAST(t.MachineType AS varchar(60)) machine,
              CAST(t.LineName AS varchar(60)) line, CAST(t.FixtureCode AS varchar(60)) fixture,
              t.CreateTime t, t.OkCount okCount, t.ProcessType pt
       FROM dbo.TRS_Busi_StationTrace t WITH(NOLOCK)
       WHERE t.PanelCode IN (${inl}) ORDER BY t.CreateTime`, {});
    for (const x of rows) stations.push(x);
  }
  return { defects, stations };
}

/* ────────────────────────────────────────────────────────────────
   ⑦ 对照统计：目标板指标 vs 邻居板同点位分布
   ──────────────────────────────────────────────────────────────── */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function compare(targetAoi, neighAoi, targetPanels, opt) {
  const o = opt || {};
  const tp = new Set(targetPanels.map(String));
  /* ★ v6.5 修真 bug：pcs 口径下，60 个对照 pcs 大多和目标 pcs 在【同一块 panel】上，
     而这里原来只要 panelcode 属于目标板就 continue —— 于是对照组被全部丢掉，
     「测试值对照」直接变成空表（实测 chAoi 有 4 行邻居数据、compare 输出 0 行）。
     pcs 口径改按「哪一块 pcs」排除：CH 的 ModuleID 就是 MES 的 SeqNo，
     所以目标 pcs 的身份是 panelcode + ModuleID，同一块板上其余穴位都算对照。
     另外 pcs 口径下每块 pcs 只有自己那一个 ModuleID，用 loc|modid 做键会让目标
     和对照永远对不上，改成只用 loc（同一个元件位置）做键。 */
  const pcsMode = !!o.pcsMode;
  const tgtPcs = o.targetKeys || null;      /* Set('panel|modid') */
  const keyOf = r => pcsMode ? str(r.loc) : (str(r.loc) + '|' + str(r.modid));
  /* ★ 早先每遇到一条目标板行，就把对照组同点位的值重新 map+sort 一遍：
     14,027 条目标行 × 6 个指标 × 每次排 1.5 万个值 ≈ 十亿级运算，直接把进程卡住
     （实测跑过 10 分钟不出结果）。改成「每个 点位|穴位 只排一次」，复用结果。 */
  const tgt = [];
  const baseIdx = new Map();
  for (const r of targetAoi) if (tp.has(str(r.panelcode))) tgt.push(r);
  for (const r of neighAoi) {
    if (pcsMode) {
      if (tgtPcs && tgtPcs.has(str(r.panelcode) + '|' + str(r.modid))) continue;
    } else if (tp.has(str(r.panelcode))) continue;
    const k = keyOf(r);
    let b = baseIdx.get(k);
    if (!b) { b = {}; baseIdx.set(k, b); }
    for (const m of AOI_METRICS) {
      const v = num(r[m]);
      if (v == null) continue;
      (b[m] = b[m] || []).push(v);
    }
  }
  const stat = new Map();
  for (const [k, b] of baseIdx) {
    const st = {};
    for (const m of AOI_METRICS) {
      const arr = b[m];
      if (!arr || arr.length < 20) continue;
      arr.sort((a, x) => a - x);
      st[m] = {
        p5: quantile(arr, 0.05), p50: quantile(arr, 0.50), p95: quantile(arr, 0.95),
        iqr: quantile(arr, 0.75) - quantile(arr, 0.25), n: arr.length
      };
    }
    stat.set(k, st);
  }
  const out = [];
  for (const r of tgt) {
    const k = keyOf(r);
    const st = stat.get(k);
    if (!st) continue;
    for (const m of AOI_METRICS) {
      const v = num(r[m]);
      if (v == null) continue;
      const q = st[m];
      if (!q) continue;
      out.push({
        sn: str(r.panelcode), modid: num(r.modid), loc: str(r.loc), metric: m,
        val: +v.toFixed(4), p5: +q.p5.toFixed(4), p50: +q.p50.toFixed(4), p95: +q.p95.toFixed(4),
        iqr: +q.iqr.toFixed(4), n: q.n, outOf: v < q.p5 || v > q.p95, res: str(r.res),
        dev: q.iqr > 0 ? +((v - q.p50) / q.iqr).toFixed(2) : null
      });
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   ⑧ 主流程
   ──────────────────────────────────────────────────────────────── */
/* 分段计时：SN_TRACE_PROF=1 时把每步耗时打到 stderr，便于定位慢在哪一步。
   默认关闭，不影响任何业务逻辑，也不进接口返回体。 */
function profMark(bag, name, t) {
  bag[name] = (bag[name] || 0) + (Date.now() - t);
}

async function trace(sns, opt) {
  const t0 = Date.now();
  const errors = [];
  const o = opt || {};
  const PROF = process.env.SN_TRACE_PROF === '1';
  const P = {};
  const mark = name => { if (PROF) profMark(P, name, t0); };

  let _t = Date.now();
  const map = await resolve(sns);
  const rows = sns.map(s => map[s]);
  if (PROF) P.resolve = Date.now() - _t;

  /* 邻居
     v6.5：默认走 pcs 口径（前后各 N 个单板），不再是「前后各 N 块 panel」。
     传 neighborPcs 或什么都不传都用 pcs；只有显式传 neighborN 才回退旧的块数口径
     （对拍工具 parity_check.js 的老 case 靠这个保持可比）。 */
  const pcsMode = !o.neighborN;
  const wantPcs = Math.max(1, Math.min(500, Number(o.neighborPcs) || 30));
  let nb = { before: [], after: [] };
  if (o.neighbors !== false) {
    try {
      _t = Date.now();
      nb = pcsMode
        ? await neighborsPcs(rows.filter(r => r.panel), wantPcs)
        : await neighbors(rows.filter(r => r.panel), o.neighborN);
      if (PROF) P.neighbors = Date.now() - _t;
    } catch (e) { errors.push((pcsMode ? '邻居 pcs 查询失败：' : '邻居板查询失败：') + e.message); }
    if (nb.notes && nb.notes.length) errors.push(...nb.notes);
  }

  const targetPanels = uniq(rows.map(r => r.panel));
  const neighPanels = uniq([...nb.before.map(x => x.panel), ...nb.after.map(x => x.panel)]);
  const allPanels = uniq([...targetPanels, ...neighPanels]).slice(0, MAX_PANELS);
  if (targetPanels.length + neighPanels.length > MAX_PANELS) {
    errors.push(`板太多，只分析前 ${MAX_PANELS} 块（目标 ${targetPanels.length} 块 + 邻居 ${neighPanels.length} 块）`);
  }
  /* pcs 口径下对照组只取目标板的那些穴位：每块 pcs 只跟同穴位的目标 pcs 比才可比，
     样本量从「268 板 × 280 穴位」降到「268 pcs × 同穴位」。 */
  const targetSeqs = pcsMode ? uniq(rows.map(r => Number(r.seq)).filter(Number.isFinite)) : null;

  /* 前段 MES：只拉【目标板】的全量行。
     ★ 对照板（前后各 200 块）的 MES 全量行不在这里拉 —— 实测 600 块板会拉回
       21 万条过站 + 65 万条 AOI，主查询从 40 秒涨到 190 秒，而页面上根本展示不了这么多。
       对照板这边只需要 ClickHouse 的同点位测量值（下面 chAoi）来算偏移；
       要「对照板的过站记录」时，用户点导出，走 exportStations() 单独取。 */
  const M = { stations: [], aoi: [], spi: [], repair: [], dims: { board: [], sub: [], mat: [] } };
  _t = Date.now();
  await Promise.all([
    smtStations(targetPanels).then(r => M.stations = r).catch(e => errors.push('前段过站查询失败：' + e.message)),
    smtAoiResult(targetPanels).then(r => M.aoi = r).catch(e => errors.push('前段 AOI 查询失败：' + e.message)),
    smtSpi(targetPanels).then(r => M.spi = r).catch(e => errors.push('前段 SPI 查询失败：' + e.message)),
    smtDims(targetPanels).then(r => M.dims = r).catch(e => errors.push('前段载具/材料查询失败：' + e.message))
  ]);

  /* ClickHouse：先取目标板全量 → 得到 NG 点位 → 再取邻居板在这些点位上的值
     ★ 必须带日期窗（见 chRange 注释）：目标板 ±3 天、邻居板覆盖它们自己的时间范围。 */
  const rowTimes = rows.map(r => new Date(r.t).getTime()).filter(Number.isFinite);
  const nbTimes = [...nb.before, ...nb.after].map(x => new Date(x.t).getTime()).filter(Number.isFinite);
  const allT = rowTimes.concat(nbTimes);
  /* ★ v6.6：原来给 3 天余量，实测这直接把 ClickHouse 的扫描窗撑到 300 小时
     （chAoi 目标板 2.3s → 1.3s 只要把余量收到 6 小时）。余量只是为了容忍
     机台时钟偏移与跨天边界，6 小时足够 —— 邻居板自己的时间已经在 allT 里，
     窗口本来就覆盖它们。 */
  const mr = 6 * 3600000;
  const range = allT.length
    ? { a: Math.min(...allT) - mr, b: Math.max(...allT) + mr }
    : null;
  let tAoi = [], nAoi = [], spiCh = [], chCov = { probed: 0, hit: 0, miss: [] };
  /* v6.0：目标板在 CH 里没有 AOI 量测值时，「测试值对照」永远算不出来。
     CH 只存一部分项目/机台（实测某些项目一块都没有），
     这时不能静默给空表，要在 report 里挂一个明确的原因。 */
  let chNote = null;
  /* ★ v6.6：ClickHouse AOI / SPI 与后段查询原来是三段串行 await，
     实测 5 个 SN 时 neighborsPcs 8.7s + CH 5s + SPI + BE 1s ≈ 20s。
     CH 走 HTTP、BE 走另一套连接池，彼此不抢资源，改成并行后能省掉串行的等待。
     注意 chAoi(邻居) 必须等 chAoi(目标板) 拿到 NG 点位，所以那两步仍保持内部顺序。 */
  if (PROF) { P.smt4 = Date.now() - _t; _t = Date.now(); }
  const chTask = (async () => {
    try {
      let _c = Date.now();
      tAoi = await chAoi(targetPanels, null, range);
      if (PROF) { P.chAoiTgt = Date.now() - _c; _c = Date.now(); }
      const locs = ngLocations(tAoi, targetPanels);
      if (neighPanels.length) {
        if (pcsMode) {
          /* pcs 口径：对照 pcs 的穴位号跟目标不同（每块 pcs 只有一个 ModuleID），
             所以不能按 ModuleID 过滤，改成按「对照 pcs 名单」过滤 ——
             否则同一块 panel 上没被选中当对照的那些 pcs 也会混进来，
             用户选了 30 个对照，实际基准却是 280 个，和他以为的不是一回事。 */
          const keep = new Set([...nb.before, ...nb.after].map(x => str(x.panel) + '|' + String(Number(x.seq))));
          const raw = await chAoi(neighPanels, null, range, null);
          nAoi = raw.filter(r => keep.has(str(r.panelcode) + '|' + String(Number(r.modid))));
        } else {
          nAoi = locs.length ? await chAoi(neighPanels, locs, range)
            : await chAoi(neighPanels.slice(0, 60), null, range);   /* 目标板没有 NG 点位时，邻居只取 60 块看整体 */
        }
      }
      if (PROF) { P.chAoiNb = Date.now() - _c; _c = Date.now(); }
      chCov = await chCoverage(targetPanels, range).catch(() => chCov);
      if (PROF) P.chCov = Date.now() - _c;
      if (chCov.probed && !chCov.hit) {
        chNote = '这 ' + chCov.probed + ' 块目标板在 ClickHouse 的 AOI 明细里一条都没有'
          + '（CH 只覆盖一部分项目/机台，与 MES 有没有检验记录无关），'
          + '所以没有量测值可比、没有偏移可算，明细与测试值对照导出会是空表。'
          + '过站记录、BE 不良、SMT 过站/载具/材料仍可正常分析。';
      } else if (chCov.probed && chCov.hit < chCov.probed) {
        chNote = '目标板 ' + chCov.probed + ' 块里只有 ' + chCov.hit + ' 块在 ClickHouse 有量测值，'
          + '另外 ' + (chCov.probed - chCov.hit) + ' 块的明细会是空的。';
      }
    } catch (e) { errors.push('ClickHouse AOI 取数失败：' + e.message); }
  })();

  /* SPI：每块板的 MES 时间 → 就近匹配 ClickHouse 的那一次检验 */
  const spiTimes = {};
  for (const r of M.spi) {
    const p = str(r.panel), t = r.t;
    if (!p || !t) continue;
    if (!spiTimes[p] || new Date(t) < new Date(spiTimes[p])) spiTimes[p] = t;
  }
  const spiTask = (async () => {
    const _c = Date.now();
    try { spiCh = await chSpi(allPanels, spiTimes, targetPanels, range); }
    catch (e) { errors.push('ClickHouse SPI 取数失败：' + e.message); }
    finally { if (PROF) P.chSpi = Date.now() - _c; }
  })();

  /* 后段：与 CH 两条并行跑 */
  let B = { defects: [], stations: [] };
  const beTask = (async () => {
    const _c = Date.now();
    try { B = await beTrace(sns, targetPanels); }
    catch (e) { errors.push('后段查询失败：' + e.message); }
    finally { if (PROF) P.be = Date.now() - _c; }
  })();
  _t = Date.now();
  await Promise.all([chTask, spiTask, beTask]);
  if (PROF) P.chBe = Date.now() - _t;

  /* 对照 */
  const tgtKeys = pcsMode
    ? new Set(rows.filter(r => r.panel && r.seq != null).map(r => str(r.panel) + '|' + String(Number(r.seq))))
    : null;
  /* ★ pcs 口径下「目标」只该是你查的那一块 pcs，不能是整块 panel 的 280 块 pcs ——
     否则测试值对照会膨胀成 2 万多行（实测），既不是用户问的，导出来也没法看。
     CH 的 ModuleID 就是 MES 的 SeqNo，所以用 panel + ModuleID 精确圈住目标 pcs。 */
  const tAoiTgt = pcsMode && tgtKeys
    ? tAoi.filter(r => tgtKeys.has(str(r.panelcode) + '|' + String(Number(r.modid))))
    : tAoi;
  const cmp = pcsMode
    ? compare(tAoiTgt, nAoi, targetPanels, { pcsMode: true, targetKeys: tgtKeys })
    : compare(tAoi, nAoi, targetPanels);

  /* 返回分两块：
     · report —— 给前端渲染的轻量结构（不含百万行明细）
     · raw    —— 明细导出要用的原始行，只放在服务端缓存里，不进 HTTP 响应 */
  if (PROF) { P.total = Date.now() - t0; console.error('[sn_trace prof] ' + JSON.stringify(P)); }
  const report = {
    ms: Date.now() - t0,
    sns, rows,
    mode: pcsMode ? 'pcs' : 'panel',
    prof: PROF ? P : undefined,
    neighbors: {
      n: pcsMode ? wantPcs : (o.neighborN || NEIGHBOR_N),
      unit: pcsMode ? 'pcs' : 'panel',
      before: nb.before.length, after: nb.after.length,
      list: [...nb.before.map(x => ({ panel: x.panel, pcb: x.pcb || null, seq: x.seq || null, t: x.t, side: 'before' })),
             ...nb.after.map(x => ({ panel: x.panel, pcb: x.pcb || null, seq: x.seq || null, t: x.t, side: 'after' }))].slice(0, 800)
    },
    panels: pcsMode
      ? { target: targetPanels.length, neighborPcs: nb.before.length + nb.after.length,
          neighborPanels: neighPanels.length, neighborPcsBefore: nb.before.length,
          neighborPcsAfter: nb.after.length, total: allPanels.length,
          /* 兼容老页面：neighbor 字段按 pcs 填，前端优先读 neighborPcs */
          neighbor: neighPanels.length }
      : { target: targetPanels.length, neighbor: neighPanels.length, total: allPanels.length },
    targetPanels,
    counts: {
      smtStations: M.stations.length, smtAoi: M.aoi.length, smtSpi: M.spi.length,
      chAoi: tAoi.length, chAoiNeighbor: nAoi.length, chSpi: spiCh.length,
      beDefects: B.defects.length, beStations: B.stations.length,
      /* v6.0：ClickHouse 覆盖情况 —— probed 块里只有 hit 块有量测值。
         hit=0 说明「明细导出空白」不是工具问题，是这些板没进 CH。 */
      chProbed: chCov.probed, chHit: chCov.hit, chMiss: chCov.miss.slice(0, 40)
    },
    compare: cmp,
    chNote,
    errors
  };
  const raw = { rows, targetPanels, neighPanels, neighPcs: pcsMode ? [...nb.before, ...nb.after] : [], mode: pcsMode ? 'pcs' : 'panel', smt: M, be: B, chAoi: tAoi, chNeighborAoi: nAoi, chSpi: spiCh };
  return { report, raw };
}

/* ────────────────────────────────────────────────────────────────
   ⑨ 共性分析（≥2 个 SN 才有意义）：把每个 SN 在各维度上的取值摊开，
      数「几个 SN 落在同一个取值上」。这和主分析的 lift 不是一回事 ——
      样本少算不出显著性，这里只讲「几个人撞到一起」。
   ──────────────────────────────────────────────────────────────── */
/* v6.0：跨 SN 共性维度按「用户说的口径」重排 ——
   ① BE 段先看：测试设备 / 工位(holder) / 穴位 / 轨道 / 生产时间
      （以前是 机台 / 工站 / 工序 / 工位码 / 不良现象 / 不良点位，
        后三项是「结果不是原因」，已经删掉）
   ② 再看 SMT 段：载具 / 穴位 / 轨道 / 贴装机台 / 吸嘴 / 飞达 / 材料厂商 / 材料批次 / 生产时间
   ③ 最后是 SPI / AOI 的测量值异常
   工位 / 穴位 / 轨道三项由 SerialNo·ResCode 解析而来（见 becode.js），
   以前整根编码当「工位」用，等于没拆。 */
const COMMON_DIMS = [
  /* ① BE 段 */
  { key: 'beMachine',  group: 'BE',  label: 'BE 测试机台',   get: r => r.beMachines },
  { key: 'beHolder',   group: 'BE',  label: 'BE 工位（holder）', get: r => r.beHolders },
  { key: 'beSeat',     group: 'BE',  label: 'BE 穴位',       get: r => r.beSeats },
  { key: 'beRail',     group: 'BE',  label: 'BE 轨道',       get: r => r.beRails },
  { key: 'beProc',     group: 'BE',  label: 'BE 工序',       get: r => r.beProcs },
  { key: 'beDay',      group: 'BE',  label: 'BE 生产日',     get: r => r.beDays },
  /* ② SMT 段 */
  { key: 'smtFixture', group: 'SMT', label: 'SMT 载具',      get: r => r.smtFixtures },
  { key: 'smtLane',    group: 'SMT', label: 'SMT 轨道',      get: r => r.smtLanes },
  { key: 'smtSeq',     group: 'SMT', label: 'SMT 穴位',      get: r => r.smtSeqs },
  { key: 'smtMachine', group: 'SMT', label: 'SMT 贴装机台',  get: r => r.smtMachines },
  { key: 'smtNozzle',  group: 'SMT', label: 'SMT 贴装吸嘴',  get: r => r.smtNozzles },
  { key: 'smtFeeder',  group: 'SMT', label: 'SMT 飞达',      get: r => r.smtFeeders },
  { key: 'smtMatr',    group: 'SMT', label: 'SMT 材料料号',  get: r => r.smtMatrs },
  { key: 'smtVendor',  group: 'SMT', label: 'SMT 材料厂商',  get: r => r.smtVendors },
  { key: 'smtLot',     group: 'SMT', label: 'SMT 材料批次',  get: r => r.smtLots },
  { key: 'smtDay',     group: 'SMT', label: 'SMT 生产日',    get: r => r.smtDays },
  { key: 'smtMorder',  group: 'SMT', label: 'SMT 工单',      get: r => r.smtMorders },
  /* ③ 检测值 */
  { key: 'aoiLoc',     group: 'AOI', label: 'AOI 判 NG 点位', get: r => r.aoiNgLocs },
  { key: 'spiStation', group: 'SPI', label: 'SPI 工站',      get: r => r.spiStations }
];

function buildRows(rep) {
  const raw = rep.raw;
  const isTgt = new Set(rep.report.targetPanels);
  const byPanel = groupBy(raw.smt.stations || [], r => str(r.panel));
  const aoiByPanel = groupBy(raw.smt.aoi || [], r => str(r.panel));
  const spiByPanel = groupBy(raw.smt.spi || [], r => str(r.panel));
  const ngLoc = groupBy((raw.chAoi || []).filter(r => String(str(r.res)).toUpperCase() === 'NG'),
    r => str(r.panelcode));
  /* v6.0：载具/钢网/吸嘴/飞达/材料厂商/批次的原始行（smtDims 取回来的） */
  const bdAll = (raw.smt && raw.smt.dims) || {};
  const bd = { board: bdAll.board || [], sub: bdAll.sub || [], mat: bdAll.mat || [], sta: bdAll.sta || [] };

  return rep.report.rows.map(r => {
    const panel = r.panel;
    const st = byPanel.get(panel) || [];
    const aoi = aoiByPanel.get(panel) || [];
    const spi = spiByPanel.get(panel) || [];
    const beDef = (raw.be.defects || []).filter(x => str(x.sn) === str(r.sn));
    const beSt = (raw.be.stations || []).filter(x => str(x.sn) === str(r.sn) || str(x.panel) === panel);
    const ngL = (ngLoc.get(panel) || []).map(x => str(x.loc));
    /* BE 编码：过站 SerialNo + 不良 ResCode 一起拆，两边同一套解析 */
    const beCodes = beSt.map(x => BEC.parse(x.lane)).concat(beDef.map(x => BEC.parse(x.lane))).filter(Boolean);
    return {
      sn: r.sn, panel, seq: r.seq, product: r.product, machine: r.machine, t: r.t, src: r.src,
      smtMachines: uniq(st.map(x => str(x.machine))),
      smtStations: uniq(st.map(x => str(x.station)).concat(
        bd.sta.filter(x => str(x.pan) === panel).map(x => str(x.stn)))),
      smtFixtures: uniq(st.map(x => str(x.fixture)).concat(
        bd.sta.filter(x => str(x.pan) === panel).map(x => str(x.fx)))),
      smtLanes: uniq(bd.sta.filter(x => str(x.pan) === panel).map(x => str(x.lane))),
      smtMorders: uniq(st.map(x => str(x.morder)).concat(aoi.map(x => str(x.morder)))),
      smtProducts: uniq(st.map(x => str(x.product)).concat(aoi.map(x => str(x.product))).concat(spi.map(x => str(x.product)))),
      aoiNgCount: aoi.filter(x => Number(x.res) === 0).length,
      aoiNgLocs: uniq(ngL),
      spiStations: uniq(spi.map(x => str(x.station))),
      spiNg: spi.filter(x => Number(x.res) === 0).length,
      beMachines: uniq(beSt.map(x => str(x.machine))),
      beStations: uniq(beSt.map(x => str(x.station))),
      beProcs: uniq(beSt.map(x => str(x.procn))),
      beLanes: uniq(beSt.map(x => str(x.lane))),
      beIssues: uniq(beDef.map(x => str(x.code))),
      bePoints: uniq(beDef.map(x => str(x.lane))),
      /* v6.0：把 SerialNo / ResCode 拆成 机台 / 工位 / 穴位 / 轨道 / 生产日
         —— 以前整根编码当「工位」，两个 SN 永远「不一样」，等于看不出共性 */
      beHolders: uniq(beCodes.map(c => c.holder)),
      beSeats: uniq(beCodes.map(c => c.seat)),
      beRails: uniq(beCodes.map(c => c.lane)),
      beDays: uniq(beSt.map(x => dayOf(x.t)).concat(beDef.map(x => dayOf(x.t)))),
      /* v6.0：SMT 段的载具/穴位/吸嘴/飞达/材料厂商/批次/生产日 */
      smtSeqs: uniq(st.map(x => String(x.seq == null ? '' : x.seq)).concat(String(r.seq == null ? '' : r.seq))),
      smtNozzles: uniq((bd.sub || []).filter(x => str(x.pan) === panel).map(x => str(x.nz))),
      smtFeeders: uniq((bd.sub || []).filter(x => str(x.pan) === panel).map(x => str(x.fd))),
      smtMatrs: uniq((bd.mat || []).filter(x => str(x.pan) === panel).map(x => str(x.matr))),
      smtLots: uniq((bd.mat || []).filter(x => str(x.pan) === panel).map(x => str(x.lot))),
      smtVendors: uniq((bd.mat || []).filter(x => str(x.pan) === panel).map(x => str(x.vd))),
      smtDays: uniq(st.map(x => dayOf(x.t)).concat(aoi.map(x => dayOf(x.t)))),
      smtSteels: uniq((bd.board || []).filter(x => str(x.pan) === panel).map(x => str(x.st))),
      /* 角色：用户贴进来的 SN = 你查的；其他（邻居/参考）在导出里才出现，直接标「参考」 */
      role: 'target',
      beNgStations: beSt.filter(x => Number(x.okCount) === 0).length,
      beDefects: beDef.length,
      stations5: st.slice(0, 200).map(x => ({ proc: str(x.procn), station: str(x.station), machine: str(x.machine), lane: str(x.lane), t: x.t, ok: x.okCount })),
      beStations5: beSt.map(x => ({ proc: str(x.procn), station: str(x.station), machine: str(x.machine), line: str(x.line), lane: str(x.lane), t: x.t, ok: x.okCount })),
      beIssueRows: beDef.map(x => ({ proc: str(x.procn), issue: str(x.code), memo: str(x.memo), point: str(x.lane), retest: x.retest, t: x.t })),
      aoiRows: aoi.slice(0, 120).map(x => ({ side: str(x.side), proc: str(x.procn), seq: x.seq, res: x.res, t: x.t }))
    };
  });
}

function crossSn(rows) { return crossSnFor(rows, COMMON_DIMS); }

/* v6.6：允许只算部分维度 —— BE 单段追溯只有 BE 那 6 维的数据，
   传全量 COMMON_DIMS 会算出 14 个空维度，前端要一个个判空，容易漏判成「没有共性」。
   这里按传入的维度列表算，输出结构完全一致。 */
function crossSnFor(rows, dims) {
  const n = rows.length;
  const out = {};
  for (const d of (dims || COMMON_DIMS)) {
    const m = new Map();
    for (const r of rows) {
      const seen = new Set();
      for (const v of (d.get(r) || [])) {
        if (!v || seen.has(v)) continue;
        seen.add(v);
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(r.sn);
      }
    }
    /* ★ v6.0 修的判定口径：以前界面上只要「某个取值覆盖了全部 SN」就写「全部相同」。
       但这批板每块板往往有多个取值（穴位 04/08/01、轨道 R/L），
       把「有一项撞上」说成「全都一样」是假结论 —— 用户就是在投诉这个。
       现在同时给 allSame（每块板都只有这一个取值，且彼此相同）与 maxPerSn（单块板最多几个取值）。 */
    let maxPerSn = 0;
    for (const r of rows) maxPerSn = Math.max(maxPerSn, uniq((d.get(r) || []).filter(Boolean)).length);
    const items = [...m.entries()]
      .map(([v, sns]) => ({ value: v, n: sns.length, sns }))
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
    out[d.key] = { key: d.key, label: d.label, items,
      maxPerSn, allSame: maxPerSn === 1 && items.length === 1 };
  }
  return { n, dims: out };
}

/* ────────────────────────────────────────────────────────────────
   ⑩ 导出：明细（每板每点位一行）+ 汇总（每板每站一行）
   ──────────────────────────────────────────────────────────────── */
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(head, rows) {
  return '\ufeff' + [head.join(',')]
    .concat(rows.map(r => r.map(csvEscape).join(','))).join('\r\n');
}

/* 把 Date / 字符串统一成 YYYY-MM-DD；mssql 返回 Date 时 String() 是长串，不能直接切。
   ★ v6.6 修的真 bug：这里原来用本地 getter（getFullYear/getMonth/getDate）。
     mssql 驱动默认 useUTC:true，把 SQL Server 的 datetime 当成 UTC 塞进 Date
     （实测 Date.toISOString() 与 DB 存值逐位一致）。本机 GMT+8，用本地 getter 等于
     把 MES 墙钟时间整体 +8 小时 —— DB 里 10-24 20:00 生产的不良会被算到 10-25。
     这直接影响 beDays / smtDays 两个「生产日」维度：跨 SN 比对时会凭空造出
     「同一天」或「不同天」的假结论。统一改成 UTC 分量，与 date_utils.mesDayOf 同源。 */
function dayOf(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    const p = n => String(n).padStart(2, '0');
    return v.getUTCFullYear() + '-' + p(v.getUTCMonth() + 1) + '-' + p(v.getUTCDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/* 明细：两段拼在一起（用「来源」列区分），不做笛卡尔积
     · AOI：每块板 × 每个穴位 × 每个点位一行，指标并排
     · SPI：每块板 × 每个穴位 × 每个元件 × 每个 PAD 一行
   ★ 早先把 SPI 行按 板+穴位 挂到每条 AOI 行上，6930 × 72 ≈ 50 万行、全是假组合，
     已经改掉：SPI 与 AOI 的「元件」不是同一套编码，硬拼出来的行没有意义。 */
function exportDetail(raw, which) {
  const head = ['来源', '板号', '角色', '是否目标板', '穴位', '点位/元件', 'PAD', '结果', '缺陷',
    'OffsetX', 'OffsetY', 'Rotation', 'Lift', 'Height', 'Volume%', 'Area%', 'Height_mm', '检验时间'];
  const rows = [];
  const isTarget = new Set(raw.targetPanels.map(String));
  const wantTarget = which === 'target' ? true : which === 'neighbor' ? false : null;

  for (const a of (raw.chAoi || [])) {
    const panel = str(a.panelcode);
    const tgt = isTarget.has(panel) || isTarget.has(baseCode(panel));
    if (wantTarget !== null && wantTarget !== tgt) continue;
    /* ★ v6.5 修真 bug：这一行原来只 push 了 17 个字段，表头是 18 列，漏了「是否目标板」，
       导致 AOI 那几千行的 OffsetX/OffsetY/Rotation/Lift/Height 全部向右错位一格，
       Excel 里看就是「OffsetX 里是 OffsetY 的值」。
       顺手把穴位与点位分清：CH 的 ModuleID 就是 MES 的 SeqNo（穴位），
       Location_Name 是元件位置名（J_ANT14 这种），不是穴位号。 */
    rows.push(['AOI', panel, tgt ? '目标板' : '对照板', tgt ? '是' : '否',
      str(a.modid), str(a.loc) || str(a.comp), '', str(a.res), str(a.defect),
      str(a.OffsetX), str(a.OffsetY), str(a.Rotation), str(a.Lift), str(a.Height), '', '', '', str(a.t)]);
    if (rows.length >= MAX_DETAIL_ROWS) break;
  }
  if (rows.length < MAX_DETAIL_ROWS) {
    for (const s of (raw.chSpi || [])) {
      const base = str(s.barcode);
      const tgt = isTarget.has(base) || [...isTarget].some(p => baseCode(p) === base);
      if (wantTarget !== null && wantTarget !== tgt) continue;
      rows.push(['SPI', base, tgt ? '你查的' : '参考', tgt ? '目标板' : '对照板', str(s.modid), str(s.comp), str(s.pad), str(s.res), '',
        '', '', '', '', '', str(s.vol), str(s.area), str(s.hgt), str(s.t)]);
      if (rows.length >= MAX_DETAIL_ROWS) break;
    }
  }
  /* ★ v5.1：以前这里空就直接返回空表，用户拿到一个只有表头的文件不知道为什么。
     现在把原因说清楚，并且把「为什么空」写进 CSV 第一行（带 # 前缀，Excel 一眼能看见）。 */
  if (!rows.length) {
    let why;
    const nAoi = (raw.chAoi || []).length, nSpi = (raw.chSpi || []).length;
    if (!nAoi && !nSpi) {
      why = '这块板在 ClickHouse 的 AOI/SPI 明细里查不到测量值记录（MES 有检验记录，但测量值没进 ClickHouse）。'
        + '常见原因：① 传进来的是面板码而不是 SN，ClickHouse 的 AOI 明细用板号索引；'
        + '② 这块板的检验时间在 ClickHouse 保留期之前；③ 这一站没有量测项（只判结果）。';
    } else {
      why = 'ClickHouse 里这块板有 ' + nAoi + ' 条 AOI / ' + nSpi + ' 条 SPI 测量值，但都被「' +
        (which === 'neighbor' ? '只看对照板' : which === 'target' ? '只看目标板' : '全部') + '」这个筛选条件排除了。';
    }
    return { head, rows, truncated: false, empty: true, reason: why };
  }
  return { head, rows, truncated: rows.length >= MAX_DETAIL_ROWS };
}

/* 对照板的过站记录：只在导出时按需取（主查询不拉，省 150 秒） */
async function exportStations(panels) {
  const out = [];
  for (const c of chunk(panels, 300)) {
    const rows = await qSmt(
      `SELECT ${ST_COLS} FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK)
       WHERE PanelCode IN (${c.map(esc).join(',')}) ORDER BY PanelCode, CreateTime`, {});
    for (const x of rows) out.push(x);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   全链路导出（v6.5 新增）
   用户原话：「要有导出查询的 SN 的过站记录（包含测试值的）」
   → 一行一个事件，过站、检验结果、测量值放同一张表，靠「段别 + 指标」两列区分，
     这样在 Excel 里按 SN / 穴位 / 工序 / 指标随便筛，不用来回对三张表。
   包含：SMT 过站、SMT-AOI 结果、SMT-SPI 结果、BE 过站、BE 不良、
         ClickHouse 的 AOI 测量值（5 个指标各一行）、SPI 测量值（5 个指标各一行）
   不含：对照 pcs 的逐条测量值 —— 那部分交给「测试值对照」表；这里对照 pcs 只出过站，
         否则 30 个对照 pcs × 每板上千条测量值，文件会大到打不开（用户就是嫌导出太多）。
   口径说明（如实写在 reason 里）：后段 BE 的实测值（VSWR 曲线那种）不在数据库里，
   只在文件共享的 txt 里，当前环境连不上，所以 BE 只能给 pass/fail + 工位 + 工装。
   ──────────────────────────────────────────────────────────────── */
const FULL_HEAD = ['SN', '角色', '是否目标板', 'pcs条码', '板号', '穴位', '段别', '工序', '工站', '机台', '线体',
  '载具/治具', '钢网', '工单', '产品', '结果', '不良现象', '指标', '实测值', '规格下限', '规格上限',
  '是否超规', '邻居中位数', '检验时间'];
const MAX_FULL_ROWS = 300000;

function exportFull(raw, cmp) {
  const rows = [];
  const tgtPanels = new Set((raw.targetPanels || []).map(String));
  const isTgt = p => {
    const x = str(p);
    return tgtPanels.has(x) || tgtPanels.has(baseCode(x));
  };
  /* 面板码 → 你查的 SN；pcs 条码 → 你查的 SN */
  const snOfPanel = new Map(), snOfPcb = new Map();
  /* ★ 全链路只出「你查的那一块 pcs」的明细，不要把整块 panel 的 280 个 pcs 都倒进来。
     实测第一版没圈：6.7 万行里 3.9 万行是同一块 panel 上别的穴位的测量值，
     用户要的是「我查的这颗 SN 的记录」，不是整块拼板。
     CH 的 ModuleID 就是 MES 的 SeqNo，所以目标 pcs 的身份 = 板号 + 穴位。 */
  const tgtPcs = new Set();
  for (const r of (raw.rows || [])) {
    if (r.panel && r.sn) snOfPanel.set(str(r.panel), str(r.sn));
    if (r.panel && r.seq != null) tgtPcs.add(str(r.panel) + '|' + String(Number(r.seq)));
  }
  const tgtSnSet = new Set((raw.rows || []).map(r => str(r.sn)).filter(Boolean));
  const isTgtPcs = (panel, seq) => tgtPcs.has(str(panel) + '|' + String(Number(seq)));
  /* ★ SPI 的 Board_Barcode 存的是【板号基码】（PANEL00001），不是 pcs 条码，
     所以 SPI 行要按「基码 + 穴位」判断是不是目标 pcs，不能拿 SN 集合去比 ——
     拿 SN 比会把 SPI 全部丢掉（实测 SPI 测量值 0 行）。 */
  const tgtBaseSeq = new Set();
  for (const r of (raw.rows || [])) {
    if (r.panel && r.seq != null) tgtBaseSeq.add(baseCode(r.panel) + '|' + String(Number(r.seq)));
  }
  const isTgtSpi = (barcode, modid) => tgtBaseSeq.has(str(barcode) + '|' + String(Number(modid)));
  for (const p of (raw.neighPcs || [])) if (p.pcb && p.of) snOfPcb.set(str(p.pcb), str(p.of));
  /* 对照 pcs 的归属：pcs 条码 → 它对应的目标 SN（用于「参考的是谁」） */
  const ownerOfPanel = p => snOfPanel.get(str(p)) || snOfPanel.get(baseCode(p)) || '';

  /* 邻居中位数：测试值对照里现成的 P50，按 穴位|点位|指标 索引，填到测量值行上 */
  const p50 = new Map();
  for (const c of (cmp || [])) {
    const k = str(c.modid) + '|' + str(c.loc) + '|' + str(c.metric);
    p50.set(k, c.p50);
  }

  const pushStationAgg = (list, seg, roleOK) => {
    for (const r of list) {
      const panel = str(r.panel);
      const tgt = roleOK ? isTgt(panel) : false;
      const sn = ownerOfPanel(panel) || str(r.sn) || '';
      const ng = Number(r.okCount) === 0;
      rows.push([sn, tgt ? '你查的' : '参考', tgt ? '是' : '否', str(r.pcb) || '', panel, '', seg,
        str(r.procn), str(r.station), str(r.machine), str(r.line), str(r.fixture), str(r.steel),
        str(r.morder), str(r.product), ng ? 'NG' : 'PASS', '', '', '', '', '', '', '', tfmt(r.t)]);
    }
  };

  /* ① 前段过站（目标板在 raw.smt.stations，对照板在 raw.neighStations，只有导出时才填） */
  pushStationAgg(raw.smt.stations || [], 'SMT过站', true);
  pushStationAgg(raw.neighStations || [], 'SMT过站', true);

  /* ② 前段 AOI 结果（站别级判定） */
  for (const r of (raw.smt.aoi || [])) {
    const panel = str(r.panel), tgt = isTgt(panel);
    if (!isTgtPcs(panel, r.seq)) continue;      /* 只出目标 pcs 的判定，整块拼板的见「明细」表 */
    rows.push([ownerOfPanel(panel), tgt ? '你查的' : '参考', tgt ? '是' : '否', '', panel, str(r.seq),
      'SMT-AOI' + str(r.side), str(r.procn), str(r.station), str(r.machine), str(r.line), str(r.fixture), '',
      str(r.morder), str(r.product), Number(r.res) === 0 ? 'NG' : 'PASS', '', '', '', '', '', '', '', tfmt(r.t)]);
    if (rows.length >= MAX_FULL_ROWS) break;
  }
  /* ③ 前段 SPI 结果 */
  for (const r of (raw.smt.spi || [])) {
    const panel = str(r.panel), tgt = isTgt(panel);
    if (!isTgtPcs(panel, r.seq)) continue;
    rows.push([ownerOfPanel(panel), tgt ? '你查的' : '参考', tgt ? '是' : '否', '', panel, str(r.seq),
      'SMT-SPI', 'SPI', str(r.station), '', '', str(r.fixture), '', '', str(r.product),
      Number(r.res) === 0 ? 'NG' : 'PASS', '', '', '', '', '', '', '', tfmt(r.t)]);
    if (rows.length >= MAX_FULL_ROWS) break;
  }
  /* ④ 后段过站 */
  for (const r of (raw.be.stations || [])) {
    const sn = str(r.sn);
    rows.push([sn, '你查的', '是', '', str(r.panel) || sn, '', 'BE过站', str(r.procn), str(r.station),
      str(r.machine), str(r.line), str(r.fixture), '', '', '', Number(r.okCount) === 0 ? 'NG' : 'PASS',
      '', '', '', '', '', '', '', tfmt(r.t)]);
    if (rows.length >= MAX_FULL_ROWS) break;
  }
  /* ⑤ 后段不良（BE 没有实测值，只有缺陷码 + 工位） */
  for (const r of (raw.be.defects || [])) {
    rows.push([str(r.sn), '你查的', '是', '', str(r.sn), '', 'BE不良', str(r.procn), '', '', '', '', '', '', '',
      'NG', (str(r.code) + (str(r.memo) ? ' / ' + str(r.memo) : '')).trim(), '', '', '', '', '',
      '', tfmt(r.t)]);
    if (rows.length >= MAX_FULL_ROWS) break;
  }

  /* ⑥ ClickHouse AOI 测量值：一个指标一行，带上下规格限与超规判定
     ★ Rotation 只有 USL 没有 LSL（对称量，LSL 取 -USL）；Lift 只有 BodyLift_USL。
     ★ 只出目标板的测量值；对照板交给「测试值对照」表。 */
  /* ★ 空字符串必须返回 null，不能变成 0。
     ClickHouse 里这几个测量列是 String，没量测时存的是 ''；
     而 Number('') === 0 且 Number.isFinite(0) === true —— 第一版就这么把
     「没测」写成了「实测值 0.00、规格 0~0、不超规」，比空着更误导。
     现在只接受真正的数字文本。 */
  const numOr = v => {
    const t = String(v == null ? '' : v).trim();
    if (!t || !/^[-+]?\d*(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return null;
    const x = Number(t);
    return Number.isFinite(x) ? x : null;
  };
  const METS = [
    { k: 'OffsetX', v: 'OffsetX', lsl: 'OffsetX_LSL', usl: 'OffsetX_USL' },
    { k: 'OffsetY', v: 'OffsetY', lsl: 'OffsetY_LSL', usl: 'OffsetY_USL' },
    { k: 'Rotation', v: 'Rotation', lsl: null, usl: 'Rotation_USL', sym: true },
    { k: 'Lift', v: 'Lift', lsl: null, usl: 'BodyLift_USL' },
    { k: 'Height', v: 'Height', lsl: 'Height_LSL', usl: 'Height_USL' }
  ];
  for (const a of (raw.chAoi || [])) {
    const panel = str(a.panelcode), tgt = isTgt(panel);
    if (!tgt) continue;
    if (!isTgtPcs(panel, a.modid)) continue;   /* 只要目标穴位那 28 条，不要整板 7,840 条 */
    for (const m of METS) {
      const val = numOr(a[m.v]);
      if (val === null) continue;
      let lsl = m.lsl ? numOr(a[m.lsl]) : null;
      const usl = m.usl ? numOr(a[m.usl]) : null;
      if (m.sym && lsl === null && usl !== null) lsl = -usl;
      const over = (lsl !== null && val < lsl) || (usl !== null && val > usl);
      rows.push([ownerOfPanel(panel), '你查的', '是', str(a.pcb) || '', panel, str(a.modid),
        'SMT-AOI测量', '', '', '', '', '', '', '', '', str(a.res) === '0' ? 'NG' : 'PASS',
        str(a.defect), m.k, str(val), lsl === null ? '' : str(lsl), usl === null ? '' : str(usl),
        over ? '是' : '否',
        p50.has(str(a.modid) + '|' + str(a.loc) + '|' + m.k) ? str(p50.get(str(a.modid) + '|' + str(a.loc) + '|' + m.k)) : '',
        tfmt(a.t)]);
      if (rows.length >= MAX_FULL_ROWS) break;
    }
    if (rows.length >= MAX_FULL_ROWS) break;
  }
  /* ⑦ ClickHouse SPI 测量值（Volume/Area/Height 是 %，有 USL/LSL；偏移是 mm，只有容差%，不在这里判超规） */
  const SPIS = [
    { k: 'Volume%', v: 'vol', lsl: 'volLsl', usl: 'volUsl' },
    { k: 'Area%', v: 'area', lsl: 'areaLsl', usl: 'areaUsl' },
    { k: 'Height%', v: 'hgt', lsl: 'hgtLsl', usl: 'hgtUsl' },
    { k: 'OffsetX(mm)', v: 'offx', lsl: null, usl: null },
    { k: 'OffsetY(mm)', v: 'offy', lsl: null, usl: null }
  ];
  for (const srow of (raw.chSpi || [])) {
    const bc = str(srow.barcode);
    if (!isTgtSpi(bc, srow.modid)) continue;   /* SPI 只留目标穴位那几行 */
    for (const m of SPIS) {
      const val = numOr(srow[m.v]);
      if (val === null) continue;
      const lsl = m.lsl ? numOr(srow[m.lsl]) : null;
      const usl = m.usl ? numOr(srow[m.usl]) : null;
      const over = (lsl !== null && val < lsl) || (usl !== null && val > usl);
      rows.push([ownerOfPanel(bc) || bc, '你查的', '是', bc, '', str(srow.modid),
        'SMT-SPI测量', 'SPI', '', '', '', '', '', '', '',
        str(srow.res) === '0' ? 'NG' : 'PASS', '', m.k, str(val),
        lsl === null ? '' : str(lsl), usl === null ? '' : str(usl),
        (lsl === null && usl === null) ? '' : (over ? '是' : '否'), '', tfmt(srow.t)]);
      if (rows.length >= MAX_FULL_ROWS) break;
    }
    if (rows.length >= MAX_FULL_ROWS) break;
  }

  if (!rows.length) {
    return { head: FULL_HEAD, rows, empty: true,
      reason: '这条 SN 在 MES 和 ClickHouse 都没有取到任何一条记录。先确认 SN 拼写（大小写/多一位少一位都会查不到），'
        + '再确认它在公司网络内、且生产时间在数据保留期内。' };
  }
  const trunc = rows.length >= MAX_FULL_ROWS;
  return { head: FULL_HEAD, rows, truncated: trunc,
    reason: '一行一个事件：过站是「板 × 工序 × 工站」，测量值是「一个测量点 × 一个指标」。'
      + '对照 pcs 只出过站记录（它的逐条测量值在「测试值对照」表里）。'
      + '后段测试（VSWR/灵敏度等）的实测曲线不在数据库里，只在文件共享的 txt 里，当前环境取不到，'
      + '所以 BE 只给 pass/fail + 工位 + 工装。'
      + (trunc ? '已到 ' + MAX_FULL_ROWS + ' 行上限，后面的没有写进来，把对照 pcs 调小再导一次。' : '') };
}

/* 汇总：每块板 × 每个工序/工站一行（前段过站 + 前段 AOI + 前段 SPI + 后段过站 + 后段不良） */
function exportSummary(raw) {
  /* ★ v5.1：第一列必须是 SN。
     用户原话：「导出过站汇总缺失SN列，我不知道哪个SN对应的哪个工站」。
     一个前段面板上能切出多个 SN（一块大板拼很多小板），所以一个面板码会对应
     多个 SN —— 那几行都原样复制，SN 列写清是哪一个，用户在 Excel 里筛 SN 就行。 */
  /* v6.0：第二列加「角色」——用户原话「应该备注一下，哪些SN是我让你查询的，哪些SN是作为参考的数据」。
     · 你查的 = 用户贴进来的 SN（目标板）
     · 参考   = 自动取来当对照的邻居板（同产品同机台前后 200 块里的一部分）
     · 环境   = 既不是目标板也不是对照板（基本不出现，兜底） */
  const head = ['SN', '角色', '板号', '段别', '工序', '工站', '机台', '线体', '载具/治具', '钢网', '工单', '产品',
    '穴位', '过站板数', 'OK数', '结果', '不良现象', '工位/点位', '时间'];
  const rows = [];
  /* 目标板集合：raw.rows 里出现的面板码 */
  const tgtPanels = new Set((raw.rows || []).map(r => str(r.panel)).filter(Boolean));

  /* 面板码 → SN 列表；同时建「SN → 面板码」用于反查 */
  const snByPanel = new Map();
  const panelBySn = new Map();
  for (const r of (raw.rows || [])) {
    const p = str(r.panel) || '', sn = str(r.sn) || '';
    if (p && sn) {
      if (!snByPanel.has(p)) snByPanel.set(p, []);
      if (!snByPanel.get(p).includes(sn)) snByPanel.get(p).push(sn);
      panelBySn.set(sn, p);
    } else if (sn) panelBySn.set(sn, '');
  }
  /* 一行可能对应多个 SN：返回数组，调用处循环 push */
  const snsOf = function (panel, sn) {
    if (sn && panelBySn.has(sn)) return [sn];
    const arr = snByPanel.get(str(panel));
    if (arr && arr.length) return arr;
    return [str(sn) || ''];
  };
  const pushRow = function (panel, sn, rest) {
    /* ★ 第一列 SN、第二列板号，然后才是 rest（段别 / 工序 / …）。
       早先 rest 里没带面板码，18 列表头只填了 17 个值，Excel 里会整体左移一列。 */
    const pans = str(panel);
    const role = tgtPanels.has(pans) ? '你查的' : (pans ? '参考' : '环境');
    for (const one of snsOf(panel, sn)) rows.push([one, role, pans].concat(rest));
  };
  /* raw.neighStations 只有导出时才由 exportStations() 填进来；主查询里没拉对照板过站 */
  const allSt = (raw.smt.stations || []).concat(raw.neighStations || []);
  const smtMap = groupBy(allSt, r => str(r.panel) + '|' + str(r.procn) + '|' + str(r.station));
  for (const [, list] of smtMap) {
    const r = list[0];
    const ng = list.filter(x => Number(x.okCount) === 0).length;
    pushRow(str(r.panel), '', ['SMT过站', str(r.procn), str(r.station), str(r.machine), str(r.line),
      str(r.fixture), str(r.steel), str(r.morder), str(r.product), '',
      list.reduce((s, x) => s + (Number(x.pcbCount) || 0), 0), list.reduce((s, x) => s + (Number(x.okCount) || 0), 0),
      ng > 0 ? 'NG' : 'PASS', '', '', tfmt(r.t)]);
  }
  for (const r of (raw.smt.aoi || [])) {
    pushRow(str(r.panel), '', ['SMT-AOI' + str(r.side), str(r.procn), str(r.station), str(r.machine), '',
      str(r.fixture), '', str(r.morder), str(r.product), str(r.seq), '', '',
      Number(r.res) === 0 ? 'NG' : 'PASS', '', '', tfmt(r.t)]);
  }
  for (const r of (raw.smt.spi || [])) {
    pushRow(str(r.panel), '', ['SMT-SPI', 'SPI', str(r.station), '', '', str(r.fixture), '',
      '', str(r.product), str(r.seq), '', '', Number(r.res) === 0 ? 'NG' : 'PASS', '', '', tfmt(r.t)]);
  }
  for (const r of (raw.be.stations || [])) {
    pushRow(str(r.panel) || str(r.sn), str(r.sn), ['BE过站', str(r.procn), str(r.station), str(r.machine), str(r.line),
      str(r.fixture), '', '', '', '', '', '', Number(r.okCount) === 0 ? 'NG' : 'PASS', '', '', tfmt(r.t)]);
  }
  for (const r of (raw.be.defects || [])) {
    rows.push([str(r.sn), '你查的', str(r.sn), 'BE不良', str(r.procn), '', '', '', '', '', '', '', '', '', '', 'NG',
      str(r.code) + (str(r.memo) ? ' / ' + str(r.memo) : ''), str(r.lane), tfmt(r.t)]);
  }
  return { head, rows };
}

/* 对照表导出：目标板指标 vs 邻居板分布 */
function exportCompare(cmp) {
  const head = ['板号', '角色', '穴位', '点位', '指标', '实测值', '邻居P5', '邻居中位数', '邻居P95',
    'IQR', '偏离(IQR倍数)', '是否超出P5~P95', '邻居样本数', 'AOI结果'];
  /* 角色：compare 里每一行都是「你贴进来的那块板」（邻居只作为分布参照，不单独出行），
     所以统一写「你查的」。留这一列是为了将来支持「把参考板也导出来」时不改表结构。 */
  const rows = (cmp || []).map(c => [c.sn, '你查的', c.modid, c.loc, c.metric, c.val, c.p5, c.p50, c.p95,
    c.iqr, c.dev, c.outOf ? '是' : '否', c.n, c.res]);
  if (!rows.length) {
    return { head, rows, empty: true,
      reason: '没有可比的测量值。测试值对照要求「目标板在 ClickHouse 有 AOI 测量值」+「同点位有足够多对照板（默认前后各 200 块）」两个条件；'
        + '任何一个不满足，这张表就是空的。先看上面的「明细」导出是不是也空——如果也空，是 ClickHouse 里没有这块板的测量值。' };
  }
  return { head, rows };
}

/* ════════════════════════════════════════════════════════════════
   ⑨ v6.6：仅 BE 段快通道（traceBe）

   ★ 为什么要有这条路（实测依据，别用直觉改）：
     用户原话「当前的 BE 追溯 SN 太多的情况下很慢」。实测拆开看：
       · beTrace(100 SN)          = 149ms   ← 后段查询本身极快
       · resolve(100 SN)          = 164ms
       · neighborsPcs(5 SN, 30)   = 45,760ms ← 慢的全在这里
     慢的不是 BE，是「取 SMT 对照板」。所以拆成两条路：
       · mode:'both' → 现在的全链路（SMT + BE），SN 多时慢，这是已知边界
       · mode:'be'   → 本函数，完全不碰 SMT 侧，100 SN 目标 3 秒内出结论
     只查后段：过站 + 不良 + 同工序同期基准。没有对照 pcs、没有测量值偏移 ——
     这是取舍：快，但只能回答「后段有没有共性、集中在哪台机/哪个 holder/哪个穴位」，
     回答不了「SMT 侧是不是埋下的」。所以 chNote 里要如实写清。

   ★ 基准口径（为什么是「同工序 + 同生产日」而不是同产品）：
     后段一道工序一天的过站记录动辄几十万块板，按同产品算分母会把量最大的产品
     占满，其他产品的小批量 SN 算出来的倍数全是假的。按「同工序 + 同生产日」
     是最小可比集合，也是 PE 看后段数据的常规口径。
   ════════════════════════════════════════════════════════════════ */

const BE_ONLY_NOTE =
  '仅 BE 段：这条快通道不取 SMT 对照板，所以不受 SN 数量影响（100 个 SN 也在几秒内）。'
  + '代价是它只回答「后段有没有共性、集中在哪台机 / 哪个 holder / 哪个穴位 / 哪条轨道」，'
  + '回答不了「是不是 SMT 段埋下的」。要查前后段联动，请切回「SMT + BE 联合追溯」。';

const TESTVAL_NOTE =
  '后段的实测曲线不在数据库里 —— T_Bllb_TestDefectInformation 只有 pass / fail（IResult），'
  + 'T_Bllb_TestDefectInformation 的 rusult 列存的是 txt 文件路径（\\\\<FILE_SERVER>\\…），'
  + '而那个文件共享当前环境连不上（实测 SMB 认证被拒）。'
  + '所以这里只能给到：走了哪些工序、判定结果、工位 / 工装编号、起止时间，给不了量测值曲线。'
  + '这不是工具漏了，是数据源边界。';

/* 后段工序的中文名（becode 里已有一份，这里只做兜底） */
function beProcLabel(p) {
  try { return BEC.procCn(p) || p || ''; } catch (e) { return p || ''; }
}

/* 后段基准：给定「工序 + 生产日」集合，取每道工序当天的过站记录数。
   ★ v6.6 修的真 bug：第一版把「整窗 + Process IN (…) + COUNT(DISTINCT PanelCode)」
     写成一条 SQL。实测这个写法在这张表上会跑 154 秒（最终因 conn_be 的
     requestTimeout=200000 直接超时），把「仅 BE 段 3 秒出结论」这个立项理由彻底推翻。
     逐条实测拆开看（BE 库，3 天窗）：
       · Process IN (6) + COUNT(*) + GROUP BY Process  = 9,288ms（能跑，但慢）
       · 同上 再加 COUNT(DISTINCT PanelCode)           = 154,927ms  ← 元凶就是 DISTINCT
       · 加 INDEX(IX_..._time_process) 提示             = 90,797ms   ← 提示反而更糟
       · 单工序 + 单日 + COUNT(*)                       = 903~3,903ms
       · 按天 GROUP BY Process（一次拿当天全部工序）   = 2,045~2,560ms  ← 定稿
     定稿写法：每天一条 SQL、只 GROUP BY 不加 DISTINCT，3 天并发 → 实测 2.6 秒拿到全部工序。
     代价是 panels（去重板数）拿不到 —— 但这张表每行 PCBCount 基本就是 1，
     COUNT(*) 与去重板数差不到 0.1%（实测 ICT 10-28：4,942,493 行 vs 4,942,493 面板），
     所以用行数当分母是安全的。
   ★ 时间预算：budgetMs 到点就停，已拿到的照用，没拿到的标 partial ——
     绝不让基准查询拖住整个追溯（用户在投诉的正是这件事）。 */
async function beDenom(procs, days, budgetMs) {
  const out = { window: { from: days[0] || '', to: days[days.length - 1] || '', days: days.length },
    byProc: {}, partial: false, note: '' };
  if (!procs.length || !days.length) return out;
  const t0 = Date.now();
  const budget = Number(budgetMs) || 12000;
  /* 只取最近 3 天做基准：再往前，工序配置与班次都可能变过，可比性反而下降 */
  const useDays = days.slice(-3);
  out.window.basisDays = useDays.slice();
  const want = new Set(procs.map(str));

  await Promise.all(useDays.map(async d => {
    const nxt = new Date(d + 'T00:00:00Z');
    nxt.setUTCDate(nxt.getUTCDate() + 1);
    const dEnd = nxt.toISOString().slice(0, 10);
    try {
      const rows = await qBe(
        `SELECT CAST(t.Process AS varchar(40)) pr,
                COUNT(*) rows_, SUM(CASE WHEN t.OkCount > 0 THEN 1 ELSE 0 END) okRows
         FROM dbo.TRS_Busi_StationTrace t WITH(NOLOCK)
         WHERE t.CreateTime >= '${d} 00:00:00' AND t.CreateTime < '${dEnd} 00:00:00'
         GROUP BY t.Process OPTION (MAXDOP 4)`, {});
      for (const r of (rows || [])) {
        const p = str(r.pr);
        if (want.size && !want.has(p)) continue;   /* 只要这批 SN 实际走过的工序 */
        const cur = out.byProc[p] || { rows: 0, okRows: 0, days: 0 };
        cur.rows += Number(r.rows_) || 0;
        cur.okRows += Number(r.okRows) || 0;
        cur.days += 1;
        out.byProc[p] = cur;
      }
    } catch (e) { out.partial = true; }
  }));
  /* 统一补 panels（=行数）字段，给上层一个稳定口径 */
  for (const p of Object.keys(out.byProc)) out.byProc[p].panels = out.byProc[p].rows;
  out.ms = Date.now() - t0;
  if (Date.now() - t0 > budget) out.partial = true;
  if (out.partial) {
    out.note = '后段基准只取到一部分（有天查询超时或超出预算，避免拖住整个追溯）。'
      + '没有基准的工序不显示占比，这不是「0 块」。';
  }
  return out;
}

/**
 * 仅 BE 段追溯：不碰 SMT 侧，只查后段过站 + 不良 + 同工序同期基准。
 * @param {string[]} sns   SN 列表
 * @param {object}   opt   { maxSns }
 * @returns {{report:object, raw:object}}
 */
async function traceBe(sns, opt) {
  const t0 = Date.now();
  const o = opt || {};
  const errors = [];
  const list = uniq((sns || []).map(s => String(s || '').trim())).slice(0, Number(o.maxSns) || 200);
  if (!list.length) {
    return {
      report: { ms: 0, mode: 'be', sns: [], rows: [], be: { sns: [], rows: [], procs: [], denom: { byProc: {} }, chNote: null, errors: ['没有可查的 SN'] }, errors: ['没有可查的 SN'] },
      raw: { mode: 'be', rows: [], sns: [] }
    };
  }

  /* ① 解析 SN 归属（走前段库的 TRS_Base_PCBCode 映射，164ms / 100 个） */
  let map = {};
  try { map = await resolve(list); }
  catch (e) { errors.push('解析 SN 失败：' + e.message); }
  const rows = list.map(s => map[s] || { sn: s, panel: null, seq: null, product: null, machine: null, t: null, src: null });

  /* ② 后段过站 + 不良（149ms / 100 个） */
  let B = { defects: [], stations: [] };
  const panels = uniq(rows.map(r => r.panel));
  try { B = await beTrace(list, panels); }
  catch (e) { errors.push('后段查询失败：' + e.message); }

  /* ③ 组装每 SN 一行（字段名与全链路 buildRows 的 BE 部分保持一致，
        这样前端 crossSn / hitAll 那套判定可以原样复用） */
  const bySn = new Map();
  for (const r of rows) bySn.set(str(r.sn), { r, st: [], df: [] });
  for (const x of B.stations) {
    const k = str(x.sn);
    if (bySn.has(k)) bySn.get(k).st.push(x);
  }
  for (const x of B.defects) {
    const k = str(x.sn);
    if (bySn.has(k)) bySn.get(k).df.push(x);
  }

  const outRows = rows.map(r => {
    const g = bySn.get(str(r.sn)) || { st: [], df: [] };
    /* BE 编码解析：过站 SerialNo + 不良 ResCode 一起拆（两边同一套编码体系）。
       SerialNo 形如 ZDA1LAB2VSWR0004-01R = ZD + 机台 + 工序 VSWR + 工位 0004 + 穴位 01 + 轨道 R */
    const codes = g.st.map(x => BEC.parse(x.lane)).concat(g.df.map(x => BEC.parse(x.lane))).filter(Boolean);
    const beProcs = uniq(g.st.map(x => str(x.procn)).concat(g.df.map(x => str(x.procn))));
    return {
      sn: r.sn, panel: r.panel, seq: r.seq, product: r.product, machine: r.machine, t: r.t, src: r.src,
      procs: beProcs,
      machines: uniq(g.st.map(x => str(x.machine)).concat(codes.map(c => c.machine))),
      holders: uniq(codes.map(c => c.holder)),
      seats: uniq(codes.map(c => c.seat)),
      lanes: uniq(codes.map(c => c.lane)),
      days: uniq(g.st.map(x => dayOf(x.t)).concat(g.df.map(x => dayOf(x.t)))),
      defects: g.df.map(x => ({
        proc: str(x.procn), issue: str(x.code), memo: str(x.memo),
        point: str(x.lane), retest: x.retest, t: x.t
      })),
      stations: g.st.map(x => ({
        proc: str(x.procn), station: str(x.station), machine: str(x.machine),
        line: str(x.line), lane: str(x.lane), t: x.t, ok: x.okCount
      })),
      /* 下面这组给 crossSn(COMMON_DIMS) 直接用 —— 字段名必须和全链路一致 */
      beMachines: uniq(g.st.map(x => str(x.machine)).concat(codes.map(c => c.machine))),
      beStations: uniq(g.st.map(x => str(x.station))),
      beProcs,
      beLanes: uniq(g.st.map(x => str(x.lane))),
      beHolders: uniq(codes.map(c => c.holder)),
      beSeats: uniq(codes.map(c => c.seat)),
      beRails: uniq(codes.map(c => c.lane)),
      beDays: uniq(g.st.map(x => dayOf(x.t)).concat(g.df.map(x => dayOf(x.t)))),
      beDefects: g.df.length,
      beNgStations: g.st.filter(x => Number(x.okCount) === 0).length,
      ngCount: g.df.length,
      retestCount: g.df.filter(x => Number(x.retest) > 1).length,
      /* 下面这些留给 crossSn 的其他维度用，BE-only 全给空数组，
         这样前端不渲染 SMT 维度也不会因为 undefined 炸 */
      smtMachines: [], smtStations: [], smtFixtures: [], smtLanes: [], smtMorders: [],
      smtSeqs: [], smtNozzles: [], smtFeeders: [], smtMatrs: [], smtLots: [], smtVendors: [],
      smtDays: [], smtSteels: [], aoiNgLocs: [], spiStations: [],
      aoiNgCount: 0, spiNg: 0,
      beIssueRows: g.df.map(x => ({ proc: str(x.procn), issue: str(x.code), memo: str(x.memo), point: str(x.lane), retest: x.retest, t: x.t })),
      beStations5: g.st.map(x => ({ proc: str(x.procn), station: str(x.station), machine: str(x.machine), line: str(x.line), lane: str(x.lane), t: x.t, ok: x.okCount })),
      stations5: []
    };
  });

  /* ④ 涉及工序 + 生产日 → 基准分母（带 9 秒预算，超时不拖住整体） */
  const procs = uniq([].concat(...outRows.map(r => r.beProcs)));
  const days = uniq([].concat(...outRows.map(r => r.beDays))).sort();
  let denom = { byProc: {} };
  try { denom = await beDenom(procs, days, 9000); }
  catch (e) { errors.push('后段基准查询失败：' + e.message); }

  /* ⑤ 工序汇总：每个工序这批 SN 占多少
     ★ 口径别混：`boards` = 这批 SN 里走过该工序的块数（分子）；
       `denomPanels` = 同工序同期总记录数（分母）。两者不能倒过来用，
       否则「这批 2 块」会被显示成「全厂 2 块」。 */
  const procAgg = procs.map(p => {
    const hit = outRows.filter(r => r.beProcs.includes(p));
    const d = denom.byProc[p] || null;
    return {
      proc: p, label: beProcLabel(p),
      ng: hit.reduce((s, r) => s + r.ngCount, 0),
      boards: hit.length,
      denomPanels: d ? d.panels : null,
      denomRows: d ? d.rows : null,
      share: (d && d.panels) ? hit.length / d.panels : null
    };
  }).sort((a, b) => b.boards - a.boards || a.proc.localeCompare(b.proc));

  const report = {
    ms: Date.now() - t0,
    sns: list,
    rows: outRows,
    mode: 'be',
    neighbors: null,
    panels: { target: panels.length, neighbor: 0, total: panels.length },
    targetPanels: panels,
    counts: {
      beDefects: B.defects.length, beStations: B.stations.length,
      /* ★ v6.6：这里原来是「有后段不良的 SN 数」，前端拿去当「后段查到几块」用，
         结果 3 个 SN 里 1 个有记录、0 条不良 → 显示 0，看着像一块都没查到。
         改成「有后段过站记录的 SN 数」，另给 beSnsNg 单独记有不良的块数。 */
      beSnsHit: outRows.filter(r => (r.beStations5 && r.beStations5.length) || r.ngCount > 0).length,
      beSnsNg: outRows.filter(r => r.ngCount > 0).length,
      smtStations: 0, smtAoi: 0, smtSpi: 0, chAoi: 0, chAoiNeighbor: 0, chSpi: 0,
      chProbed: 0, chHit: 0, chMiss: []
    },
    compare: [],
    chNote: TESTVAL_NOTE,
    be: {
      sns: list,
      rows: outRows,
      procs: procAgg,
      denom,
      chNote: TESTVAL_NOTE,
      note: BE_ONLY_NOTE,
      errors
    },
    errors
  };

  const raw = {
    mode: 'be', rows: outRows, sns: list,
    targetPanels: panels, neighPanels: [], neighPcs: [],
    smt: { stations: [], aoi: [], spi: [], repair: [], dims: { board: [], sub: [], mat: [] } },
    be: B, chAoi: [], chNeighborAoi: [], chSpi: [],
    beOnly: { procs: procAgg, denom, note: BE_ONLY_NOTE, chNote: TESTVAL_NOTE }
  };
  return { report, raw };
}

/* 仅 BE 段的 CSV 导出：一行一个事件（过站 / 不良），不掺 SMT 列 */
function exportBe(raw, cross) {
  const head = ['SN', '角色', '产品', '机台', '工序', '事件', '工站/holder', '穴位', '轨道', '线体',
    '结果', '不良代码', '描述', '位置点', '重测次数', '生产日', '时间'];
  const rows = [];
  const bySn = new Map();
  for (const r of (raw && raw.rows) || []) bySn.set(str(r.sn), r);
  const beRows = (raw && raw.rows) || [];
  for (const r of beRows) {
    const st = r.stations || [], df = r.defects || [];
    /* 过站事件 */
    for (const x of st) {
      const c = BEC.parse(x.lane) || {};
      rows.push([r.sn, '你查的', r.product || '', x.machine || r.machine || '', beProcLabel(x.proc),
        '过站', c.holder || x.station || '', c.seat || '', c.lane || '', x.line || '',
        Number(x.ok) > 0 ? 'OK' : 'NG', '', '', '', '', dayOf(x.t), tfmt(x.t)]);
    }
    /* 不良事件 */
    for (const x of df) {
      const c = BEC.parse(x.point) || {};
      rows.push([r.sn, '你查的', r.product || '', r.machine || '', beProcLabel(x.proc),
        '不良', c.holder || '', c.seat || '', c.lane || '', '',
        'NG', x.issue || '', x.memo || '', x.point || '', x.retest == null ? '' : String(x.retest),
        dayOf(x.t), tfmt(x.t)]);
    }
  }
  if (!rows.length) {
    return {
      head, rows, empty: true,
      reason: '这批 SN 在后段没有查到任何过站或不良记录。可能原因：'
        + '① 这些 SN 还没走到后段测试；② SN 填错了（后段 ProBar 就是 SMT 的板条码，可直接粘）；'
        + '③ 这批板是早期生产的，过站记录已超出后段库保留范围。'
    };
  }
  rows.sort((a, b) => (a[0] === b[0] ? String(a[16]).localeCompare(String(b[16])) : String(a[0]).localeCompare(String(b[0]))));
  return { head, rows };
}

module.exports = {
  trace, traceBe, exportBe, resolve, neighbors, neighborsPcs, pcsOfPanels, smtStations, smtDims, chCoverage, smtAoiResult, smtSpi, chAoi, chSpi, beTrace,
  beDenom, compare, buildRows, crossSn, crossSnFor, exportDetail, exportSummary, exportCompare, exportFull, exportStations, toCsv,
  baseCode, COMMON_DIMS, CHUNK, NEIGHBOR_N, MAX_PANELS
};
