/* ================================================================
   后段（BE / 成品段）取数层 —— <BE_HOST> 的 mes40，全部只读 SELECT
   ================================================================
   口径（2026-10-22 逐条实测确定，改之前先读完这段）：

   ① 分子（不良）＝ dbo.T_Bllb_TestDefectInformation，IResult = 0
        · 一行 = 一块板在某道 Process 被判一次 NG
        · 自带 ecode（不良现象）、ECodeMemo（板上点位）、ResCode（机台+工位）
        · LEFT JOIN dbo.TRS_Base_PCBCode（PCBCode = ProBar）拿
          MachineType / Line / Product / WorkOrderNo
        · ★ 绝对不要拿这张表的 PASS 行当分母：实测 AVI 一天 NG 80,201 行、
          PASS 只有 222 行。用它算不良率会虚高几百倍。

   ② 分母（暴露）＝ dbo.TRS_Busi_StationTrace，同时间窗 + 同 Process
        · 后段每行 PCBCount = 1，OkCount = 0 才是 NG
        · ★ 实测 AVI 一天 1,692,749 行 / 1,692,749 块板 —— 一行一块板，没有
          重测重复，所以「行数」可以直接当「过了多少块板」用。
        · ★ 但 OkCount 不可靠（AVI 一天只有 839 块标了 NG，而不良表有 8 万块），
          所以 NG 数只从①取，②只出分母。

   ③ 工位码对齐（关键，决定倍数算不算得准）
        · 不良表 ResCode = '<机台>AVI0001-04'
        · 过站表 SerialNo = '<机台>AVI0001-04'   ← 同一个值，同一命名空间
        · 实测：近 1 天高频 TOP40 工位码 40/40 全部精确命中 → 分子分母不需要
          任何 join 就能按工位对齐，这是后段能跑快的原因。

   ④ 维度取值一致性（已逐一来回比对，全部逐字一致，可直接比）
        机台：两边都是 `LINE-A` / `N54-HB` / `S8-LAT` 这种写法
        线体：两边都是 `D04-3F-<线别>` / `D01-1F-<线别>`
        产品：两边都是 `PRODUCT-B-001` 这种写法
        工单：两边都是 DFF006815
        NG 侧出现的机台，分母侧全都存在（实测无一个缺失）

   ⑤ 后段没有「穴位」：实测 SeqNo 恒为 1，一块板就是一个单元。
      所以「位置」维度分成两个：工位（SerialNo）＋ 板上点位（ECodeMemo）。

   ⑥ 性能（1 天窗、单 Process、实测）
        不良全维聚合 3.5s ｜ 现象分布 1.0s ｜ 点位分布 0.6s ｜ 时间分布 1.0s
        分母单维：机台 9.2s、线体 11.6s、工站 11.7s、工单 23.0s、产品 25.7s
        分母 5 维并行 ≈ 26s（顺序做要 80s+）
        踩过的坑：
          · GROUPING SETS 做 4 维 = 61s，不能这么写 → 按维拆开并行
          · 复合 GROUP BY 带 SerialNo = 52s，比并行分维还慢
          · 索引 hint(IX_TRS_Busi_StationTrace_LastData) 会走更差执行计划，别加
          · CreateTime 别写 '2026-10-21 24:00:00'（datetime 越界），
            用 < '2026-10-22'；本文件统一用 [t0, t1) 半开区间
   ================================================================ */

/* 后段 8 道 Process（下拉就这几项，全部实测有数据） */
const BE_PROC = [
  { key: 'AVI',         label: '成品目视 AVI' },
  { key: 'AVI-EB',      label: '成品目视 AVI-EB' },
  { key: 'CR',          label: '弹性 Bending（CR）' },
  { key: 'ICT',         label: 'ICT 电测' },
  { key: 'LEAKAGE',     label: '气密 Leakage' },
  { key: 'PRESSURE',    label: '保压 Pressure' },
  { key: 'SENSITIVITY', label: '灵敏度 Sensitivity' },
  { key: 'VSWR',        label: '驻波 VSWR' }
];
const BE_PROC_MAP = {};
for (const p of BE_PROC) BE_PROC_MAP[p.key] = p;
const BE_PROC_LABEL = k => (BE_PROC_MAP[k] || {}).label || k;

