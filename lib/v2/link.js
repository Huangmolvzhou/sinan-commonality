/* ================================================================
   前后段联动（BE → SMT）：后段成品测试判 NG 的板，回到前段 SMT 找共性
   —— 载具 / 钢网 / 穴位 / 贴片机 / 吸嘴 / 飞达 / 前段 AOI 现象与点位。

   目的：后段只告诉你「这块板不合格」，这里回答「它在前段是哪台机、
   哪个吸嘴、哪套载具做出来的，和同一批 OK 板比有没有共性」。

   口径要点（全部实测过，别再改回去）：
   1. 后段不良表 T_Bllb_TestDefectInformation.ProBar 是【前段 PCB 码】。
      但后段库那份 TRS_Base_PCBCode 的 PanelCode 常就是板号本身
      （后段那种 18 位成品条码），拿它去前段库查必然 0 行（实测 400 条全空）。
      → 只从不良表拿 ProBar，再到【前段库】TRS_Base_PCBCode 按 PCBCode 映射。
   2. 穴位（SeqNo）、产品（Product）、贴片机（MachineType）在映射那一条
      查询里就带回来了，不用再查一遍。
   3. 对照板 = 后段「同工序 + 同时间窗 + OkCount>0」的板 → 映射前段面板码 →
      只保留与 NG 板同产品的（否则基数不可比）。
   4. 前段 AOI 主表（TS_AOI_Rear/Front）按 PanelCode IN 查要 7 秒/批
      （只取一列、GROUP BY 板都是 6.8~7.5 秒），所以【不要】为了机台/站别
      去扫它 —— 机台从映射表拿，工站维度不放进联动（在主分析里看）。
   5. 每个维度用「有数据的板数」当自己的分母；倍数 = NG 占比 ÷ OK 占比；
      显著性用二项上尾 + Bonferroni 校正（沿用 be_engine.binomSF）。
   6. 全部只读 SELECT。
   ================================================================ */
const SM = require('../conn');
const BE = require('../conn_be');
const BEE = require('./be_engine');

const SC = { q: SM.q };            /* 前段库 */

const MAX_NG_BARS = 400;           /* 后段不良板号上限（1 天 AVI 有 8 万多块不良板） */
const MAX_PANELS = 8000;           /* 对照板号上限。★ 后段过站表的 PanelCode 是板号，只有约 30% 能映到前段
                                      面板码（实测 3000 条 → 903 面板），20000 条虽能凑到 400 块面板，
                                      但映射 + 取明细要多花 20 秒，不划算；8000 条是速度与样本量的平衡点。 */
const MAX_OK_BARS = MAX_PANELS;
const CHUNK = 600;                 /* mssql 参数上限 2100，分批 600 安全 */
const DIM_CHUNK = 150;             /* ★ 明细维度查询的分批大小。这几条查询不是「按面板数线性」的：
                                      460 块面板一次查 5.8 秒，拆成 4 段每段 150 块并发查只要 1.1 秒
                                      （实测 100 板 0.56s / 150 板 0.72s / 200 板 1.58s / 300 板 1.92s / 460 板 4.88s，
                                      在 150 附近有个明显的拐点，说明执行计划在这之上换了形状）。 */
const MAX_NG_PANELS = 500;
const MAX_OK_PANELS = 300;
const MIN_NG = 3;                  /* 少于 3 块板不判 */
const LIFT_SIG = 1.5;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function ph(arr, prefix, params) {
  arr.forEach((v, i) => { params[prefix + i] = v; });
  return arr.map((v, i) => '@' + prefix + i).join(',');
}
async function batch(conn, sql, prefix, arr, extra, size) {
  const parts = chunk(arr, size || CHUNK).filter(p => p.length);
  /* 各段并发跑。★ 不能只并发、不分段：单条查询在 460 块面板时执行计划会变差
     （SubCodeTrace 实测 150 板 0.72s vs 460 板 4.88s），分段本身才是主要收益。 */
  const res = await Promise.all(parts.map(part => {
    const p = Object.assign({}, extra || {});
    const L = ph(part, prefix, p);
    return conn.q(sql.replace('__IN__', L), p);
  }));
  let out = [];
  res.forEach(r => { out = out.concat(r || []); });
  return out;
}

