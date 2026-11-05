/* ================================================================
   取数层 v2 —— 全部只读 SELECT，全部参数化
   ★ 只允许 SELECT / WITH：conn.q 里有白名单校验，任何写操作直接抛错
   ================================================================ */

/* 样件/试印板：SPI 试印板以 SY 开头、AOI 样件以 Sample 开头，基准和不良池都必须排掉 */
/* 样件板/试印板剔除（口径与 MES 打码规则一致，大小写不敏感）：
   · SPI 试印板条码前缀 SY    例：SY2604050001
   · AOI 样件条码前缀 Sample  例：SampleG5092404249954
   · 另外把 TESTCODE（样机/测试机台，非量产）一起排掉 */
const DU = require('./date_utils');
const SM = require('./sampling');   /* v6.1：300 条抽样下沉到 SQL 侧 */

const SAMPLE_EXCL = alias => ` AND UPPER(${alias}.PanelCode) NOT LIKE 'SY%' AND UPPER(${alias}.PanelCode) NOT LIKE 'SAMPLE%'`;
const TESTCODE_EXCL = alias => ` AND ISNULL(${alias}.MachineType,'') <> 'TESTCODE'`;

/* 段别（AOI / UV-AOI / UV-VI / PSA-AOI / X-Ray / AOI-Flip …）就是主表的 Ext10 */
const STATION_F = (alias, opt, p) => {
  if (!opt.station) return '';
  p.station = opt.station;
  return ` AND ${alias}.Ext10 = @station`;
};

const TBL = {
  rear: { main: 'TS_AOI_Rear', repair: 'TS_AOI_Rear_Repair', spi: 'TS_SPI' },
  front: { main: 'TS_AOI_Front', repair: 'TS_AOI_Front_Repair', spi: 'TS_SPI' }
};

function inList(vals, prefix, col, params) {
  vals = (vals || []).map(v => String(v)).filter(v => v !== '');
  if (!vals.length) return '';
  const names = vals.map((v, i) => { const k = prefix + i; params[k] = v; return '@' + k; });
  return ' AND ' + col + ' IN (' + names.join(',') + ')';
}

/* ── NG 明细池 ── */
function ngQuery(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = ' WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1' + SAMPLE_EXCL('a') + TESTCODE_EXCL('a') + STATION_F('a', opt, p);
  if (opt.machine) { w += ' AND a.MachineType = @machine'; p.machine = opt.machine; }
  if (opt.position) { w += ' AND r.Position = @pos'; p.pos = opt.position; }
  if (opt.product) {
    w += ` AND EXISTS (SELECT 1 FROM dbo.${t.main} a2 WITH(NOLOCK) JOIN dbo.PUB_MOrderProduce pp WITH(NOLOCK) ON pp.MOrderNo = a2.MOrderNo
           WHERE a2.ID = r.AOIID AND pp.Product = @prod)`;
    p.prod = opt.product;
  }
  if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
  w += inList(opt.issues, 'iss', 'r.IssueName', p);
  w += inList(opt.panels, 'pan', 'a.PanelCode', p);
  if (opt.product) {
    w += ` AND EXISTS (SELECT 1 FROM dbo.PUB_MOrderProduce pp WITH(NOLOCK) WHERE pp.MOrderNo = a.MOrderNo AND pp.Product = @prod)`;
    p.prod = opt.product;
  }
  /* ★ v6.1 Task3：TOP 301 + 按主键 MD5 排序
     —— 多取 1 条用来判「有没有被截断」；MD5 与时间无关，同一问题重跑抽到同一批，
        报告才复核得了。旧写法 ORDER BY CreateTime DESC 等于永远只看最后那批不良。 */
  const sql = `
    SELECT ${SM.fetchLimitSql()} r.ID AS repairId, r.PCBCode, r.Position, r.IssueName, r.IssueCode, r.CreateTime,
           a.PanelCode, a.SeqNo, a.MachineType, a.LineID, a.MOrderNo, a.OrderNo, a.Program, a.Lane, a.Ext10
    FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}
    ${SM.orderBySql('r')}`;
  return { sql, params: p, sampling: true };
}

/* NG 条数（预览用，走索引，快）
   ★ 必须去掉 ORDER BY：派生表里带 ORDER BY 在 SQL Server 会直接报错 */