/* 段别编码：前端下拉用 'be|AVI' 这种，这里判是不是后段 */
function isBe(opt) { return !!(opt && opt.beProc); }

/* 样件 / 试印板剔除：和前段同一套口径（后段板号也有固定的前缀特征，照规则办） */
const CLEAN = c => ` AND UPPER(${c}.ProBar) NOT LIKE 'SY%' AND UPPER(${c}.ProBar) NOT LIKE 'SAMPLE%'`;

function inList(vals, prefix, col, params) {
  vals = (vals || []).map(v => String(v)).filter(v => v !== '');
  if (!vals.length) return '';
  const names = vals.map((v, i) => { const k = prefix + i; params[k] = v; return '@' + k; });
  return ' AND ' + col + ' IN (' + names.join(',') + ')';
}

/* ── 分子侧公共 FROM/WHERE：不良表 ⋈ 板级信息 ── */
function ngFrom(opt, p, extra) {
  p.t0 = opt.t0; p.t1 = opt.t1; p.proc = opt.beProc;
  let w = ' WHERE d.CreateTime >= @t0 AND d.CreateTime < @t1 AND d.Process = @proc AND d.IResult = 0';
  w += CLEAN('d');
  if (opt.machine) { w += ' AND b.MachineType = @bmch'; p.bmch = opt.machine; }
  if (opt.product) { w += ' AND b.Product = @bprd'; p.bprd = opt.product; }
  if (opt.order)   { w += ' AND b.WorkOrderNo = @bwo'; p.bwo = opt.order; }
  if (opt.line)    { w += ' AND b.Line = @blin'; p.blin = opt.line; }
  if (opt.lane)    { w += ' AND d.ResCode = @blne'; p.blne = opt.lane; }
  w += inList(opt.issues, 'iss', ISSUE_X('d'), p);
  w += inList(opt.points, 'pt', POINT_X('d'), p);
  /* 分母收口用：只看不良里出现过的产品/工单，能显著缩短分母查询 */
  w += inList(opt.scopeProducts, 'sp', 'b.Product', p);
  w += inList(opt.scopeOrders, 'so', 'b.WorkOrderNo', p);
  if (extra) w += ' ' + extra;
  return {
    from: ` FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK)
            LEFT JOIN dbo.TRS_Base_PCBCode b WITH(NOLOCK) ON b.PCBCode = d.ProBar `,
    where: w
  };
}

/* ── 分母侧公共 WHERE ── */
function denomWhere(opt, p) {
  p.t0 = opt.t0; p.t1 = opt.t1; p.proc = opt.beProc;
  let w = ' WHERE CreateTime >= @t0 AND CreateTime < @t1 AND Process = @proc';
  if (opt.machine) { w += ' AND MachineType = @dmch'; p.dmch = opt.machine; }
  if (opt.product) { w += ' AND Product = @dprd'; p.dprd = opt.product; }
  if (opt.order)   { w += ' AND WorkOrderNo = @dwo'; p.dwo = opt.order; }
  if (opt.line)    { w += ' AND LineName = @dlin'; p.dlin = opt.line; }
  /* 工位在分母侧叫 SerialNo，分子侧叫 ResCode —— 同一个值 */
  if (opt.lane)    { w += ' AND SerialNo = @dlne'; p.dlne = opt.lane; }
  w += inList(opt.scopeProducts, 'dp', 'Product', p);
  w += inList(opt.scopeOrders, 'dq', 'WorkOrderNo', p);
  return w;
}

/* ① 不良全维聚合：一次拿齐 机台/线体/产品/工单/工位（分组数很小，边缘化在 Node 做）
      实测 1 天 AVI 3.5s → 这正是「不良率」的分子
      ★ 不含治具/钢网：实测 2026-10-21 一天 AVI 分母 1,692,749 行、分子 80,201 行，
        FixtureCode / SteelCode 两列 **100% 为 NULL**，后段没有这两个维度，别加。 */
function beNgAggQuery(opt) {
  const p = {};
  const f = ngFrom(opt, p);
  return {
    sql: `SELECT CAST(b.MachineType AS varchar(60)) m,
                 CAST(b.Line AS varchar(60)) l,
                 CAST(b.Product AS varchar(80)) p,
                 CAST(b.WorkOrderNo AS varchar(40)) w,
                 CAST(d.ResCode AS varchar(60)) lane,
                 COUNT(DISTINCT d.ProBar) ng
          ${f.from} ${f.where}
          GROUP BY b.MachineType, b.Line, b.Product, b.WorkOrderNo, d.ResCode`,
    params: p
  };
}