/* ① 后段不良板号（ProBar）+ 这块板在后段库里挂的产品。
   ★ 不要用后段库 TRS_Base_PCBCode 取 PanelCode —— 那份表的 PanelCode 常是板号本身。
   ★ 也不要为了拿产品去 LEFT JOIN TRS_Base_PCBCode：实测 1 天 2.3s、7 天 56s 直接崩；
     先只查不良表（7 天 5.7s），再按板号回查后段产品（400 条 105ms），快 10 倍。
   产品要一起带回来：对照板如果只按「时间窗 + 工序」抽，各种机型混在一起，
   同产品的面板就剩不下几块（实测 7 天窗 8000 块对照板里同产品只有 21 块）。 */
async function ngBars(opt) {
  const uniq = a => [...new Set(a.filter(Boolean))];
  const p = { t0: opt.t0, t1: opt.t1, proc: opt.beProc };
  let w = ' WHERE d.CreateTime >= @t0 AND d.CreateTime < @t1 AND d.Process = @proc AND d.IResult = 0';
  w += " AND UPPER(d.ProBar) NOT LIKE 'SY%' AND UPPER(d.ProBar) NOT LIKE 'SAMPLE%'";

  const needJoin = !!(opt.machine || opt.product || opt.order);
  let bars;
  if (needJoin) {
    /* 带筛选条件时才 join（要按后段的机台/产品/工单筛） */
    let jw = w;
    if (opt.machine) { jw += ' AND b.MachineType = @bmch'; p.bmch = opt.machine; }
    if (opt.product) { jw += ' AND b.Product = @bprd'; p.bprd = opt.product; }
    if (opt.order)   { jw += ' AND b.WorkOrderNo = @bwo'; p.bwo = opt.order; }
    const rows = await BE.q(`SELECT DISTINCT TOP ${MAX_NG_BARS} CAST(d.ProBar AS varchar(60)) bar
        FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK)
        LEFT JOIN dbo.TRS_Base_PCBCode b WITH(NOLOCK) ON b.PCBCode = d.ProBar
        ${jw} OPTION (MAXDOP 4)`, p);
    bars = uniq((rows || []).map(r => String(r.bar || '')));
  } else {
    const rows = await BE.q(`SELECT DISTINCT TOP ${MAX_NG_BARS} CAST(d.ProBar AS varchar(60)) bar
        FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK)
        ${w} OPTION (MAXDOP 4)`, p);
    bars = uniq((rows || []).map(r => String(r.bar || '')));
  }
  if (!bars.length) return { bars: [], beProducts: [] };

  /* 回查后段库产品（对照板的产品下推要用后段的产品名，不能拿前段码去筛） */
  const prods = new Set();
  const byBar = new Map();
  for (let i = 0; i < bars.length; i += CHUNK) {
    const part = bars.slice(i, i + CHUNK), q = {}, L = [];
    part.forEach((v, k) => { const key = 'pb' + k; q[key] = v; L.push('@' + key); });
    try {
      const rows = await BE.q(`SELECT CAST(PCBCode AS varchar(60)) bar, CAST(Product AS varchar(80)) prod
          FROM dbo.TRS_Base_PCBCode WITH(NOLOCK) WHERE PCBCode IN (${L.join(',')}) OPTION (MAXDOP 4)`, q);
      (rows || []).forEach(r => {
        const pr = String(r.prod || ''), b = String(r.bar || '');
        if (!pr) return;
        prods.add(pr);
        if (b) byBar.set(b, pr);
      });
    } catch (e) { /* 回查失败不影响主流程，只是对照板会少一层产品过滤 */ }
  }
  return { bars, beProducts: [...prods], beProductByBar: byBar };
}