function ngCountQuery(opt) {
  const q = ngQuery(opt);
  /* 派生表里既要摘掉 ORDER BY（SQL Server 不允许），也要摘掉 TOP 301（否则总数被截到 301） */
  let body = q.sql.replace(/\s+ORDER BY[\s\S]*$/i, '');
  body = body.replace(/\bSELECT\s+TOP\s+\d+\s+/i, 'SELECT ');
  return { sql: `SELECT COUNT(*) n FROM (${body}) x`, params: q.params };
}

/* ── 贴装明细（该位号 × 这些板的全部穴位） ── */
function placeQuery(panels, pos) {
  const p = { pos };
  const inl = inList(panels, 'p', 's.PanelCode', p);
  const sql = `
    SELECT s.PanelCode, s.SeqNo, s.NozzleNo, s.FeederNo, s.TableNo, s.PickPos,
           s.MachineTraceID, m.MachineName, m.SetupName, m.BeginTime, m.LineName
    FROM dbo.TRS_Busi_SubCodeTrace s WITH(NOLOCK)
    LEFT JOIN dbo.TRS_Busi_MachineTrace m WITH(NOLOCK) ON m.ID = s.MachineTraceID
    WHERE s.SourcePartPos = @pos${inl}`;
  return { sql, params: p };
}

/* ── 钢网：Printer 台次的料里，Description='钢网' 的那一条 ── */
function stencilQuery(panels) {
  const p = {};
  const inl = inList(panels, 'sp', 'm.PCBCode', p);
  return {
    sql: `SELECT m.PCBCode, m.BeginTime, x.MatrCode AS stencil_pn, x.UniqueCode AS stencil_id
          FROM dbo.TRS_Busi_MachineTrace m WITH(NOLOCK)
          JOIN dbo.TRS_Busi_TrackTrace tt WITH(NOLOCK) ON tt.MachineTraceID = m.ID
          JOIN dbo.PUB_UniqueCode x WITH(NOLOCK) ON x.UniqueCode = tt.UniqueCode
          WHERE m.IsPanel = 1 AND m.MachineName = 'Printer' AND x.Description = N'钢网'${inl}`,
    params: p
  };
}

/* ── 段别字典：两张表的 Ext10（AOI / UV-AOI / UV-VI / PSA-AOI / X-Ray …）
   ★ v4.9：带「这个窗口内该段别的不良数」，前端按数量从高到低排。
   走维修表（r.CreateTime）做基数，比按主表 a.CreateTime 过滤快 2~10 倍：
   实测 rear 7 天 483ms、front 7 天 1177ms；按主表要 7.3s / 9.3s。 ── */
function dictStation(opt) {
  const p = { t0: opt.t0, t1: opt.t1 };
  const one = sd => {
    const t = TBL[sd];
    let w = " WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1 AND a.Ext10 IS NOT NULL AND a.Ext10 <> ''"
      + SAMPLE_EXCL('a') + TESTCODE_EXCL('a');
    if (opt.product) {
      w += ' AND EXISTS (SELECT 1 FROM dbo.PUB_MOrderProduce pp WITH(NOLOCK) WHERE pp.MOrderNo = a.MOrderNo AND pp.Product = @prod)';
      p.prod = opt.product;
    }
    if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
    return `SELECT '${sd}' AS side, a.Ext10 AS code, COUNT(*) AS n
            FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}
            GROUP BY a.Ext10`;
  };
  /* ★ v6.0：并行度从 8 降到 4。实测最重的那条「窗内面板清单」
     DOP8 = 4,169ms、DOP4 = 3,002ms、DOP2 = 3,016ms —— 降到 4 既更快又对服务器更客气
     （48 核里只占 4 核，MES 那边还有人跑 39GB 内存授予的长查询）。 */
  return {
    sql: one('rear') + ' UNION ALL ' + one('front') + ' OPTION (MAXDOP 4)',
    params: p
  };
}

/* ── 工站投入 / 产出（v4.9 导出用）
   INPUT  = SUM(PCBCount)  该工站在这个时段检验过的单板次数（MES 过站口径）
   OUTPUT = SUM(OkCount)   判 OK 的次数
   不良 = INPUT − OUTPUT，良率 = OUTPUT / INPUT
   ★ 只按 (机台) 分组返回，上层再按用户选的机台汇总：单独加 MachineType 过滤反而慢 5 倍
     （实测 Process+7 天 3.3s，加 MachineType=… 变 22s）。
   ★ 带项目过滤时走 IX_TRS_Busi_StationTrace_Product，7 天 7.5s —— 只在导出时算一次。 ── */