/* ② 不良现象分布（Pareto / 现象共性用）—— 一块板同一现象只算一次
   ★ 后段三种工序的「现象」写法完全不同（实测 2026-10-21）：
     · AVI：ecode 就是真现象（Flex脏污 / Clip变形 / SUS压伤）
     · VSWR / ICT / SENSITIVITY：ecode 只是工序名（'VSWR' / 'ICT'）或代码（'BL001'），
       真现象在 ECodeMemo 里（'S11:Ant4' / '@Open*CL_ANT6_GND-ALLGND'）
   → 所以统一成一个 ISSUE_X 表达式：ecode 是工序名/代码/空 就退回 ECodeMemo。
   不这么写的话，VSWR 的「不良现象」只有两个取值，等于啥也看不出来。 */
const PROC_NAMES = `('AVI','AVI-EB','CR','ICT','LEAKAGE','PRESSURE','SENSITIVITY','VSWR')`;
/* 后段工序/端口类 memo 的清洗：'S11:Ant4(0:0)S11:Ant4(0:0)…' 是重测把同一个端口拼了 N 遍，
   取第一个 '(' 之前的部分就能合并成 'S11:Ant4'；ICT 的 '@Open*CL_ANT6_GND-ALLGND' 没有括号，原样保留。 */
const MEMO_CLEAN = c => `LEFT(RTRIM(CASE
    WHEN CHARINDEX('(', ISNULL(${c}.ECodeMemo,'')) > 1
      THEN SUBSTRING(${c}.ECodeMemo, 1, CHARINDEX('(', ${c}.ECodeMemo) - 1)
    ELSE ISNULL(${c}.ECodeMemo,'(未注明)') END), 160)`;

const ISSUE_X = c => `CASE
    WHEN LTRIM(RTRIM(ISNULL(${c}.ecode,''))) = '' THEN LEFT(LTRIM(RTRIM(ISNULL(${c}.ECodeMemo,'(未注明)'))),160)
    WHEN UPPER(LTRIM(RTRIM(${c}.ecode))) IN ${PROC_NAMES} THEN ${MEMO_CLEAN(c)}
    WHEN UPPER(LTRIM(RTRIM(${c}.ecode))) LIKE 'BL%' THEN ${MEMO_CLEAN(c)}
    ELSE CAST(${c}.ecode AS varchar(160)) END`;

/* 点位：AVI 的 ECodeMemo 形如 '(COMP-A变形)' / '(7_0_FPC压伤),(clip变形)' → 取第一个括号里的；
   VSWR/ICT 的 memo 本身就是端口/网络（'S11:Ant4' / '@Open*CL_ANT6_GND-ALLGND'）→ 原样用。
   没有括号就原样。这样两边都能当「点位」维度看。 */
const POINT_X = c => `CASE
    WHEN CHARINDEX('(', ${c}.ECodeMemo) > 0 AND CHARINDEX(')', ${c}.ECodeMemo, CHARINDEX('(', ${c}.ECodeMemo)) > CHARINDEX('(', ${c}.ECodeMemo)
      THEN LEFT(SUBSTRING(${c}.ECodeMemo,
             CHARINDEX('(', ${c}.ECodeMemo) + 1,
             CHARINDEX(')', ${c}.ECodeMemo, CHARINDEX('(', ${c}.ECodeMemo)) - CHARINDEX('(', ${c}.ECodeMemo) - 1), 160)
    ELSE LEFT(LTRIM(RTRIM(ISNULL(${c}.ECodeMemo,''))),160) END`;

function beNgIssueQuery(opt) {
  const p = {};
  const f = ngFrom({ ...opt, issues: null }, p);
  return {
    sql: `SELECT ${ISSUE_X('d')} v, COUNT(DISTINCT d.ProBar) ng
          ${f.from} ${f.where} AND ${ISSUE_X('d')} <> ''
          GROUP BY ${ISSUE_X('d')} ORDER BY COUNT(DISTINCT d.ProBar) DESC`,
    params: p
  };
}

