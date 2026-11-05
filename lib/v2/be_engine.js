/* ================================================================
   后段（BE）分析引擎 —— 口径与统计方法全部与前段对齐，只是维度不同
   ================================================================
   与前段的差别（先看这段，改之前别跳）：

   ① 单元不同
        前段：一行 = 一个贴装机会（穴位），一块板约 60 个机会
        后段：一行 = 一块板过了这道工序，一块板 1 个机会
      → 「贴装机会」这个词在后段叫「过站板数」。

   ② 倍数的算法一模一样
        lift = (本取值不良板数 / 本取值过站板数) ÷ (全部不良板数 / 全部过站板数)
      这就是真不良率之比，不是「占比 ÷ 占比」的近似 —— 两者数学上恒等，
      但这里用前者写，因为后段分母是真板数，可以直接说成「不良率 1.2% vs 全场 0.4%」。

   ③ 显著性与前段同一套
        二项上尾检验 P(X ≥ k | n = 本维度不良总数, p = 本取值过站占比)
        Bonferroni 校正 × 本维度参与检验的取值个数，α = 0.05
        再叠加「不良 ≥ 3 条、倍数 ≥ 1.5、过站 ≥ 5 块板」三道门槛
      → 拒绝「跑得少但碰巧不良」的假集中。

   ④ 现象 / 点位两个维度只给占比，不给倍数
        一块板可以同时有多条不良现象，没有分母可比，强行算倍数是骗人。
        所以标 kind = 'share'，不进显著榜，单独用 Pareto 呈现。

   ⑤ 后段没有的维度（别再加）
        载具 / 钢网：实测 FixtureCode、SteelCode 两列在 VSWR 工序 248 万行里
        100% 为 NULL，物理上没有，要看载具必须回 SMT 段（前后段联动那张表）。
        吸嘴 / 飞达 / 穴位(SeqNo 列)：后段过站表也不记，穴位改从 ResCode 里拆。
   ================================================================ */

const BEC = require('./becode');
const BS = require('./be_sql');   /* v6.2：首因判读要用工序名 */
const BU = require('./burst');     /* v6.4：时间段分布 + 有无突然上升 */

const MIN_NG = 3;         // 少于 3 条不良不判
const LIFT_SIG = 1.5;     // 倍数门槛
const THIN_EXP = 3;       // 过站不足 3 块板算薄样本
const ALPHA = 0.05;
const PER_DIM_CAP = 3;    // 每个维度最多进榜 3 项，否则工位维会把榜刷满