function stationIoQuery(opt) {
  const p = { t0: opt.t0, t1: opt.t1, proc: opt.station };
  let w = ' WHERE CreateTime >= @t0 AND CreateTime < @t1 AND Process = @proc';
  /* ★ v6.0：NOLOCK 与 INDEX 提示必须合成同一个 WITH(...) 列表，
     写成 WITH(NOLOCK) WITH(INDEX(..)) 是语法错。 */
  let idx = '';
  if (opt.product) { w += ' AND Product = @prod'; p.prod = opt.product; idx = 'IX_TRS_Busi_StationTrace_Product'; }
  else idx = 'IX_TRS_Busi_StationTrace_time_process';
  const hints = `WITH(NOLOCK, INDEX(${idx}))`;
  return {
    sql: `SELECT MachineType AS mt, SUM(PCBCount) AS inp, SUM(OkCount) AS ok, COUNT(*) AS n
          FROM dbo.TRS_Busi_StationTrace ${hints}${w}
          GROUP BY MachineType OPTION (MAXDOP 4)`,
    params: p
  };
}

/* ── 同工单、同时间窗的面板清单（走 IX_LineOrderNoResult，快） ── */
function windowPanelsQuery(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'].main;
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = ' WHERE CreateTime >= @t0 AND CreateTime < @t1';
  if (opt.lineIds && opt.lineIds.length) w += inList(opt.lineIds.map(String), 'wl', 'LineID', p);
  if (opt.orders && opt.orders.length) w += inList(opt.orders, 'wo', 'OrderNo', p);
  w += " AND UPPER(PanelCode) NOT LIKE 'SY%' AND UPPER(PanelCode) NOT LIKE 'SAMPLE%'";
  /* ★ v6.7 修的真 bug：这条查询会「抽风」——同样的语句，某些工单参数下 158 秒，换个参数 0.6 秒。
     实测（2026-10-19~25 / LineID=1456 / OrderNo=DFT011539）：
       原样跑两次  158,165ms、159,562ms
       加 MAXDOP 4 后 576ms
       加 RECOMPILE  607~636ms
     根因是参数嗅探（同一份语句被复用到不同工单，缓存的计划对这批参数是坏的）。
     这条查询是纯只读、一天最多跑几次，重编译的成本可以忽略，所以直接钉死 RECOMPILE。 */
  return {
    sql: `SELECT DISTINCT TOP 6000 PanelCode FROM dbo.${t} WITH(NOLOCK)${w} OPTION (MAXDOP 4, RECOMPILE)`,
    params: p
  };
}

/* ── 钢网「同期」用量：钢网是会换的耗材，用前 7 天做分母会得出假信号 ──
   （实测：某钢网 10/08 才上线，前 7 天只有 10 块板 → 算出 64×） */
function stencilWindowQuery(opt) {
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = " WHERE m.IsPanel = 1 AND m.MachineName = 'Printer' AND x.Description = N'钢网' AND m.BeginTime >= @t0 AND m.BeginTime < @t1";
  /* 锁同工单：不锁的话分母会变成全厂所有线，倍数全被稀释/放大 */
  if (opt.orders && opt.orders.length) {
    /* MachineTrace 的 MOrderNo 有的带 -S2/-S3 后缀、有的是纯工单号，所以用前缀匹配 */
    const likes = opt.orders.map(v => `m.MOrderNo LIKE '${String(v).replace(/'/g, "''")}%'`);
    w += ' AND (' + likes.join(' OR ') + ')';
  }
  else if (opt.lines && opt.lines.length) w += inList(opt.lines, 'ln', 'm.LineName', p);
  w += " AND UPPER(m.PCBCode) NOT LIKE 'SY%' AND UPPER(m.PCBCode) NOT LIKE 'SAMPLE%'";
  return {
    sql: `SELECT x.MatrCode AS stencil, COUNT(DISTINCT m.PCBCode) AS panels
          FROM dbo.TRS_Busi_MachineTrace m WITH(NOLOCK)
          JOIN dbo.TRS_Busi_TrackTrace tt WITH(NOLOCK) ON tt.MachineTraceID = m.ID
          JOIN dbo.PUB_UniqueCode x WITH(NOLOCK) ON x.UniqueCode = tt.UniqueCode${w}
          GROUP BY x.MatrCode`,
    params: p
  };
}