/* ③ 不良点位分布 —— 见上面 POINT_X 的说明 */
function beNgPointQuery(opt) {
  const p = {};
  const f = ngFrom({ ...opt, points: null }, p);
  return {
    sql: `SELECT ${POINT_X('d')} v, COUNT(DISTINCT d.ProBar) ng
          ${f.from} ${f.where} AND ${POINT_X('d')} <> ''
          GROUP BY ${POINT_X('d')} ORDER BY COUNT(DISTINCT d.ProBar) DESC`,
    params: p
  };
}

/* ④ 时间分布（按天×小时）—— 突发 vs 慢性、换线点用 */
function beNgTimeQuery(opt) {
  const p = {};
  const f = ngFrom(opt, p);
  return {
    sql: `SELECT CONVERT(varchar(10), d.CreateTime, 120) day, DATEPART(hour, d.CreateTime) hh,
                 COUNT(DISTINCT d.ProBar) ng
          ${f.from} ${f.where}
          GROUP BY CONVERT(varchar(10), d.CreateTime, 120), DATEPART(hour, d.CreateTime)
          ORDER BY 1, 2`,
    params: p
  };
}

/* ⑤ 重测次数分布（TestNumber ≥2 = 这块板在这道工序被反复判过） */
function beNgRetestQuery(opt) {
  const p = {};
  const f = ngFrom(opt, p);
  return {
    sql: `SELECT CAST(d.TestNumber AS varchar(20)) v, COUNT(DISTINCT d.ProBar) ng
          ${f.from} ${f.where}
          GROUP BY d.TestNumber ORDER BY d.TestNumber`,
    params: p
  };
}

/* ⑥ 分母单维聚合 —— 一次一条，调用方并行跑（实测并行 5 维 ≈ 26s） */
const DENOM_DIM = {
  machine: 'MachineType',
  line: 'LineName',
  product: 'Product',
  order: 'WorkOrderNo',
  lane: 'SerialNo'
};
function beDenomQuery(opt, dim) {
  const col = DENOM_DIM[dim];
  if (!col) return null;
  const p = {};
  const w = denomWhere(opt, p);
  return {
    sql: `SELECT CAST(${col} AS varchar(80)) v, COUNT(*) exp
          FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK) ${w}
          GROUP BY ${col}`,
    params: p
  };
}

/* ⑦ 分母总量 + 首次/末次过站时间（一句话结论与时间跨度用）
      ★ 不要在这条里写 COUNT(DISTINCT Product) / COUNT(DISTINCT WorkOrderNo)：
        实测同一天窗 COUNT(*) 4.3s，加上两个 DISTINCT 变 20.2s（多花 16 秒，
        而且这两个数字界面上根本不用）。产品数/工单数改为从分母分维结果里数。 */
function beDenomTotalQuery(opt) {
  const p = {};
  const w = denomWhere(opt, p);
  return {
    sql: `SELECT COUNT(*) exp, MIN(CreateTime) firstAt, MAX(CreateTime) lastAt
          FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK) ${w}`,
    params: p
  };
}

/* ⑫ 编码维（v6.0 新增）：分子按 ResCode 分组、分母按 SerialNo 分组。
   ResCode / SerialNo 是「机台+工序+工位+穴位+轨道」的结构化编码（见 becode.js），
   以前整根当字符串用，等于没拆，算出来的「工位集中」是混合体。

   实测（VSWR 2 天窗）：
     分子 GROUP BY ResCode  → 125ms，406 组
     分母 GROUP BY SerialNo → 34~42 秒（一次查完，走不了索引）
   所以分母改由 be_collect 按【小时】切片并发：48 片 → 5.5 秒，结果完全一致（492 组 / 2,480,359 行）。 */
function beNgCodeQuery(opt) {
  const p = {};
  const f = ngFrom(opt, p);
  return {
    sql: `SELECT CAST(d.ResCode AS varchar(60)) rc, COUNT(DISTINCT d.ProBar) ng
          ${f.from} ${f.where}
          GROUP BY d.ResCode OPTION (MAXDOP 4)`,
    params: p
  };
}

/* 分母单片：时间界用 @a/@b（不是整个窗口），由 collect 按小时切。
   ★ 这里不能复用 denomWhere —— 它把 CreateTime 绑在 @t0/@t1 上（整窗），
     分片就退化成一模一样的 48 次全窗扫描。 */