/* ② 板号 → 前段面板码 + 穴位 + 产品 + 贴片机（一次拿全，实测 400 条 190~330ms） */
async function mapToPanels(bars) {
  return batch(SC, `SELECT CAST(PCBCode AS varchar(60)) bar, CAST(PanelCode AS varchar(60)) panel,
        SeqNo seq, CAST(Product AS varchar(80)) product, CAST(MachineType AS varchar(60)) machine,
        CAST(WorkOrderNo AS varchar(40)) wo
      FROM dbo.TRS_Base_PCBCode WITH(NOLOCK)
      WHERE PCBCode IN (__IN__) AND PanelCode IS NOT NULL OPTION (MAXDOP 4)`, 'mb', bars);
}

/* ③ 对照板：后段同工序同窗过站 OK 的板 → 前段面板码 → 只留同产品
   ★ 必须按产品分别取，不能一条 `Product IN (...)` 了事：
     后段过站表按产品下推虽然便宜（345ms），但 `DISTINCT TOP N` 没有 ORDER BY，
     返回的行会被量最大的那个产品挤占。实测 7 天窗一条查 8000 行，
     映到前段 149 块面板里 138 块是同一个产品 A 的，而 NG 组 94% 是产品 B 的板 ——
     两组根本不是同一批机型，表里的倍数全是假的。改成按产品分别取配额，
     再加一道「按 NG 组各产品的板数比例分配」的权重，让对照组的产品结构和不良组一致。 */
/* ③ 对照板（OK 组）：用「不良板所在工单」取，天然同产品同批次
   ★ 踩过的五条死路（都实测过，不要再回去）：
     ① 后段过站表 `DISTINCT TOP N ... AND Product IN (...)`：没有 ORDER BY，返回行会被量最大的
        那个产品挤满 —— 实测 7 天窗映到 149 块面板里 138 块是同一个产品 A，而 NG 组 94% 是产品 B，
        两组不是同一批机型，算出来的倍数全是假的。
     ② 按产品分别 `TOP cap`：避免挤占，但 `WHERE Product=@p` 在过站表上没有好索引，
        单个产品实测 37~43 秒（7 天窗 cap400 要 14.8 秒），太慢。
     ③ 同工单一把 `DISTINCT TOP 4000`：1.4~29 秒，且仍会被该工单里量最大的产品占满。
     ④ 拿到面板码后再按 PanelCode 回查 TRS_Base_PCBCode 取穴位/贴片机：**口径错了**。
        一块面板里有几十上百块单板，每块单板各有 SeqNo，按面板查会返回上百行，
        对照组的「穴位」分母就从「板数」变成「单板数」，倍数被压到 0.09 这种假值。
     ⑤ `SELECT DISTINCT TOP cap PanelCode, PCBCode`：**数不对**。DISTINCT 是作用在
        (面板码, 板号) 这个二元组上，一块面板有几百个板号，TOP 60 行只覆盖 1~3 块面板。
        实测 17 个工单各取 TOP60 = 1,020 行，去重后只有 19 块面板。
   ★ 最终做法（两步）：
       ① 每个工单 `SELECT DISTINCT TOP cap PanelCode` —— 只取面板码一列，TOP 才是「块数」；
       ② 把这些面板码按 150 一批回查 `GROUP BY PanelCode 取 MIN(PCBCode)` 得到一个板号，
          再交给 mapToPanels 走和不良组完全相同的口径（板号 → 面板 + 穴位 + 贴片机 + 产品）。
     实测 7 个工单 × 60 块 = 2.9 秒拿到 500~650 块对照面板。 */
/* ★ v5.1 粒度对齐：后段不良板映射回前段后，面板码有两种——
   24/25 位的「面板码-日期序号」（一块拼板）和 14 位的纯板号（单板当板用）。
   实测 NG 组 156 块里 121 块是 24/25 位、35 块是 14 位；而按工单抓的对照板
   全是 24/25 位。两组粒度不同 → 「板走过某工站的比例」天然不可比
   （NG 组过站记录 30.8 条/板 vs 对照 18 条/板，能算出 24× 假倍数）。
   所以：NG 组以 20 位以上为主时，对照板和两个过站维度都只用 20 位以上的码。 */