/* ── 材料（飞达/料号/厂商/批号）── */
function materialQuery(mtids) {
  const p = {};
  const inl = inList(mtids, 'm', 'tt.MachineTraceID', p);
  const sql = `
    SELECT tt.MachineTraceID, tt.TableNo, tt.PickPos, tt.MatrCode, tt.UniqueCode
    FROM dbo.TRS_Busi_TrackTrace tt WITH(NOLOCK) WHERE 1=1${inl}`;
  return { sql, params: p };
}

/* ── 载具 / 钢片 ── */
function boardQuery(panels) {
  const p = {};
  const inl = inList(panels, 'b', 'PanelCode', p);
  return {
    sql: `SELECT PanelCode, FixtureCode, SteelCode, FixtureCode2, WorkOrderNo, Createtime
          FROM dbo.SMT_PanelCode WITH(NOLOCK) WHERE 1=1${inl}`, params: p
  };
}

/* ── SPI 结果（板级） ── */
function spiQuery(panels) {
  const p = {};
  /* 试印板/样件一并不看（按 PanelCode 前缀直接排） */
  const clean = (panels || []).filter(x => !/^(SY|SAMPLE)/i.test(String(x)));
  if (!clean.length) return { sql: `SELECT TOP 0 PanelCode, CAST('' AS varchar(10)) AS spi FROM dbo.TS_SPI WITH(NOLOCK)`, params: p };
  const inl = inList(clean, 's', 'PanelCode', p);
  return {
    sql: `SELECT PanelCode,
                 CASE WHEN SUM(CASE WHEN Result = 1 THEN 1 ELSE 0 END) = 0 THEN 'NG' ELSE 'PASS' END AS spi
          FROM dbo.TS_SPI WITH(NOLOCK) WHERE 1=1${inl} GROUP BY PanelCode`, params: p
  };
}

/* ── 历史：最近 N 天的每日不良条数（判断「慢性 vs 突发」，只查维修表，便宜） ── */
function historyQuery(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = ' WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1' + SAMPLE_EXCL('a') + TESTCODE_EXCL('a') + STATION_F('a', opt, p);
  if (opt.machine) { w += ' AND a.MachineType = @machine'; p.machine = opt.machine; }
  else if (opt.machines && opt.machines.length) {
    /* 没选机台时，用本批不良涉及的那几台机收口，否则 30 天全机台扫一遍会很慢 */
    w += inList(opt.machines, 'mc', 'a.MachineType', p);
  }
  if (opt.position) { w += ' AND r.Position = @pos'; p.pos = opt.position; }
  if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
  w += inList(opt.issues, 'iss', 'r.IssueName', p);
  return {
    sql: `SELECT CONVERT(varchar(10), r.CreateTime, 23) d, COUNT(*) n
          FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}
          GROUP BY CONVERT(varchar(10), r.CreateTime, 23) ORDER BY 1`, params: p
  };
}

/* ── 前 N 天基准：每天不良条数 ── */
function baseNgQuery(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { b0: opt.b0, b1: opt.b1 };
  let w = ' WHERE r.CreateTime >= @b0 AND r.CreateTime < @b1' + SAMPLE_EXCL('a') + TESTCODE_EXCL('a') + STATION_F('a', opt, p);
  if (opt.machine) { w += ' AND a.MachineType = @machine'; p.machine = opt.machine; }
  if (opt.position) { w += ' AND r.Position = @pos'; p.pos = opt.position; }
  if (opt.product) {
    w += ` AND EXISTS (SELECT 1 FROM dbo.${t.main} a2 WITH(NOLOCK) JOIN dbo.PUB_MOrderProduce pp WITH(NOLOCK) ON pp.MOrderNo = a2.MOrderNo
           WHERE a2.ID = r.AOIID AND pp.Product = @prod)`;
    p.prod = opt.product;
  }
  if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
  w += inList(opt.issues, 'iss', 'r.IssueName', p);
  if (opt.product) {
    w += ` AND EXISTS (SELECT 1 FROM dbo.PUB_MOrderProduce pp WITH(NOLOCK) WHERE pp.MOrderNo = a.MOrderNo AND pp.Product = @prod)`;
    p.prod = opt.product;
  }
  return {
    sql: `SELECT CONVERT(varchar(10), r.CreateTime, 23) d, COUNT(*) n
          FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}
          GROUP BY CONVERT(varchar(10), r.CreateTime, 23) ORDER BY 1`, params: p
  };
}