function beDenomCodeShardQuery(opt, a, b) {
  const p = { a, b, proc: opt.beProc };
  let w = ' WHERE CreateTime >= @a AND CreateTime < @b AND Process = @proc';
  if (opt.machine) { w += ' AND MachineType = @dmch'; p.dmch = opt.machine; }
  if (opt.product) { w += ' AND Product = @dprd'; p.dprd = opt.product; }
  if (opt.order)   { w += ' AND WorkOrderNo = @dwo'; p.dwo = opt.order; }
  if (opt.line)    { w += ' AND LineName = @dlin'; p.dlin = opt.line; }
  return {
    sql: `SELECT CAST(SerialNo AS varchar(60)) sn, COUNT(*) exp
          FROM dbo.TRS_Busi_StationTrace WITH(NOLOCK) ${w}
          GROUP BY SerialNo OPTION (MAXDOP 4)`,
    params: p
  };
}

/* ⑧ 不良明细（导出 CSV / 报告附录用） */
function beNgDetailQuery(opt, topN) {
  const p = {};
  const f = ngFrom(opt, p);
  return {
    sql: `SELECT TOP ${Math.max(1, Math.min(3000, Number(topN) || 500))}
                 d.ProBar bar, d.Process [proc], CAST(d.ResCode AS varchar(60)) lane,
                 ${ISSUE_X('d')} issue, ${POINT_X('d')} point,
                 d.TestNumber retest, d.CreateTime t,
                 CAST(b.PanelCode AS varchar(60)) panel, CAST(b.MachineType AS varchar(60)) machine,
                 CAST(b.Line AS varchar(60)) line, CAST(b.Product AS varchar(80)) product,
                 CAST(b.WorkOrderNo AS varchar(40)) morder
          ${f.from} ${f.where} ORDER BY d.CreateTime DESC`,
    params: p
  };
}

/* ⑧-b 不良总量（去重板数）—— 各维度 share 的分母 */
function beNgTotalQuery(opt) {
  const p = {};
  const f = ngFrom(opt, p);
  return {
    sql: `SELECT COUNT(DISTINCT d.ProBar) ng, COUNT(*) rows_
          ${f.from} ${f.where}`,
    params: p
  };
}

/* ⑨ 各 Process 在窗口内有多少不良板（下拉里标明，免得选了空段） */
/* 产品 → 工单（后段按产品过滤的唯一快路：直接 JOIN PUB_MOrderProduce 要 27s~200s 超时，
   先取工单列表再 IN，7 天只要 2.0~2.7s，实测） */
function beOrdersQuery(opt) {
  const p = { prd: opt.product };
  return {
    sql: `SELECT WorkOrderNo wo FROM dbo.PUB_MOrderProduce WITH(NOLOCK)
          WHERE Product = @prd
            AND (BeginTime >= DATEADD(day,-40,GETDATE()) OR CreateTime >= DATEADD(day,-40,GETDATE()))`,
    params: p
  };
}

function beProcStatsQuery(opt) {
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = ' WHERE d.CreateTime >= @t0 AND d.CreateTime < @t1 AND d.IResult = 0' + CLEAN('d');
  if (opt.wos && opt.wos.length) w += inList(opt.wos, 'wo', 'd.WoCode', p);
  /* ★ 不加 LEFT JOIN TRS_Base_PCBCode、不用 COUNT(DISTINCT ProBar)：
     实测 1 天 29.4s / 7 天 58.2s；纯 COUNT(*) 只要 0.64s / 4.6s。
     工单列表已经从 beOrdersQuery 拿到，产品口径一样准。 */
  return {
    sql: `SELECT CAST(d.Process AS varchar(40)) [proc], COUNT(*) ng, COUNT(*) rows_
          FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK)${w}
          GROUP BY d.Process ORDER BY COUNT(*) DESC OPTION (MAXDOP 4)`,
    params: p
  };
}

/* ⑩ 字典（机台/线体/产品取自分母，因为分母才是全集；工位/现象/点位取自不良） */
/* 下拉字典统一走「不良表」而不是分母表：
   ① 语义对 —— 下拉是为了挑「有不良的」取值，没不良的取值选了也是空
   ② 速度 —— 实测 AVI 一天：分母表机台 10.6s / 产品 23.4s，不良表只要 1.8s / 2.3s
   ③ 不用扫 170 万行的过站表，刷新字典不会把界面拖住 */