/* ---- 统计基元（与前段 engine.js 同源，独立实现避免耦合） ---- */
function lgamma(x) {
  const g = 7;
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = C[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function binomSF(k, n, p) {
  if (k <= 0) return 1;
  if (!(p > 0)) return k > 0 ? 0 : 1;
  if (p >= 1) return 1;
  if (k > n) return 0;
  const lp = Math.log(p), lq = Math.log(1 - p);
  let s = 0;
  for (let i = k; i <= n; i++) {
    s += Math.exp(lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * lp + (n - i) * lq);
  }
  return Math.min(1, Math.max(0, s));
}
const pct = x => (x === null || x === undefined || isNaN(x)) ? '—'
  : ((x * 100 > 0 && x * 100 < 0.01) ? (x * 100).toFixed(3) : (x * 100).toFixed(2)) + '%';
const n1 = x => (x === null || x === undefined || isNaN(x)) ? '—' : (Math.round(x * 10) / 10).toFixed(1);

/* ---- 维度定义 ---- */
/* kind = 'within'：有分母，可以算真不良率与倍数
   kind = 'share' ：无分母，只给占比 */
/* v6.0 后段共性维度（定稿）。
   ★ 删掉的：工单 / 产品 / 工序 / 不良现象 / 板上点位
     —— 这几项「查之前就知道」，算出来必定 100%、零信息量；
        工单更离谱：一个工单几十 K 到 100 多 K 板，占比永远贴着平均，
        倍数恒在 1.0 附近，说了等于没说。
   ★ 新增的：机台 / 工位(holder) / 穴位 / 轨道 / 生产小时
     —— 前四个从 SerialNo·ResCode 这根结构化编码里拆出来（见 becode.js），
        以前整根当字符串用等于没拆。实测 VSWR 30 天全量：
        工位 0011 → 2.16×、0012 → 1.99×；机台 N46UAT1 → 9.43×；
        而穴位（01/02/03 各 33%）和轨道（R/L 各半）是均匀的 ——
        这正是「设备号 + 哪个 holder 集中」要说的话。
   ★ 载具 / 钢网：实测后段过站表 FixtureCode / SteelCode 在 VSWR 248 万行里
     100% 为空，物理上没有；要看载具必须回 SMT 段（前后段联动那张表）。 */
const DIMS = BEC.DIMS;   /* 维度定义统一放在 becode.js，那边连解析函数一起定义 */
/* ★ v5.1 从共性维度里删掉两项（用户 2026-10-26 的原话：「还有AOI的不良，显示这个我觉得没有意义」）：
   ①「不良现象」（ResCode / ECodeMemo）和 ②「板上点位」——
   它们描述的就是「这块板坏成什么样」，是这个不良本身的定义，不是「哪台机/哪个治具做坏的」。
   拿它当共性维度，等于用结果解释结果；而且它们没有分母，只能给占比，
   摆在那里既占位置又容易被当成结论。现在只保留在「不良现象构成 Top15」里当描述用。 */
/* ★ 同一轮还删掉了「工单」维度（原话：「不能以工单不良高为共性，因为每个工单 100 多K 或几十K，
   说了等于没说」）：一个工单几十万块板，它的不良率和全场几乎相同，倍数恒在 1.0 附近。 */
/* ★ v5.1 把「工单」从共性维度里删掉了（用户 2026-10-26 的原话：
   「不能以工单不良高为共性，因为每个工单 100 多K 或几十K，说了等于没说」）。
   一个工单本身就几十万块板，它的不良率和全场不良率几乎是同一个数，
   倍数永远在 1.0 附近——列出来只是占位。真正要看的是「这批不良板在
   前段 SMT 工序/工站/机台/吸嘴/飞达上有没有集中」，那是 link.js 的事。 */

/* 工位维为什么只给分布、不给倍数（这条是实测出来的，不是保守）
   -------------------------------------------------------------
   过站表的工位码（SerialNo）与不良表的工位码（ResCode）**字符串写法完全一致**，
   但**不是同一块板对应同一行**：实测取工位 `<机台>AVI0001-01`，
   过站表记了 108 块板、不良表记了 92 条不良，两边板号交集 **0 条**。
   同一批 LINE-A 的不良板，在过站表里落在 `<机台>AVI0013`（机台级、无工位号）。
   也就是说：一部分产线按「工位」记过站，另一部分按「机台」记，
   两套写法混在一列里 → 拿它算「这个工位不良率」会把两类板子错配，倍数直接失真。
   而机台 / 线体 / 产品 / 工单四个维**逐板精确对齐**（实测 NG 板在两表的机台 100% 同值），
   所以只让这四个算倍数；工位保留分布图和「哪个工位出得多」的排序，不参与显著榜。
*/
function laneDim(ctx) {
  const denom = (ctx.denom && ctx.denom.lane) || {};
  const cnt = new Map();
  for (const r of (ctx.ngAgg || [])) {
    const v = r.lane;
    if (v === null || v === undefined || String(v).trim() === '') continue;
    cnt.set(String(v), (cnt.get(String(v)) || 0) + (Number(r.ng) || 0));
  }
  const totalNg = Number(ctx.ngTotal && ctx.ngTotal.ng) || 0;
  const items = [...cnt.entries()].map(([v, ng]) => {
    const exp = Number(denom[v]) || 0;
    return {
      value: v, ng, exp: exp || null,
      rate: null, baseRate: null, lift: null,
      share: totalNg > 0 ? ng / totalNg : 0, expShare: null,
      thin: false, sig: false, pAdj: null, seqs: [], machines: [],
      yieldPct: null, refExp: exp || null
    };
  }).sort((a, b) => b.ng - a.ng);
  return {
    key: 'lane', label: '工位', kind: 'raw',
    exp: 0, ng: items.reduce((a, i) => a + i.ng, 0), baseRate: null,
    items: items.slice(0, 80), spread: items.length, dimsInExposure: items.length,
    note: '工位只给「谁出得多」，不算倍数——过站表与不良表的工位码写法混用（一部分产线按机台记），' +
      '拿它算不良率会把板子错配。要定位到机台请用「机台」维。',
    unavailable: items.length ? null : '这个窗口里工位码为空'
  };
}

/* 编码维（v6.0）：分子是「不良板的 ResCode 解析值」，分母是「同工序过站行的
   SerialNo 解析值」，两边按同一个解析函数归一（becode.parse），所以机台名
   `ABCDEF1` → `ABC-DEF1` 这类写法差异不会把同一台机拆成两个取值。
   · 分母单位是「过站行数」，不是板数 —— 后段一块板会过同一个工位多次（复测），
     但分子分母用同一单位，比例仍然可比；结论里说「过站 N 次」而不是「N 块板」。
   · minLift：穴位 / 轨道 / 小时这三档实测常常是均匀的（1.0× 附近），
     均匀本身就是有价值的结论（说明不是这两个原因），但不该挤进显著榜，
     所以设 1.3× 的额外门槛，只在真集中时才上报。 */
function codeDim(ctx, def) {
  const totalExp = Object.keys(ctx.codeDenom || {}).reduce((a, k) => a + ctx.codeDenom[k], 0);
  const totalNg = Number(ctx.ngTotal && ctx.ngTotal.ng) || 0;
  if (!totalExp) {
    return { key: def.key, label: def.label, kind: 'code', exp: 0, ng: 0, baseRate: 0,
      items: [], spread: 0, tested: 0,
      unavailable: '分母（同工序过站记录）为空，这个维度算不出集中度' };
  }
  const baseRate = totalNg / totalExp;

  /* 分子 */
  const cnt = new Map();
  let parseFail = 0;
  for (const r of (ctx.codes || [])) {
    const p = BEC.parse(r.rc);
    if (!p) { parseFail += Number(r.ng) || 0; continue; }
    const v = def.get(p);
    if (!v) continue;
    cnt.set(v, (cnt.get(v) || 0) + (Number(r.ng) || 0));
  }
  /* 分母 */
  const den = new Map();
  for (const k of Object.keys(ctx.codeDenom || {})) {
    const p = BEC.parse(k);
    if (!p) continue;
    const v = def.get(p);
    if (!v) continue;
    den.set(v, (den.get(v) || 0) + ctx.codeDenom[k]);
  }

  const items = [];
  const values = new Set([...den.keys(), ...cnt.keys()]);
  for (const v of values) {
    const exp = den.get(v) || 0;
    const ng = cnt.get(v) || 0;
    if (!exp && !ng) continue;
    const rate = exp > 0 ? ng / exp : null;
    const lift = (exp > 0 && baseRate > 0) ? rate / baseRate : null;
    items.push({
      value: v, ng, exp, rate, baseRate, lift,
      broken: ng > exp && ng > 0,
      share: totalNg > 0 ? ng / totalNg : 0,
      expShare: totalExp > 0 ? exp / totalExp : 0,
      thin: exp < THIN_EXP, seqs: [], machines: [],
      yieldPct: exp > 0 && rate !== null ? 1 - rate : null
    });
  }
  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng);
  return {
    key: def.key, label: def.label, kind: 'code', minLift: def.minLift || 0,
    exp: totalExp, ng: totalNg, baseRate, items,
    spread: items.filter(i => i.ng > 0).length,
    tested: 0, unavailable: null,
    parseFail,
    note: def.key === 'hour' ? '生产小时 = 该板在这一站过站记录的小时（不是不良时间）' : ''
  };
}

/* ================================================================
   首因 / 传导判读（v6.2）—— 解决「工序有先后，后站的高倍数是不是被前站带出来的」
   ================================================================
   用户的原话：「因为工序是有先后顺序的，所以可能存在置件问题，导致后续工站都出现
   高基准或共性，这种应该如何判读？」

   判读依据不是「工序的固定顺序表」（那种表是人写的，会过时），而是数据里的事实：
   每块不良板在全链上【最早被判 NG 的是哪道工序】。这块板如果在 VSWR 就 NG 了，
   到 AVI 又 NG，那 AVI 的这条不能当首因算。

   实测（VSWR，2026-10-23~25，4,183 块不良板）：
     · 本站就是全链首个 NG：4,170 块（99.7%）
     · 前站已 NG：198 块（4.7%，含跨站在多个站都 NG 的）
     · 其中「前站与本站不良现象文字相同」只有 1 块 —— 因为后段各工序的判据词表
       根本不通用（VSWR 是 S11:Ant4 这类端口，AVI 是外观缺陷名）。
   → 所以【不能】靠比对现象文字判断「是不是同一个缺陷」。能自动判断的只有首因归属；
     「同缺陷传导 vs 同板多发」必须靠人看现象名。这一步在文案里如实交代。

   为什么要按维度值算首因率：首因率低的维度，它的集中是「前站已坏的板又被判了一次」，
   查这个维度等于白查。首因率高才是真源头。 */
function firstCauseOf(ctx) {
  const rows = ctx.firstCause || [];
  const proc = ctx.opt && ctx.opt.beProc;
  const boards = new Set();
  const firstBoards = new Set();
  const priorBoards = new Set();
  const priorProc = new Map();
  /* 按维度值分桶：value → {boards:Set, first:Set} */
  const buckets = new Map();

  for (const r of rows) {
    const bar = r.bar == null ? '' : String(r.bar);
    if (!bar) continue;
    boards.add(bar);
    const fp = r.fp == null ? '' : String(r.fp).trim();
    /* fp 为空 = 往前 HIST_DAYS 天都查不到更早的 NG → 本站就是首因 */
    const isFirst = (fp === '' || fp === proc);
    if (isFirst) firstBoards.add(bar); else {
      priorBoards.add(bar);
      priorProc.set(fp, (priorProc.get(fp) || 0) + 1);
    }
    const parsed = BEC.parse(r.rc);
    if (!parsed) continue;
    for (const def of DIMS) {
      const v = def.get(parsed);
      if (!v) continue;
      const k = def.key + '\u0001' + v;
      let b = buckets.get(k);
      if (!b) { b = { boards: new Set(), first: new Set() }; buckets.set(k, b); }
      b.boards.add(bar);
      if (isFirst) b.first.add(bar);
    }
  }

  const prior = [...priorProc.entries()]
    .map(([proc_, n]) => ({ proc: proc_, label: BS.BE_PROC_LABEL(proc_), n }))
    .sort((a, b) => b.n - a.n);

  return {
    key: 'firstCause',
    boards: boards.size,
    firstBoards: firstBoards.size,
    priorBoards: priorBoards.size,
    firstRate: boards.size ? firstBoards.size / boards.size : null,
    priorRate: boards.size ? priorBoards.size / boards.size : null,
    prior,
    byValue: buckets
  };
}

/* 给单个维度取值贴首因率：这些不良板里有多大比例是「它在这里第一次被判 NG」 */
function attachFirstCause(dim, fc) {
  if (!fc || !fc.byValue) return;
  for (const it of dim.items) {
    const b = fc.byValue.get(dim.key + '\u0001' + it.value);
    if (!b) continue;
    const n = b.boards.size;
    const f = b.first.size;
    it.fcBoards = n;
    it.fcFirst = f;
    it.firstRate = n > 0 ? f / n : null;
    /* 前站已 NG 的板数（不是比例，是块数，方便直接说人话） */
    it.fcPrior = n - f;
  }
}

/* 把首因率翻译成一个判定 + 一句话。用户要的是「能直接看的分类」，不是又一个小数 */
function verdictOf(it, fcAll) {
  if (it.firstRate === null || it.firstRate === undefined) return null;
  if (it.fcBoards != null && it.fcBoards < 5) return null;   /* 样本太少不给判定 */
  if (it.firstRate >= 0.8) {
    return { kind: 'first', label: '首因',
      note: `这些板有 ${pct(it.firstRate)} 是在这里第一次被判 NG，源头大概率在本工序` };
  }
  if (it.firstRate <= 0.5) {
    const where = (fcAll && fcAll.prior || []).slice(0, 2)
      .map(x => `${x.label} ${x.n} 块`).join('、');
    return { kind: 'carry', label: '疑似传导',
      note: `这些板只有 ${pct(it.firstRate)} 是在这里第一次被判 NG，` +
        `${pct(1 - it.firstRate)}（${it.fcPrior} 块）在前站就已经 NG 了${where ? `（${where}）` : ''}——` +
        `本工序的集中可能只是前站缺陷的再现，先查前站` };
  }
  return { kind: 'mixed', label: '首因/传导各半',
    note: `这些板有 ${pct(it.firstRate)} 在这里第一次被判 NG，其余前站已 NG——两条都要查，别只查这一站` };
}

/* 生产小时（v6.0）：分子 = 不良板在这一站过站的小时分布（ctx.times，按天+小时），
   分母 = 同工序过站行在这一小时的数量（ctx.hourDenom，切片时顺带数出来）。
   用途只有一个：告诉你「不良是不是集中在某个时段（换班/换线/停机重启）」，
   所以门槛比设备维更宽（1.3× 才上报），且不参与「头条」。 */
function hourDim(ctx) {
  const den = ctx.hourDenom || {};
  const totalExp = Object.keys(den).reduce((a, k) => a + (Number(den[k]) || 0), 0);
  const totalNg = Number(ctx.ngTotal && ctx.ngTotal.ng) || 0;
  if (!totalExp) {
    return { key: 'hour', label: '生产小时', kind: 'code', exp: 0, ng: 0, baseRate: 0,
      items: [], spread: 0, unavailable: '分母为空，算不出时段分布' };
  }
  const cnt = new Map();
  for (const r of (ctx.times || [])) {
    const k = 'H' + Number(r.hh);
    cnt.set(k, (cnt.get(k) || 0) + (Number(r.ng) || 0));
  }
  const baseRate = totalNg / totalExp;
  const items = [];
  const values = new Set([...Object.keys(den), ...cnt.keys()]);
  for (const v of values) {
    const exp = Number(den[v]) || 0;
    const ng = cnt.get(v) || 0;
    if (!exp && !ng) continue;
    const rate = exp > 0 ? ng / exp : null;
    items.push({
      value: v, ng, exp, rate, baseRate,
      lift: (exp > 0 && baseRate > 0) ? rate / baseRate : null,
      broken: ng > exp && ng > 0,
      share: totalNg > 0 ? ng / totalNg : 0,
      expShare: totalExp > 0 ? exp / totalExp : 0,
      thin: exp < THIN_EXP, seqs: [], machines: []
    });
  }
  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng);
  return { key: 'hour', label: '生产小时', kind: 'code', minLift: 1.3,
    exp: totalExp, ng: totalNg, baseRate, items,
    spread: items.filter(i => i.ng > 0).length, unavailable: null,
    note: '生产小时 = 这块板在这一站过站的时间，不是不良录入时间' };
}