/* ── 前 N 天基准：每天检测行数（走 CreateTime 索引） ── */
function baseProdQuery(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { b0: opt.b0, b1: opt.b1 };
  let w = ' WHERE t.CreateTime >= @b0 AND t.CreateTime < @b1' + SAMPLE_EXCL('t') + TESTCODE_EXCL('t');
  if (opt.machine) { w += ' AND t.MachineType = @machine'; p.machine = opt.machine; }
  if (opt.station) { w += ' AND t.Ext10 = @station'; p.station = opt.station; }
  return {
    sql: `SELECT CONVERT(varchar(10), t.CreateTime, 23) d, COUNT(*) n
          FROM dbo.${t.main} t WITH(NOLOCK)${w}
          GROUP BY CONVERT(varchar(10), t.CreateTime, 23) ORDER BY 1`, params: p
  };
}

/* ── 字典 ── */
/* ── 项目字典（v4.9）：带「这个窗口内该项目的不良数」，前端按数量从高到低排
   实测：7 天 3.0s（含产品名 JOIN）、1 天 434ms；只算数量不带名称 7 天 0.54s。
   产品别名 AVG(name) 不能有 —— 一个产品对应多个工单，名称取 MAX 即可。 ── */
function dictProductNg(opt) {
  const p = { t0: opt.t0, t1: opt.t1 };
  const one = sd => {
    const t = TBL[sd];
    let w = " WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1 AND pp.Product IS NOT NULL AND pp.Product <> ''"
      + SAMPLE_EXCL('a') + TESTCODE_EXCL('a');
    if (opt.station) { w += ' AND a.Ext10 = @st_' + sd; p['st_' + sd] = opt.station; }
    if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
    return `SELECT '${sd}' AS side, pp.Product AS code, COUNT(*) AS n
            FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID
            JOIN dbo.PUB_MOrderProduce pp WITH(NOLOCK) ON pp.MOrderNo = a.MOrderNo${w}
            GROUP BY pp.Product`;
  };
  return {
    sql: `SELECT code, SUM(n) AS n FROM (${one('rear')} UNION ALL ${one('front')}) u
          GROUP BY code ORDER BY SUM(n) DESC OPTION (MAXDOP 4)`,
    params: p
  };
}

/* 产品名（MdcdatProduct）单独查：字典里带名称会让 7 天从 0.54s 涨到 3.0s，
   所以只对返回的前 N 个产品补名称 —— 前端只显示前几十个。 */
function productNamesQuery(codes) {
  const p = {};
  const inl = inList(codes, 'pn', 'ProductCode', p);
  return {
    sql: `SELECT ProductCode AS code, MAX(ProductName) AS name
          FROM dbo.MdcdatProduct WITH(NOLOCK) WHERE 1=1${inl} GROUP BY ProductCode`,
    params: p
  };
}

function dictProduct() {
  return {
    sql: `SELECT p.Product AS code, MAX(m.ProductName) AS name, COUNT(*) AS wo
          FROM dbo.PUB_MOrderProduce p WITH(NOLOCK) LEFT JOIN dbo.MdcdatProduct m WITH(NOLOCK) ON m.ProductCode = p.Product
          WHERE p.Product IS NOT NULL AND p.Product <> ''
            AND (p.BeginTime >= @b OR p.EndTime >= @b OR p.CreateTime >= @b)
          GROUP BY p.Product ORDER BY COUNT(*) DESC`,
    params: { b: DU.addDays(DU.todayCN(), -45) }   /* v6.1：原来是 UTC 的今天，早班 00:00–07:59 会差一天 */
  };
}
function dictMachine(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = " WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1 AND a.MachineType IS NOT NULL AND a.MachineType <> ''" + SAMPLE_EXCL('a') + TESTCODE_EXCL('a') + STATION_F('a', opt, p);
  if (opt.product) {
    w += ' AND EXISTS (SELECT 1 FROM dbo.PUB_MOrderProduce pp WITH(NOLOCK) WHERE pp.MOrderNo = a.MOrderNo AND pp.Product = @prod)';
    p.prod = opt.product;
  }
  if (opt.position) { w += ' AND r.Position = @pos'; p.pos = opt.position; }
  if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
  return {
    sql: `SELECT a.MachineType AS code, COUNT(*) n
          FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}
          GROUP BY a.MachineType ORDER BY COUNT(*) DESC`, params: p
  };
}