const BIG_LEN = 20;

async function okPanels(opt, ngPanelSet, woByProduct, bigOnly) {
  const okSet = new Set();
  const add = pn => { const x = String(pn || ''); if (x && !ngPanelSet.has(x)) okSet.add(x); };

  /* ★★ v5.1 对照板口径（这是联动里最容易搞错的一步，改之前一定要看这段）
     ------------------------------------------------------------------
     最早按「同产品」抓 → 被量最大的产品占满，两组机型不一致，倍数全假。
     后来按「同工单取前段面板」→ 快（0.4~1.1 秒）但**选择偏差极大**：同工单抓到的是
     整条流程走满的板，实测对它 100% 覆盖的工序，NG 组只有 40~50%，
     于是算出 111× 这种离谱倍数（`Output` 45/121 vs 1/300）。
     最终口径：**同一时间窗、同一道后段工序、判定 OK 的板**
     （后段过站表 `Process=beProc AND OkCount>0`），再映射回前段面板码。
     两组是「同一批进同一道后段测试、一个判 NG 一个判 OK」，过站路径天然可比；
     实测 8000 条 → 547 块前段面板（1~2 秒），倍数回落到 1.2~2.1 这个合理区间。 */
  try {
    const rows = await BE.q(`SELECT DISTINCT TOP ${MAX_PANELS} CAST(PanelCode AS varchar(60)) pan
        FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK)
        WHERE CreateTime >= @t0 AND CreateTime < @t1 AND Process = @proc AND OkCount > 0
        OPTION (MAXDOP 4)`, { t0: opt.t0, t1: opt.t1, proc: opt.beProc });
    const bars = (rows || []).map(r => String(r.pan || '')).filter(Boolean);
    if (bars.length) {
      /* 后段过站表的 PanelCode 是板号，要再映射一次才拿到前段面板码 */
      const mapped = await batch(SC, `SELECT CAST(PCBCode AS varchar(60)) bar, CAST(PanelCode AS varchar(60)) panel
          FROM dbo.TRS_Base_PCBCode WITH(NOLOCK)
          WHERE PCBCode IN (__IN__) AND PanelCode IS NOT NULL OPTION (MAXDOP 4)`, 'ok', bars, null, CHUNK);
      mapped.forEach(r => add(r.panel));
      if (okSet.size >= 30) {
        const keep = [...okSet].filter(p => !bigOnly || String(p).length >= BIG_LEN).slice(0, MAX_OK_PANELS);
        /* ★ 必须走 finishOk：这里拿到的 map 只有 板号+面板码，
           而穴位 / 贴片机 / 产品 三个维要的是 mapped 行里的 seq / machine / product。
           早先直接返回 mapped 的后果是「穴位 / 贴片机」两维对照组恒空、倍数全 null。 */
        return finishOk(keep);
      }
    }
  } catch (e) { /* 掉下来走工单兜底 */ }

  /* 兜底：拿不到同工序 OK 板时，退回「同工单取前段面板」（快，但有上面的选择偏差） */
  const groups = [];
  (woByProduct || new Map()).forEach((set, pr) => { if (pr && set && set.size) groups.push({ pr, wos: [...set] }); });
  if (!groups.length) return { panels: [], mapped: [] };
  const nWo = groups.reduce((a, g) => a + g.wos.length, 0);
  const cap = Math.max(60, Math.min(1200, Math.ceil(MAX_OK_PANELS * 3 / Math.max(1, nWo))));
  const res = await Promise.all(groups.map(g => Promise.all(g.wos.map(async w => {
    try {
      return await SM.q(`SELECT DISTINCT TOP ${cap} CAST(PanelCode AS varchar(60)) panel
          FROM dbo.TRS_Base_PCBCode WITH(NOLOCK)
          WHERE WorkOrderNo = @w AND PanelCode IS NOT NULL${bigOnly ? ` AND LEN(CAST(PanelCode AS varchar(60))) >= ${BIG_LEN}` : ''}
          OPTION (MAXDOP 4)`, { w });
    } catch (e) { return []; }
  }))));
  res.forEach(parts => parts.forEach(rows => (rows || []).forEach(r => add(r.panel))));
  return finishOk([...okSet].slice(0, MAX_OK_PANELS));
}