/* 有分母的维度：分子来自 ngAgg（已按该维度分组），分母来自 denom[dim] */
function ratioDim(ctx, def) {
  const ngRows = ctx.ngAgg || [];
  const denom = (ctx.denom && ctx.denom[def.denomKey]) || {};
  const totalExp = Number(ctx.denomTotal && ctx.denomTotal.exp) || 0;
  const totalNg = Number(ctx.ngTotal && ctx.ngTotal.ng) || 0;
  if (!totalExp) {
    return { key: def.key, label: def.label, kind: def.kind, exp: 0, ng: 0, baseRate: 0,
      items: [], spread: 0, tested: 0, unavailable: '分母（过站记录）为空，这个维度算不出不良率' };
  }
  const baseRate = totalNg / totalExp;
  const cnt = new Map();
  const sk = def.sqlKey || def.key;
  for (const r of ngRows) {
    const v = r[sk];
    if (v === null || v === undefined || String(v).trim() === '') continue;
    const k = String(v);
    if (!cnt.has(k)) cnt.set(k, 0);
    cnt.set(k, cnt.get(k) + (Number(r.ng) || 0));
  }
  const items = [];
  let expSum = 0;
  const values = new Set([...Object.keys(denom), ...cnt.keys()]);
  for (const v of values) {
    const exp = Number(denom[v]) || 0;
    const ng = cnt.get(v) || 0;
    expSum += exp;
    if (exp === 0 && ng === 0) continue;
    const rate = exp > 0 ? ng / exp : null;
    const lift = (exp > 0 && baseRate > 0) ? rate / baseRate : null;
    /* ★ 不良板数 > 过站板数 = 物理上不可能 → 这个取值的分母没取全。
       实测根因：部分产线的 AVI 过站记录会滞后 1 天才回填到 TRS_Busi_StationTrace
       （LINE-E 2026-10-20 只有 34 行过站，而当天出了 199 块不良板，
        那 199 块的过站行是 10-21 才写进去的）。
       这种项必须剔除，否则会算出「不良率 585%、109 倍」这种荒唐结论。 */
    const broken = ng > exp && ng > 0;
    items.push({
      value: v, ng, exp, rate, baseRate, lift, broken,
      share: totalNg > 0 ? ng / totalNg : 0,
      expShare: expSum && exp > 0 && totalExp > 0 ? exp / totalExp : 0,
      thin: exp < THIN_EXP, seqs: [], machines: [],
      yieldPct: exp > 0 ? 1 - rate : null
    });
  }
  /* expShare 必须用全场总过站算，用循环内累计会漏掉没出现在 values 里的取值 */
  for (const it of items) it.expShare = totalExp > 0 ? it.exp / totalExp : 0;

  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng);
  return {
    key: def.key, label: def.label, kind: def.kind,
    exp: totalExp, ng: totalNg, baseRate, items,
    spread: items.filter(i => i.ng > 0).length,
    dimsInExposure: items.length,
    unavailable: null
  };
}