function beDictMachine(opt) {
  const p = {};
  const f = ngFrom({ ...opt, machine: null }, p);
  return {
    sql: `SELECT CAST(b.MachineType AS varchar(60)) code, CAST(b.MachineType AS varchar(60)) name,
                 COUNT(DISTINCT d.ProBar) n
          ${f.from} ${f.where} AND b.MachineType IS NOT NULL
          GROUP BY b.MachineType ORDER BY COUNT(DISTINCT d.ProBar) DESC`,
    params: p
  };
}
function beDictLine(opt) {
  const p = {};
  const f = ngFrom({ ...opt, line: null }, p);
  return {
    sql: `SELECT CAST(b.Line AS varchar(60)) code, CAST(b.Line AS varchar(60)) name,
                 COUNT(DISTINCT d.ProBar) n
          ${f.from} ${f.where} AND b.Line IS NOT NULL
          GROUP BY b.Line ORDER BY COUNT(DISTINCT d.ProBar) DESC`,
    params: p
  };
}
function beDictProduct(opt) {
  const p = {};
  const f = ngFrom({ ...opt, product: null }, p);
  return {
    sql: `SELECT CAST(b.Product AS varchar(80)) code, CAST(b.Product AS varchar(80)) name,
                 COUNT(DISTINCT d.ProBar) n
          ${f.from} ${f.where} AND b.Product IS NOT NULL
          GROUP BY b.Product ORDER BY COUNT(DISTINCT d.ProBar) DESC`,
    params: p
  };
}
function beDictLane(opt) {
  const p = {};
  const f = ngFrom({ ...opt, lane: null }, p);
  return {
    sql: `SELECT CAST(d.ResCode AS varchar(60)) code, CAST(d.ResCode AS varchar(60)) name,
                 COUNT(DISTINCT d.ProBar) n
          ${f.from} ${f.where} AND d.ResCode IS NOT NULL AND LTRIM(RTRIM(d.ResCode)) <> ''
          GROUP BY d.ResCode ORDER BY COUNT(DISTINCT d.ProBar) DESC`,
    params: p
  };
}
function beDictIssue(opt) { return beNgIssueQuery({ ...opt, issues: null }); }
function beDictPoint(opt) { return beNgPointQuery({ ...opt, points: null }); }

/* ⑪ 前后段联动：把后段不良板号 / 面板码取出来，回 SMT 库查共性 */
function beNgPanelsQuery(opt, topN) {
  const p = {};
  const f = ngFrom(opt, p);
  return {
    sql: `SELECT DISTINCT CAST(b.PanelCode AS varchar(60)) panel, CAST(d.ProBar AS varchar(60)) bar
          ${f.from} ${f.where} AND b.PanelCode IS NOT NULL`,
    params: p
  };
}

/* ⑬ 历史日不良（慢性/突发判定：把分析窗日均和历史中位数比）
      ★ 只按天计数，**不 join 板级表**：实测「join Base 30 天」30.8s，
        不 join 只要 4.6s。慢性只看每天坏多少块，不需要机台/产品这些字段。
      ★ 不套 anyNgFilter 的机台/产品条件：那样 30 天就必须 join，又回 30 秒。
        慢性判断的语义本来就是「这道工序整体最近是不是比平时差」，不是「这台机」。
*/
function beNgHistoryQuery(opt) {
  const p = { h0: opt.h0, t1: opt.t1 };
  let w = ' WHERE d.CreateTime >= @h0 AND d.CreateTime < @t1';
  w += ' AND d.Process = @proc AND d.IResult = 0';
  p.proc = opt.beProc;
  return {
    sql: `SELECT CONVERT(varchar(10), d.CreateTime, 120) day, COUNT(*) ng
          FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK) ${w}
          GROUP BY CONVERT(varchar(10), d.CreateTime, 120) ORDER BY 1`,
    params: p
  };
}