/* 对照面板码 → 每块面板挑一个代表板号 → 走和不良组同一个 mapToPanels */
async function finishOk(panels) {
  if (!panels || !panels.length) return { panels: [], mapped: [] };
  const barRows = await batch(SC, `SELECT CAST(PanelCode AS varchar(60)) panel, MIN(CAST(PCBCode AS varchar(60))) bar
      FROM dbo.TRS_Base_PCBCode WITH(NOLOCK)
      WHERE PanelCode IN (__IN__) GROUP BY PanelCode OPTION (MAXDOP 4)`, 'ob', panels, null, DIM_CHUNK);
  const bars = barRows.map(r => String(r.bar || '')).filter(Boolean);
  if (!bars.length) return { panels: [], mapped: [] };
  const mapped = await mapToPanels(bars.slice(0, CHUNK * 4));
  const keep = new Set(panels);
  return { panels, mapped: mapped.filter(r => keep.has(String(r.panel || ''))) };
}

/* ---------- 维度定义 ----------
   from:'map' 的维度直接从映射结果拿，不查库；其余按面板批量查。 */
const DIMS = [
  { key: 'seq',      label: '穴位（SeqNo）',         from: 'map' },
  { key: 'machine',  label: '贴片机（MachineType）', from: 'map' },
  { key: 'fixture',  label: '载具（FixtureCode）' },
  { key: 'steel',    label: '钢网（SteelCode）' },
  { key: 'nozzle',   label: '吸嘴（NozzleNo）' },
  { key: 'feeder',   label: '飞达（FeederNo）' },
  /* ★ v5.1：过站集中度。
     用户的原话是「BE SN 反查到 SMT panel 的 ID，然后看这些 Panel ID 过站信息有无集中」。
     前段 AOI 不良现象/点位两维已删除——那是「AOI 判了什么不良」，不是「过站有没有集中」，
     在联动表里只会把真信号挤下去。
     过站表按「这块板有没有走过这道工序/这个工站」取值，倍数 = 不良组走过比例 ÷ 对照组走过比例。 */
  { key: 'proc',     label: '前段工序（Process）',  from: 'station' },
  { key: 'station',  label: '前段工站（Station）',  from: 'station' }
];

/* ④ 面板级取数：能合并的都合并
   载具+钢网 60ms / 吸嘴+飞达 2.8s / 现象+点位 0.5s（per side） */