/* 只给占比的维度（现象 / 点位） */
function shareDim(ctx, def) {
  const rows = (def.key === 'issue' ? ctx.issues : ctx.points) || [];
  const total = rows.reduce((a, r) => a + (Number(r.ng) || 0), 0);
  const items = rows.map(r => ({
    value: String(r.v), ng: Number(r.ng) || 0,
    exp: null, rate: null, baseRate: null, lift: null,
    share: total > 0 ? (Number(r.ng) || 0) / total : 0,
    expShare: null, thin: false, sig: false, pAdj: null,
    seqs: [], machines: []
  }));
  return {
    key: def.key, label: def.label, kind: def.kind,
    exp: 0, ng: total, baseRate: null, items: items.slice(0, 60),
    spread: items.length, dimsInExposure: items.length,
    unavailable: total ? null : '这个窗口里没有记录到' + def.label
  };
}

function attachSignificance(d) {
  if (d.kind !== 'code' || d.unavailable) return d;
  const tested = d.items.filter(i => i.exp >= THIN_EXP && i.expShare > 0 && !i.broken).length;
  for (const it of d.items) {
    if (it.broken) { it.p = null; it.pAdj = null; it.sig = false; continue; }
    if (d.ng > 0 && it.expShare > 0 && it.ng > 0) {
      it.p = binomSF(it.ng, d.ng, it.expShare);
      it.pAdj = Math.min(1, it.p * Math.max(1, tested));
      it.sig = it.pAdj < ALPHA && (it.lift || 0) >= LIFT_SIG && it.ng >= MIN_NG;
    } else { it.p = null; it.pAdj = null; it.sig = false; }
  }
  d.tested = tested;
  return d;
}