/* ⑫ 下钻：某个维度取值对应的不良板清单 */
function beDrillQuery(opt, dim, value, topN) {
  const p = { v: String(value) };
  /* v6.0：holder / seat / lane 都是 ResCode 里拆出来的，SQL 侧没法按列过滤，
     改用 LIKE 片段匹配：holder `____-__R` 里的 4 位数字，seat 是 `-NN`。
     实测 ResCode 只有 406~5000 个不同值，LIKE 走全表但分子侧本来就只有不良行，很快。 */
  const map = { machine: 'b.MachineType', line: 'b.Line', product: 'b.Product', order: 'd.WorkOrderNo' };
  let extra = '';
  if (map[dim]) {
    extra = ` AND ${map[dim]} = @v`;
  } else if (dim === 'holder') {
    extra = " AND d.ResCode LIKE '%' + @v + '-%'";
  } else if (dim === 'seat') {
    extra = " AND d.ResCode LIKE '%-' + @v + '%'";
  } else if (dim === 'lane') {
    extra = " AND d.ResCode LIKE '%-%' + @v";
  } else {
    return null;
  }
  const f = ngFrom(opt, p, extra);
  return {
    sql: `SELECT TOP ${Math.max(1, Math.min(500, Number(topN) || 200))}
                 d.ProBar bar, d.Process [proc], CAST(d.ResCode AS varchar(60)) lane,
                 ${ISSUE_X('d')} issue, ${POINT_X('d')} point,
                 d.TestNumber retest, d.CreateTime t,
                 CAST(b.PanelCode AS varchar(60)) panel, CAST(b.MachineType AS varchar(60)) machine,
                 CAST(b.Product AS varchar(80)) product, CAST(b.WorkOrderNo AS varchar(40)) morder
          ${f.from} ${f.where} ORDER BY d.CreateTime DESC`,
    params: p
  };
}

/* ⑭ 交叉矩阵：某个维度 × 不良现象（看「这台机是不是专出某种不良」） */
function beNgMatrixQuery(opt, dim) {
  const map = { machine: 'b.MachineType', line: 'b.Line', lane: 'd.ResCode', product: 'b.Product' };
  const col = map[dim];
  if (!col) return null;
  const p = {};
  const f = ngFrom(opt, p, " AND " + ISSUE_X('d') + " <> ''");
  return {
    sql: `SELECT CAST(${col} AS varchar(80)) k, ${ISSUE_X('d')} iss,
                 COUNT(DISTINCT d.ProBar) ng
          ${f.from} ${f.where}
          GROUP BY ${col}, ${ISSUE_X('d')}`,
    params: p
  };
}

/* ⑮ 按 SN（ProBar 或 PCBCode）反查后段过站与不良 —— 「按 SN 查」用 */
function beBySnQuery(bars) {
  const p = {};
  const list = inList(bars, 'sn', 'd.ProBar', p);
  if (!list) return null;
  return {
    sql: `SELECT CAST(d.ProBar AS varchar(60)) bar, CAST(d.Process AS varchar(40)) [proc],
                 CAST(d.ResCode AS varchar(60)) lane, ${ISSUE_X('d')} issue,
                 ${POINT_X('d')} point, d.TestNumber retest, d.CreateTime t,
                 d.IResult res, CAST(b.PanelCode AS varchar(60)) panel,
                 CAST(b.MachineType AS varchar(60)) machine, CAST(b.Line AS varchar(60)) line,
                 CAST(b.Product AS varchar(80)) product, CAST(b.WorkOrderNo AS varchar(40)) morder,
                 CAST(b.SeqNo AS varchar(20)) seq
          FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK)
          LEFT JOIN dbo.TRS_Base_PCBCode b WITH(NOLOCK) ON b.PCBCode = d.ProBar
          WHERE 1=1 ${list}
          ORDER BY d.ProBar, d.CreateTime`,
    params: p
  };
}