async function fetchDims(panels) {
  const out = { fixture: [], steel: [], nozzle: [], feeder: [], proc: [], station: [] };
  if (!panels.length) return out;

  /* ★ 三条查询并发 + 每 150 块面板分一段（见 DIM_CHUNK 的注释）。
     串行 + 一次 460 块面板实测 16.2 秒；并发 + 分段后 1.1~1.5 秒。
     过站那条（TRS_Busi_StationTrace）实测：156 块 214ms、456 块不分批要 105 秒 → 必须分批。 */
  const [fsRows, nzRows, stRows] = await Promise.all([
    batch(SC, `SELECT PanelCode pan, CAST(FixtureCode AS varchar(60)) fx, CAST(SteelCode AS varchar(60)) st
        FROM dbo.SMT_PanelCode WITH(NOLOCK)
        WHERE PanelCode IN (__IN__) OPTION (MAXDOP 4)`, 'fs', panels, null, DIM_CHUNK),
    batch(SC, `SELECT DISTINCT PanelCode pan, CAST(NozzleNo AS varchar(40)) nz, CAST(FeederNo AS varchar(60)) fd
        FROM dbo.TRS_Busi_SubCodeTrace WITH(NOLOCK)
        WHERE PanelCode IN (__IN__) OPTION (MAXDOP 4)`, 'nz', panels, null, DIM_CHUNK),
    batch(SC, `SELECT CAST(PanelCode AS varchar(60)) pan, CAST([Process] AS varchar(60)) pn,
          CAST(Station AS varchar(80)) stn
        FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK)
        WHERE PanelCode IN (__IN__)
        GROUP BY PanelCode, [Process], Station OPTION (MAXDOP 4)`, 'st', panels, null, DIM_CHUNK)
  ]);

  fsRows.forEach(r => {
    const p = String(r.pan || '');
    if (r.fx) out.fixture.push({ panel: p, value: String(r.fx) });
    if (r.st) out.steel.push({ panel: p, value: String(r.st) });
  });
  nzRows.forEach(r => {
    const p = String(r.pan || '');
    if (r.nz) out.nozzle.push({ panel: p, value: String(r.nz) });
    if (r.fd) out.feeder.push({ panel: p, value: String(r.fd) });
  });
  stRows.forEach(r => {
    const p = String(r.pan || '');
    if (r.pn) out.proc.push({ panel: p, value: String(r.pn) });
    /* 工站码常与工序同名（机台级过站没有工位号），两者都留，让用户自己看哪层更集中。
       ★ 但纯工序名（UV / TOP / BOT / Reflow…）在工站列里也会出现，和工序维度完全重复，
       只会把两张表刷成一样的数字，所以工站维只留带线体前缀的码（如 D04-3F-05LB-xxx）。 */
    const st = String(r.stn || '');
    if (st && /[A-Z]\d{2}-[0-9A-Z]{1,2}-/.test(st)) out.station.push({ panel: p, value: st });
  });
  return out;
}

const mapRowsToDim = (rows, field) =>
  (rows || []).map(r => ({ panel: String(r.panel || ''), value: r[field] == null ? '' : String(r[field]) }))
    .filter(r => r.panel && r.value);

function group(rows) {
  const m = new Map();
  rows.forEach(r => {
    if (!r.value) return;
    if (!m.has(r.value)) m.set(r.value, new Set());
    m.get(r.value).add(r.panel);
  });
  return m;
}