/* 工位 × 现象 交叉：看「这个工位是不是专出某种不良」 */
function laneIssueMatrix(ctx) {
  const rows = ctx.matrix || [];
  const lanes = new Map();
  for (const r of rows) {
    const k = String(r.k);
    if (!lanes.has(k)) lanes.set(k, { lane: k, total: 0, issues: new Map() });
    const e = lanes.get(k);
    e.total += Number(r.ng) || 0;
    e.issues.set(String(r.iss), (e.issues.get(String(r.iss)) || 0) + (Number(r.ng) || 0));
  }
  const out = [...lanes.values()].sort((a, b) => b.total - a.total).slice(0, 10);
  return out.map(e => {
    const top = [...e.issues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { lane: e.lane, total: e.total, top: top.map(t => ({ issue: t[0], ng: t[1] })) };
  });
}

/* 时间分布：按小时看有没有「某班次集中」 */
function hourProfile(ctx) {
  const rows = ctx.times || [];
  const byHour = new Array(24).fill(0);
  const byDay = {};
  for (const r of rows) {
    const h = Number(r.hh);
    if (h >= 0 && h < 24) byHour[h] += Number(r.ng) || 0;
    const d = String(r.day || '').slice(0, 10);
    if (d) byDay[d] = (byDay[d] || 0) + (Number(r.ng) || 0);
  }
  const tot = byHour.reduce((a, b) => a + b, 0);
  const mean = tot / 24;
  let peakH = 0;
  for (let i = 1; i < 24; i++) if (byHour[i] > byHour[peakH]) peakH = i;
  const peak = byHour[peakH];
  /* v6.4：在原有 24 根柱之外，补「有没有突然上升」的判定。
     按天判趋势（天是最自然的趋势单位），按小时看班次集中度。
     数据量不够时 detectRise 自己会返回 unknown 并说明「看不出来」，不硬给结论。 */
  const dayKeys = Object.keys(byDay).sort();
  const rise = BU.detectRise(dayKeys.map(d => ({ label: d, ng: byDay[d] })), { unit: '天' });
  const shift = BU.shiftFocus(byHour);
  return {
    byHour, byDay, total: tot, mean,
    peakHour: peak > 0 ? peakH : null,
    peakRatio: mean > 0 ? peak / mean : null,
    rise,
    shift: shift ? { topShift: shift.topShift, shiftShare: shift.shiftShare, shifts: shift.shifts,
      peakRatio: shift.peakRatio } : null
  };
}

/* 慢性 / 突发：把本窗日均和历史同期日均比 */
function chronicity(ctx) {
  const hist = ctx.history || [];
  if (!hist.length) return null;
  const counts = hist.map(r => Number(r.ng) || 0).sort((a, b) => a - b);
  const med = counts[Math.floor(counts.length / 2)] || 0;
  /* v6.1 口径修复：不再 `|| 1` 静默回退成 1 天。
     优先 ctx.window.coveredDays，其次用 t0/t1 现算，都不成立就退回 collect 给的 winDays。 */
  let winDays = 0;
  if (ctx.window && Number(ctx.window.coveredDays) > 0) winDays = Number(ctx.window.coveredDays);
  else if (ctx.t0 && ctx.t1 && DU.coveredDays(ctx.t0, ctx.t1) > 0) winDays = DU.coveredDays(ctx.t0, ctx.t1);
  else winDays = Number(ctx.winDays) || 0;
  if (!(winDays > 0)) return null;
  const winTotal = Number(ctx.ngTotal && ctx.ngTotal.ng) || 0;
  const winDaily = winTotal / winDays;
  const delta = med > 0 ? (winDaily - med) / med : 0;
  const ratio = med > 0 ? winDaily / med : null;
  let level, tone, verdict;
  if (!hist.length) return null;
  if (med === 0 && winDaily > 0) { level = 'new'; tone = 'bad'; verdict = '这个工序历史上没有不良，本窗是新出现'; }
  else if (delta >= 3) { level = 'outbreak'; tone = 'bad'; verdict = '明显比历史基准差（是基准的 ' + n1(ratio) + ' 倍）'; }
  else if (delta >= 0.5) { level = 'slight'; tone = 'flat'; verdict = '比历史基准略高'; }
  else if (delta <= -0.5) { level = 'good'; tone = 'good'; verdict = '比历史基准好'; }
  else { level = 'chronic'; tone = 'flat'; verdict = '和平时差不多（慢性常态）'; }
  return {
    level, tone, verdict, winDaily: Math.round(winDaily * 10) / 10, winTotal, winDays,
    median: med, p90: counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.9))] || 0,
    ratio: ratio === null ? null : Math.round(ratio * 10) / 10,
    days: hist.map(r => ({ d: String(r.day).slice(0, 10), n: Number(r.ng) || 0 })),
    windowDays: winDays
  };
}