/* ⑯ 按 SN 查后段过站（无不良也要能看到走的哪台机、哪个工位） */
function beStationBySnQuery(bars, panels) {
  const p = {};
  const list = inList(bars, 'ss', 't.PCBCode', p);
  if (!list) return null;
  /* ★ 关键性能点：TRS_Busi_StationTrace 的索引是 IX_PanelPCBCode(PanelCode, PCBCode)，
     PCBCode 不是最左列。只按 PCBCode 查 = 全表扫（10 亿行，实测 111 秒）。
     先由调用方查出 PanelCode，这里加上 PanelCode IN (…) 就能走索引（实测 28 毫秒）。 */
  const plist = panels && panels.length ? inList(panels, 'sp', 't.PanelCode', p) : '';
  return {
    sql: `SELECT CAST(t.PCBCode AS varchar(60)) bar, CAST(t.Process AS varchar(40)) [proc],
                 CAST(t.SerialNo AS varchar(60)) lane, CAST(t.MachineType AS varchar(60)) machine,
                 CAST(t.LineName AS varchar(60)) line, CAST(t.PanelCode AS varchar(60)) panel,
                 CAST(t.Product AS varchar(80)) product, CAST(t.WorkOrderNo AS varchar(40)) morder,
                 t.CreateTime t, t.OkCount ok, t.ProcessType pt
          FROM dbo.TRS_Busi_StationTrace t WITH(NOLOCK)
          WHERE 1=1 ${list} ${plist}
          ORDER BY t.PCBCode, t.CreateTime`,
    params: p
  };
}

/* ⑬ 首因判读（v6.2）：每块不良板「全链最早被判 NG 的是哪道工序」。
   为什么要按板返回明细而不是直接给汇总数：
   每个维度都要算「这一项的首因率」，而维度是 ResCode 解析出来的，
   只有把 (板号, 本工序 ResCode, 首因工序) 三件一起拿出来，引擎才能
   按维度值聚合。实测 VSWR 2 天窗：757ms / 4,183 行，可以随第一轮一起发。

   口径与坑：
   · prev 子查询只对「本窗不良板」查历史（ProBar IN (SELECT bar FROM me)），
     不扫全表；起点 @h0 = 窗口起点往前 HIST_DAYS 天。
   · ROW_NUMBER 必须排在聚合之后（ORDER BY MIN(CreateTime)），
     直接对明细行排会得到「最早那条明细」而不是「最早那道工序」。
   · proc 是 T-SQL 保留词，别名一律用 proc_ / fp。 */
function beFirstCauseQuery(opt) {
  const p = {};
  const f = ngFrom(opt, p);
  p.h0 = opt.h0;
  return {
    sql: `WITH me AS (
            SELECT DISTINCT d.ProBar bar, CAST(d.ResCode AS varchar(60)) rc
            ${f.from} ${f.where}
          ),
          grp AS (
            SELECT d.ProBar bar, CAST(d.Process AS varchar(40)) proc_, MIN(d.CreateTime) t,
                   MIN(CAST(d.ResCode AS varchar(60))) rc_
            FROM dbo.T_Bllb_TestDefectInformation d WITH(NOLOCK)
            WHERE d.CreateTime >= @h0 AND d.CreateTime < @t1 AND d.IResult = 0
              AND UPPER(d.ProBar) NOT LIKE 'SY%' AND UPPER(d.ProBar) NOT LIKE 'SAMPLE%'
              AND d.ProBar IN (SELECT bar FROM me)
            GROUP BY d.ProBar, CAST(d.Process AS varchar(40))
          ),
          fst AS (
            SELECT bar, proc_, rc_ FROM (
              SELECT bar, proc_, rc_, ROW_NUMBER() OVER (PARTITION BY bar ORDER BY t, proc_) rn FROM grp
            ) x WHERE rn = 1
          )
          SELECT m.bar, m.rc, f.proc_ fp, f.rc_ frc
          FROM me m LEFT JOIN fst f ON f.bar = m.bar
          OPTION (MAXDOP 4)`,
    params: p
  };
}

module.exports = {
  BE_PROC, BE_PROC_MAP, BE_PROC_LABEL, isBe, CLEAN, DENOM_DIM, LANE_NG: 'd.ResCode', LANE_DENOM: 'SerialNo',
  beNgCodeQuery, beDenomCodeShardQuery,
  beNgAggQuery, beNgIssueQuery, beNgPointQuery, beNgTimeQuery, beNgRetestQuery, beNgTotalQuery,
  beDenomQuery, beDenomTotalQuery, beNgDetailQuery, beProcStatsQuery,
  beDictMachine, beDictLine, beDictProduct, beDictLane, beDictIssue, beDictPoint,
  beNgPanelsQuery, beDrillQuery, beFirstCauseQuery, beNgHistoryQuery, beNgMatrixQuery, beBySnQuery, beStationBySnQuery, beOrdersQuery,
  inList, ngFrom, denomWhere
};