function statDim(def, ngRows, okRows) {
  const gNg = group(ngRows), gOk = group(okRows);
  const nNg = new Set(ngRows.map(r => r.panel)).size;
  const nOk = new Set(okRows.map(r => r.panel)).size;
  if (!nNg) return { key: def.key, label: def.label, nNg: 0, nOk, items: [], note: '这批板在前段没有这个维度的数据' };
  if (!nOk) {
    const items = [...gNg.entries()].map(([value, set]) => ({
      value, ng: set.size, share: set.size / nNg, ok: null, lift: null, pAdj: null, sig: false
    })).sort((a, b) => b.ng - a.ng);
    return { key: def.key, label: def.label, nNg, nOk: 0, items, note: '没有可比对的对照板，只能看占比' };
  }
  /* 过站两维（覆盖率型）门槛更高：板数 ≥ MIN_NG 且 lift ≥ 1.5 才算，
     但被测项（tested）必须两边都有一定数量，否则二项检验的分母是个位数、
     p 值必然极端（实测过 76.9× 那种就是对照组只有 1 块板造成的）。 */
  const minOk = def.from === 'station' ? 10 : 3;
  const tested = [...gNg.keys()].filter(v => gNg.get(v).size >= MIN_NG && (gOk.get(v) ? gOk.get(v).size : 0) >= minOk);
  const items = [...gNg.entries()].map(([value, set]) => {
    const okN = gOk.get(value) ? gOk.get(value).size : 0;
    const share = set.size / nNg, okShare = okN / nOk;
    return { value, ng: set.size, share, ok: okN, okShare, lift: okShare > 0 ? share / okShare : null };
  });
  items.forEach(it => {
    if (!tested.includes(it.value)) { it.pAdj = null; it.sig = false; return; }
    const p0 = Math.max(1e-9, (it.ok || 0) / nOk);
    const p = BEE.binomSF(it.ng, nNg, Math.min(0.999, p0));
    it.pAdj = Math.min(1, p * Math.max(1, tested.length));
    it.sig = it.pAdj < 0.05 && (it.lift || 0) >= LIFT_SIG && it.ng >= MIN_NG;
    /* 过站覆盖率维度额外要求：不良组至少 10 块板走过（否则 3 块板也能刷出高倍数） */
    if (def.from === 'station' && it.ng < 10) it.sig = false;
  });
  items.sort((a, b) => (b.sig ? 1 : 0) - (a.sig ? 1 : 0) || (b.lift || 0) - (a.lift || 0) || b.ng - a.ng);
  /* ★ v5.1：过站工序/工站两维去重。
     一条线上的板会依次走过该线所有工序/工站，所以「走过 A 站」和「走过 B 站」的板集合
     常常一模一样（实测 D04-3F-05 线上 8 个工站全是 35/121 vs 45/300、1.93 倍），
     表格里连着列 5 行同样的数字，人只会觉得莫名其妙。这里把「板集合完全相同」的取值合并成
     一条，其余用 sharedWith 记下来，界面只说「另有 N 个工站走过同一批板」。 */
  if (def.from === 'station' || def.key === 'nozzle') {
    const seen = new Map();
    const kept = [];
    for (const it of items) {
      const set = gNg.get(it.value) || new Set();
      const sig2 = [...set].sort().join(',');
      const prev = seen.get(sig2);
      if (prev) { prev.sharedWith = (prev.sharedWith || 1) + 1; continue; }
      seen.set(sig2, it);
      kept.push(it);
    }
    for (const it of kept) if (it.sharedWith) it.sharedNote = true;
    return { key: def.key, label: def.label, nNg, nOk, items: kept };
  }
  return { key: def.key, label: def.label, nNg, nOk, items };
}