const DU = require('./date_utils');   /* v6.1：窗口天数统一由 date_utils 算 */
const ADJ = require('./stats_adjust');   /* v6.1 Task4：与前段共用同一套跨维度校正 */

const ACTIONS = {
  machine: '这台测试机先做日保养与校准确认（探针/治具定位/压接行程/传感器），再与同工序的正常机台对调治具复测',
  holder: '这个 holder 做治具点检：定位销、压头行程、探针磨损、接触电阻；把同一块板放到相邻 holder 复测比对',
  seat: '这个穴位做定位与夹持确认，同一块板换穴位复测，看不良是否跟着穴位走',
  lane: '这条轨道做传输与定位确认（挡停位置、宽度、有无卡板），换轨道复测同款板',
  hour: '这个时段先查换班/换线/停机重启记录、设备点检表与首件确认；同一台机换班后复测对比'
};

/* 现象 / 点位只做「构成描述」，不参与共性判定：给占比、不给倍数 */
function paretoOf(rows) {
  const list = rows || [];
  const total = list.reduce((a, r) => a + (Number(r.ng) || 0), 0);
  return list.map(r => ({
    value: String(r.v), ng: Number(r.ng) || 0,
    share: total > 0 ? (Number(r.ng) || 0) / total : 0,
    exp: null, rate: null, baseRate: null, lift: null,
    expShare: null, thin: false, sig: false, pAdj: null, seqs: [], machines: []
  })).slice(0, 60);
}