/* 点位字典：按 产品 + 机台 收口 */
function dictPosition(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = " WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1 AND r.Position IS NOT NULL AND r.Position <> ''" + SAMPLE_EXCL('a') + TESTCODE_EXCL('a') + STATION_F('a', opt, p);
  if (opt.machine) { w += ' AND a.MachineType = @machine'; p.machine = opt.machine; }
  if (opt.product) {
    w += ' AND EXISTS (SELECT 1 FROM dbo.PUB_MOrderProduce pp WITH(NOLOCK) WHERE pp.MOrderNo = a.MOrderNo AND pp.Product = @prod)';
    p.prod = opt.product;
  }
  if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
  return {
    sql: `SELECT r.Position AS code, COUNT(*) n
          FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}
          GROUP BY r.Position ORDER BY COUNT(*) DESC`, params: p
  };
}

function dictIssue(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { t0: opt.t0, t1: opt.t1 };
  /* 之前这里只查维修表、却引用了 a.PanelCode（样件过滤），SQL 直接报错 → 现象下拉变空 */
  let w = " WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1 AND r.IssueName IS NOT NULL AND r.IssueName <> ''" + SAMPLE_EXCL('a') + TESTCODE_EXCL('a') + STATION_F('a', opt, p);
  if (opt.machine) { w += ' AND a.MachineType = @machine'; p.machine = opt.machine; }
  if (opt.position) { w += ' AND r.Position = @pos'; p.pos = opt.position; }
  if (opt.product) {
    w += ' AND EXISTS (SELECT 1 FROM dbo.PUB_MOrderProduce pp WITH(NOLOCK) WHERE pp.MOrderNo = a.MOrderNo AND pp.Product = @prod)';
    p.prod = opt.product;
  }
  return {
    sql: `SELECT r.IssueName AS code, r.IssueCode AS ic, COUNT(*) n
          FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}
          GROUP BY r.IssueName, r.IssueCode ORDER BY COUNT(*) DESC`, params: p
  };
}

/* ── 同载具跨工单：这些载具在一段时间内跑过的所有板 ── */
function crossPanelQuery(fixtures, from, to) {
  const p = { from, to };
  const inl = inList(fixtures, 'fx', 'FixtureCode', p);
  return {
    sql: `SELECT FixtureCode, PanelCode, WorkOrderNo, Createtime
          FROM dbo.SMT_PanelCode WITH(NOLOCK) WHERE Createtime >= @from AND Createtime < @to${inl}
            AND UPPER(PanelCode) NOT LIKE 'SY%' AND UPPER(PanelCode) NOT LIKE 'SAMPLE%'`,
    params: p
  };
}

/* 一段时间内、同机台同点位出过不良的板（用于和载具面板做交集） */
function ngPanelsQuery(opt) {
  const t = TBL[opt.side === 'front' ? 'front' : 'rear'];
  const p = { t0: opt.t0, t1: opt.t1 };
  let w = ' WHERE r.CreateTime >= @t0 AND r.CreateTime < @t1' + SAMPLE_EXCL('a') + TESTCODE_EXCL('a') + STATION_F('a', opt, p);
  if (opt.machine) { w += ' AND a.MachineType = @machine'; p.machine = opt.machine; }
  if (opt.position) { w += ' AND r.Position = @pos'; p.pos = opt.position; }
  if (opt.product) {
    w += ` AND EXISTS (SELECT 1 FROM dbo.${t.main} a2 WITH(NOLOCK) JOIN dbo.PUB_MOrderProduce pp WITH(NOLOCK) ON pp.MOrderNo = a2.MOrderNo
           WHERE a2.ID = r.AOIID AND pp.Product = @prod)`;
    p.prod = opt.product;
  }
  if (opt.excludePending) w += " AND r.IssueName <> N'待复判'";
  w += inList(opt.issues, 'iss', 'r.IssueName', p);
  return {
    sql: `SELECT DISTINCT a.PanelCode FROM dbo.${t.repair} r WITH(NOLOCK) JOIN dbo.${t.main} a WITH(NOLOCK) ON a.ID = r.AOIID${w}`,
    params: p
  };
}

module.exports = {
  ngQuery, ngCountQuery, placeQuery, materialQuery, stencilQuery, stencilWindowQuery, windowPanelsQuery, boardQuery, spiQuery,
  baseNgQuery, historyQuery, baseProdQuery, dictProduct, dictProductNg, productNamesQuery, dictMachine, dictPosition, dictIssue, dictStation, stationIoQuery,
  crossPanelQuery, ngPanelsQuery, TBL
};