/* ---------- 主入口 ---------- */
async function run(opt) {
  const t = Date.now();
  const timing = {};
  const T = (k, s) => { timing[k] = Date.now() - s; if (process.env.LK_DEBUG) console.error('[lk]', k, timing[k] + 'ms'); };

  let s = Date.now();
  const ngb = await ngBars(opt);
  const bars = ngb.bars;
  T('ngBars', s);
  if (!bars.length) return { empty: true, msg: '这个条件下没有后段不良板。', timing, ms: Date.now() - t };

  s = Date.now();
  const mappedNg = await mapToPanels(bars);
  T('mapToPanels', s);
  const ngPanels = [...new Set(mappedNg.map(r => String(r.panel)))].filter(Boolean).slice(0, MAX_NG_PANELS);
  if (!ngPanels.length) {
    return { empty: true, timing, bars: bars.length, ms: Date.now() - t,
      msg: '后段不良板在前段库里查不到对应的面板码（这批板可能不是本厂 SMT 贴的，或者是外购件）。' };
  }
  /* ★ v5.1 粒度对齐（先做，再算对照板）：
     后段不良板映射回前段后，面板码有两种——24/25 位的「面板码-日期序号」（一块拼板）
     和 14 位的纯板号（单板当大板用）。实测 NG 组 156 块里 35 块是 14 位、121 块是 24/25 位。
     两组粒度不同时，「这块板走过某工站的比例」天然不可比（大板一张能拆出上百块单板，
     小板只有一块），实测能算出 24 倍假倍数。所以 NG 组以 20 位以上为主时，
     两边都只用 20 位以上的码。 */
  const BIG_LEN = 20;
  const bigNg = ngPanels.filter(p => String(p).length >= BIG_LEN).length;
  const bigOnly = bigNg >= ngPanels.length * 0.6;
  const ngUse = bigOnly ? ngPanels.filter(p => String(p).length >= BIG_LEN) : ngPanels;

  const products = [...new Set(mappedNg.map(r => String(r.product || '')))].filter(Boolean);
  const ngSet0 = new Set(ngUse);

  /* ★ 对照板按「同产品 × 同工单」取（见 okPanels 注释里的三条死路）。
     先把 NG 面板按「前段产品」分到各工单：mappedNg 里每条映射行自带 WorkOrderNo。 */
  const woByProd = new Map();
  const seenPanel = new Set();
  mappedNg.forEach(r => {
    const pn = String(r.panel || ''), pr = String(r.product || ''), w = String(r.wo || '');
    if (!ngSet0.has(pn) || !pr || !w) return;
    if (!woByProd.has(pr)) woByProd.set(pr, new Set());
    woByProd.get(pr).add(w);
    seenPanel.add(pn);
  });
  /* 同一块面板常有多块单板的映射行，工单集合按产品去重即可 */

  s = Date.now();
  const ok = await okPanels(opt, ngSet0, woByProd, bigOnly);
  T('okPanels', s);

  /* ★ NG 组和对照组的明细一次查回来再按面板拆开（以前是 fetchDims 调两次）：
     吸嘴/飞达那条 SubCodeTrace 查询是按面板数走的，460 块面板要 8.4 秒，
     调两次等于白花一倍时间。两条合一条后 dims 从 22 秒降到 ~11 秒。 */
  s = Date.now();
  const allPanels = ngUse.concat(ok.panels);
  const dimAll = await fetchDims(allPanels);
  const ngPanelSet = new Set(ngUse), okPanelSet = new Set(ok.panels);
  const dimNg = {}, dimOk = {};
  Object.keys(dimAll).forEach(k => {
    dimNg[k] = dimAll[k].filter(r => ngPanelSet.has(r.panel));
    dimOk[k] = dimAll[k].filter(r => okPanelSet.has(r.panel));
  });
  T('dims', s);

  /* ★ 对照板的映射行必须裁到 ok.panels 这一批，否则 map 维度的分母会比面板维度的
     分母大好几倍（实测 310 板 vs 59 板），同一张表里两个分母，数字自相矛盾。 */
  const okSet = new Set(ok.panels);
  const okMapped = ok.mapped.filter(r => okSet.has(String(r.panel || '')));
  const ngSet = new Set(ngUse);
  const ngMapped = mappedNg.filter(r => ngSet.has(String(r.panel || '')));

  /* 过站两维（proc/station）在粒度对齐时，NG 组也只留大板，否则两组不可比 */
  const keep = p => !bigOnly || String(p).length >= BIG_LEN;
  const dims = DIMS.map(def => {
    if (def.from === 'map') {
      return statDim(def, mapRowsToDim(ngMapped, def.key), mapRowsToDim(okMapped, def.key));
    }
    const a = (dimNg[def.key] || []).filter(r => keep(r.panel));
    const b = (dimOk[def.key] || []).filter(r => keep(r.panel));
    const d = statDim(def, a, b);
    if (def.from === 'station') {
      d.note = '这个维度按「这块板有没有走过这道工序 / 这个工站」比，' +
        '只看板级覆盖率，不看单板数量；倍数 >1.5 且通过检验才算集中。';
    }
    return d;
  });

  const signals = [];
  dims.forEach(d => (d.items || []).forEach(it => { if (it.sig) signals.push({ dim: d.label, dimKey: d.key, ...it }); }));
  signals.sort((a, b) => (b.lift || 0) - (a.lift || 0));

  return {
    ok: true, beProc: opt.beProc, t0: opt.t0, t1: opt.t1,
    panels: { ng: ngUse.length, ok: ok.panels.length, bars: bars.length, mapped: mappedNg.length, bigOnly: bigOnly },
    granularity: bigOnly ? 'panel' : 'mixed',
    products: products.slice(0, 20),
    dims, signals: signals.slice(0, 12), timing, ms: Date.now() - t
  };
}

module.exports = { run, DIMS, MAX_NG_BARS, MAX_OK_BARS };