function analyze(ctx) {
  const dims = DIMS.map(def => codeDim(ctx, def));
  dims.push(hourDim(ctx));

  /* ★ v6.2：首因判读。先算「每块板最早在哪道工序被判 NG」，再给每个维度取值贴首因率。
     必须在 attachSignificance 之前贴上，因为后面要按首因率决定是否降级。 */
  let fc = null;
  try {
    fc = firstCauseOf(ctx);
    for (const d of dims) attachFirstCause(d, fc);
  } catch (e) { fc = null; }

  for (const d of dims) attachSignificance(d);
  /* ★ v6.1 Task4：后段 6 个维度 + 小时维度一起进 Holm 家族，与前段同一个函数 */
  const correction = ADJ.applyGlobalCorrection(dims, {
    alpha: ALPHA, liftSig: LIFT_SIG, minNg: MIN_NG,
    include: (d, it) => it.exp > 0 && it.expShare > 0 && it.ng > 0
  });

  const ranked = [], weak = [];
  for (const d of dims) {
    if (d.unavailable || d.kind !== 'code') continue;
    for (const it of d.items) {
      if (it.broken) continue;          /* 分母不全，倍数无意义 */
      if (it.ng < MIN_NG || it.thin) continue;
      if (it.exp < 5) continue;
      if (it.lift === null || it.lift < LIFT_SIG) continue;
      /* 穴位 / 轨道 / 生产小时：实测常常均匀（1.0×），均匀本身是结论，
         但不该挤进显著榜 —— 只在这三档真集中（≥1.3×）时才上报 */
      if (d.minLift && it.lift < d.minLift) continue;
      /* v6.1：入选只认跨维度 Holm 校正后的 pAdjGlobal（it.sig 已按全局口径重算） */
      const row = { key: d.key, label: d.label, kind: d.kind, item: it, dim: d };
      /* v6.2：首因率低 → 这条集中很可能是前站带出来的，不能当首因上榜。
         实测 AVI 是末站（11,034 个跨工序案例里 0 次先 NG），它的外观不良本质是
         前段置件的可见后果。降到 weak 里并保留判定，让它仍然可见但不冒头。 */
      const vd = verdictOf(it, fc);
      if (vd) row.verdict = vd;
      if (it.pAdjGlobal == null || it.pAdjGlobal >= ALPHA) { weak.push(row); continue; }
      if (it.sig && !(vd && vd.kind === 'carry')) ranked.push(row); else weak.push(row);
    }
  }
  ranked.sort((a, b) => b.item.lift - a.item.lift || b.item.ng - a.item.ng);
  weak.sort((a, b) => b.item.lift - a.item.lift || b.item.ng - a.item.ng);

  const approx = ADJ.approxNote({ ng: ctx.ngAgg || [] }, dims);
  const capCount = {}, overflow = {};
  const capped = [];
  for (const r of ranked) {
    capCount[r.key] = (capCount[r.key] || 0) + 1;
    if (capCount[r.key] > PER_DIM_CAP) { overflow[r.label] = (overflow[r.label] || 0) + 1; continue; }
    capped.push(r);
  }
  ranked.length = 0;
  Array.prototype.push.apply(ranked, capped);

  /* 头条不能拿「5 块板全坏」这种小样本顶上：倍数再高也只是噪音。
     规则：优先取不良数 ≥ 10 的项里倍数最高的；都不到 10 条，才退回原序。 */
  const solid = ranked.filter(r => r.item.ng >= 10);
  const scattered = ranked.length === 0;
  const top = (solid[0] || ranked[0]) || null;
  const totalNg = Number(ctx.ngTotal && ctx.ngTotal.ng) || 0;
  const totalExp = Number(ctx.denomTotal && ctx.denomTotal.exp) || 0;
  const baseRate = totalExp > 0 ? totalNg / totalExp : 0;

  const statNote = (ranked.length || weak.length)
    ? `（判据：二项上尾检验 + Holm 跨维度校正，α=0.05；不良 ${MIN_NG} 条、过站 5 板、倍数 ${LIFT_SIG}× 三道门槛，样本少时"看着高"不算）`
    : '';

  let level, headline;
  if (!totalNg) {
    level = 'scattered';
    headline = '这个条件下没有不良记录。';
  } else if (scattered) {
    level = 'scattered';
    const spread = dims.filter(d => d.kind === 'code' && !d.unavailable)
      .map(d => `${d.label} ${d.spread} 个`).join('、');
    /* ★ 后段没共性时不许含糊，直接说「BE 无共性」，并把判断权交给前后段联动 */
    /* v6.1：措辞收紧。原来写「不是某一台机/某一条线做坏的」= 把没显著说成已排除，
       样本少、维度不可用时这句话不成立。改成"没看到集中在"，并明确"不等于已经排除"。 */
    headline = `BE 段无共性（这 ${totalNg} 块不良板散在 ${spread} 上，` +
      `当前样本里没看到集中在某一台机 / 某一条线，这不等于已经排除）。` +
      `下一步看下面「前后段联动」——已把这些板映射回前段 SMT 的面板码，` +
      `再看它们在前段工序 / 工站 / 机台 / 吸嘴 / 飞达上有没有集中。`;
    if (weak.length) {
      headline += ` 另有 ${weak.length} 项「看着偏高但没通过检验」（如 ` +
        weak.slice(0, 3).map(w => w.label + ' ' + w.item.value).join('、') + '），不能当结论。';
    }
  } else {
    level = (top.item.lift >= 3 && top.item.ng >= 5) ? 'high' : 'mid';
    /* 说人话：后段分母是真板数，所以直接说「不良率」——比「占比」好懂 */
    headline = `${level === 'high' ? '高度怀疑' : '中度怀疑'}「${top.label}：${top.item.value}」` +
      `——不良率 ${pct(top.item.rate)}（全场 ${pct(baseRate)}），是整体的 ${n1(top.item.lift)} 倍；` +
      `它过站 ${top.item.exp} 块、出了 ${top.item.ng} 块不良。` +
      ` 这只能说明「在这道工序/这台机集中」，是不是前段 SMT 埋下的，看下面「前后段联动」。`;
  }

  /* 建议动作 */
  const suggestions = [];
  if (!scattered) {
    const pick = solid.length ? solid : ranked;
    for (const r of pick.slice(0, 3)) {
      const a = ACTIONS[r.key];
      if (a && !suggestions.some(s => s.act === a)) suggestions.push({ dim: r.label, value: r.item.value, act: a });
    }
  } else {
    suggestions.push({ dim: '来料/治具/手法', value: '—',
      act: '单机台/线体/工位已排除：查这几天的来料批次切换点、治具是否混用、以及该工位的作业手法与洁净度' });
  }

  const shareDims = dims.filter(d => d.kind === 'share' && !d.unavailable);
  for (const d of shareDims) {
    const t0 = d.items[0];
    if (t0 && t0.share >= 0.5) {
      suggestions.push({ dim: d.label + '集中', value: t0.value,
        act: `「${t0.value}」一项就占了 ${pct(t0.share)}，先按这一个现象收敛排查范围，别一次性铺开` });
    }
  }

  /* 分母不全的项汇总成一条提醒（不参与任何结论） */
  const brokenItems = [];
  for (const d of dims) {
    if (d.kind !== 'code' || d.unavailable) continue;
    for (const it of d.items) if (it.broken) brokenItems.push({ dim: d.label, value: it.value, ng: it.ng, exp: it.exp });
  }

  const hour = hourProfile(ctx);
  const confoundNotes = [];
  if (brokenItems.length) {
    const b0 = brokenItems.sort((a, b) => b.ng - a.ng)[0];
    confoundNotes.push(
      `${brokenItems.length} 个取值的「不良板数」比「过站板数」还多（最典型：${b0.dim} ${b0.value}，` +
      `过站 ${b0.exp} 块却出了 ${b0.ng} 块不良）——这是过站记录滞后回填造成的，` +
      `这些取值已经从上面的显著榜里剔除，不能按倍数下结论。` +
      `要算准它们，把结束日期往前挪一天再跑一次。`);
  }
  /* 共线检查（v6.0 改写）：只看「测试机台」这一维 —— 后段很多成品测试机是专机专做，
     一台机只做一个产品、这个产品也只在这台机上测，此时「机台」和「产品」在数据里完全重合，
     倍数再高也分不清是机台问题还是产品本身难做。
     实测 PRODUCT-B-003 两个产品的 AVI 不良 100% 出自 LINE-E 一台机。
     数据源用 ctx.ngAgg（它仍按 机台/线体/产品/工单 分组，没被删）。 */
  if (top && top.key === 'machine') {
    const rows = (ctx.ngAgg || []).filter(r => String(r.m) === String(top.item.value));
    const prods = [...new Set(rows.map(r => String(r.p || '')).filter(Boolean))];
    if (prods.length === 1) {
      confoundNotes.push(`「${top.item.value}」在这批不良里只做过 ${prods[0]} 一个产品，而全区也只有这个产品在它上面测——` +
        `机台和产品完全重合，分不清是这台机做坏的还是这个产品本来就难做。` +
        `要分开：查这个产品在别的机台上测同一道工序时的表现，或看这台机换产品后的表现。`);
    }
  }
  if (hour.peakRatio && hour.peakRatio >= 2 && hour.total >= 20) {
    confoundNotes.push(`${hour.peakHour}:00 这一小时的不良是全天均值的 ${n1(hour.peakRatio)} 倍——` +
      `先确认是换班/换线/停机重启造成的，还是真的某个时段出问题。`);
  }

  const spreadNotes = [];
  if (scattered) {
    for (const d of dims) {
      if (d.unavailable || d.kind !== 'code') continue;
      if (d.spread >= 3) spreadNotes.push(`${d.label}：${d.ng} 块不良板散在 ${d.spread} 个不同取值上`);
    }
  }

  const retest = ctx.retest || [];
  const retestNote = retest.length
    ? retest.map(r => `测${r.v}次：${r.ng} 块`).join(' · ')
    : '';

  /* v6.2 首因判读的汇总（给前端/报告用）：
     · firstRate  —— 这批不良板里，有多少块是「在本工序第一次被判 NG」
     · 末站硬提醒 —— 外观类工序(AVI/AVI-EB)天然是末站，它的不良多是前段置件的可见后果 */
  const firstNote = (() => {
    if (!fc || !fc.boards) return null;
    const lines = [];
    if (fc.priorBoards > 0) {
      const where = fc.prior.slice(0, 3).map(x => `${x.label} ${x.n} 块`).join('、');
      lines.push(`本批 ${fc.boards} 块不良板里，${fc.firstBoards} 块（${pct(fc.firstRate)}）是` +
        `「在本工序第一次被判 NG」，${fc.priorBoards} 块（${pct(fc.priorRate)}）在此之前就已经在前站 NG 过` +
        `${where ? `（${where}）` : ''}。` +
        `首因率低的那几项，集中可能是前站缺陷的再现，别当成这一站的独立问题查。`);
    } else {
      lines.push(`本批 ${fc.boards} 块不良板全部是「在本工序第一次被判 NG」` +
        `（往前 ${Number(ctx.opt && ctx.opt.histDays) || 30} 天查不到更早的 NG 记录）——` +
        `这些不良可以当首因看，不是前站带出来的。`);
    }
    /* 末站硬提醒：数据推导而非猜 —— AVI 在 11,034 个跨工序案例里 0 次先 NG */
    const p0 = ctx.opt && ctx.opt.beProc;
    if (p0 === 'AVI' || p0 === 'AVI-EB') {
      lines.push(`注意：${BS.BE_PROC_LABEL(p0)} 是后段最末的外观检查站，` +
        `外形/偏移/缺件这类不良往往是【前段 SMT 置件】的可见后果，` +
        `不是测试站自己做坏的 —— 务必先看下面「前后段联动」的 SMT 结论，再决定查哪里。`);
    }
    /* 必须如实交代：跨工序「是不是同一个缺陷」判不出来 */
    if (fc.priorBoards > 0) {
      lines.push(`说明：这里只判得出「谁先坏」，判不出「前站那个缺陷和本站这个缺陷是不是同一个」——` +
        `后段各工序的判据词表不通用（VSWR 记 S11:Ant4 端口，AVI 记外观缺陷名），` +
        `文字比对没有意义。要区分「同一个缺陷往下传」还是「同一块板多处独立问题」，` +
        `请看下面「现象构成」里各工序的现象名是否指向同一处物理部位。`);
    }
    return {
      boards: fc.boards, firstBoards: fc.firstBoards, priorBoards: fc.priorBoards,
      firstRate: fc.firstRate, priorRate: fc.priorRate, prior: fc.prior,
      proc: p0, procLabel: BS.BE_PROC_LABEL(p0 || ''),
      notes: lines
    };
  })();

  return {
    level, headline, statNote, ranked, weak, dims, overflow,
    confoundNotes, spreadNotes, suggestions, firstNote,
    chronicity: chronicity(ctx),
    correction, approx, scattered: ADJ.SCATTERED,
    hour, laneIssues: laneIssueMatrix(ctx),
    /* ★ v5.1：issue/point 已不是共性维度，但「不良现象构成」仍要在下面单列一张描述表，
       所以直接从 ctx 算，别再去 dims 里找（dims 里已经没有它们了）。 */
    issuePareto: paretoOf(ctx.issues),
    pointPareto: paretoOf(ctx.points),
    retestNote,
    coverage: totalExp > 0 ? Math.min(1, totalExp / Math.max(totalExp, totalNg)) : 0,
    counts: { ng: totalNg, boards: totalNg, placements: totalExp, baseRate },
    trend: { rows: (ctx.history || []).map(r => ({ d: String(r.day).slice(0, 10), ng: Number(r.ng) || 0 })), today: hour.byDay }
  };
}

module.exports = {
  analyze, binomSF, pct, n1, ACTIONS, DIMS,
  MIN_NG, LIFT_SIG, ALPHA, THIN_EXP, PER_DIM_CAP,
  chronicity,
  /* v6.2 首因判读：导出给回归测试用，不对外暴露成接口 */
  firstCauseOf, attachFirstCause, verdictOf,
};
