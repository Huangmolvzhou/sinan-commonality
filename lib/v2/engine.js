/* ================================================================
   共性归因引擎 v2（纯计算，无 IO，可在 Node 直接跑）
   数据契约：
     ctx = {
       pos,                       // 被分析的位号（如 COMP-A）
       ng:      [ {panel, seq, time, issue} ],
       place:   { [panel]: [ {seq, nozzle, feeder, table, pickPos, machine, setup, begin} ] },  // 该位号每块板的全部穴位贴装
       matl:    { ['<mtID>|<table>|<pick>']: {matr, vendor, lot, mpn} },
       board:   { [panel]: {fixture, steel, fixture2, order, morder, model, line, program, spi} },
       base:    { days: [{d, n}], ngByDay: {d:n} }
     }
   三条口径（不许改，改前先读 smt-commonality-tool-dev / flex-commonality-tool-dev）：
     ① 批内对照：同一块板、同一位号、其余穴位的贴装互为对照（暴露精确，不用抽样）
     ② 面板级维度（载具/钢片/程序/线体/SPI）：暴露 = 板数
     ③ lift = 该取值不良占比 ÷ 该取值暴露占比（share ÷ 均匀占比），不是绝对占比
   ================================================================ */
const DU = require('./date_utils');   /* v6.1：窗口天数统一由 date_utils 算 */
const ADJ = require('./stats_adjust');   /* v6.1 Task4：跨维度 Holm 校正 */
const PS = require('./passive');         /* v6.3：被动共现分离（谁被谁拖出来的） */
const BU = require('./burst');           /* v6.4：时间段分布 + 有无突然上升 */

const MIN_NG = 3;          // 单取值至少 3 条不良才进榜
const LIFT_SIG = 1.5;      // 低于 1.5 倍不算信号
const THIN_EXP = 3;        // 暴露数低于此标记 thin
const ALPHA = 0.05;        // 显著性水平（Bonferroni 校正后）

/* ---------- 二项分布上尾 + Bonferroni 多重比较 ----------
   为什么必须有：90 个穴位、59 个批号里，总会有几个取值「碰巧」凑出 3 条不良，
   按 lift 排就会把噪音顶到榜首（实测：3 条不良被算成 11.2×）。
   判据：P(X>=k | n, 全局不良率) 经「本维度检验了多少个取值」校正后仍 <0.05 才算信号。 */
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

function pct(x) {
  if (x === null || x === undefined || isNaN(x)) return '—';
  const p = x * 100;
  return (p > 0 && p < 0.01 ? p.toFixed(3) : p.toFixed(2)) + '%';
}
function n1(x) {
  if (x === null || x === undefined || !isFinite(x)) return '—';
  return (Math.round(x * 10) / 10).toFixed(1) + '×';
}

/* ---------- 批内对照维度 ---------- */
/* 每个取值：暴露 = 该取值出现在多少次贴装里；不良 = 其中被判 NG 的次数 */
function withinDim(ctx, key, label) {
  const ngSet = new Set(ctx.ng.map(r => r.panel + '\u0001' + r.seq));
  let exp = 0, ngN = 0;
  const cnt = new Map();       // value -> {exp, ng}
  const seqsByVal = new Map(); // value -> Set(seq)
  const machinesByVal = new Map();

  for (const panel of Object.keys(ctx.place || {})) {
    for (const p of ctx.place[panel]) {
      const v = p[key];
      if (v === null || v === undefined || String(v).trim() === '') continue;
      const vv = String(v);
      exp++;
      let e = cnt.get(vv);
      if (!e) { e = { exp: 0, ng: 0 }; cnt.set(vv, e); }
      e.exp++;
      if (ngSet.has(panel + '\u0001' + p.seq)) {
        e.ng++; ngN++;
        if (!seqsByVal.has(vv)) seqsByVal.set(vv, new Set());
        seqsByVal.get(vv).add(p.seq);
        if (p.machine) {
          if (!machinesByVal.has(vv)) machinesByVal.set(vv, new Set());
          machinesByVal.get(vv).add(p.machine);
        }
      }
    }
  }
  const baseRate = exp > 0 ? ngN / exp : 0;
  const items = [];
  for (const [value, e] of cnt) {
    const rate = e.exp > 0 ? e.ng / e.exp : 0;
    const lift = baseRate > 0 ? rate / baseRate : null;
    items.push({
      value, ng: e.ng, exp: e.exp, rate, baseRate, lift,
      share: ngN > 0 ? e.ng / ngN : 0, expShare: exp > 0 ? e.exp / exp : 0,
      thin: e.exp < THIN_EXP,
      seqs: seqsByVal.has(value) ? [...seqsByVal.get(value)].sort((a, b) => a - b) : [],
      machines: machinesByVal.has(value) ? [...machinesByVal.get(value)] : []
    });
  }
  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng || String(a.value).localeCompare(String(b.value)));
  return {
    key, label, kind: 'within',
    exp, ng: ngN, baseRate, items,
    spread: items.filter(i => i.ng > 0).length,
    dimsInExposure: items.length
  };
}

/* ---------- 面板级维度 ----------
   ★ 关键：分析批里全是 NG 板，批内对照必然算出 lift=1（每块板都是不良）。
     所以面板级维度（载具/线体/程序）必须用「同窗口 OK 板抽样」做暴露，
     没有基准就明确标 baseSrc='batch'，并告诉用户结果不可用于归因。 */
function panelDim(ctx, key, label, getter, baseKey) {
  const ngPanels = new Set(ctx.ng.map(r => r.panel));
  const bp = ctx.base && ctx.base.panels;
  const baseDist = bp && baseKey ? bp[baseKey] : null;
  const cnt = new Map();
  let exp = 0, ngN = 0;
  for (const panel of Object.keys(ctx.board || {})) {
    const v = getter(ctx.board[panel], panel);
    if (v === null || v === undefined || String(v).trim() === '') continue;
    const vv = String(v);
    exp++;
    let e = cnt.get(vv);
    if (!e) { e = { exp: 0, ng: 0 }; cnt.set(vv, e); }
    e.exp++;
    if (ngPanels.has(panel)) { e.ng++; ngN++; }
  }
  const baseRate = exp > 0 ? ngN / exp : 0;

  /* 基准侧：每个取值的暴露占比 */
  let baseTotal = 0;
  const baseShare = new Map();
  if (baseDist) {
    for (const [k, v] of Object.entries(baseDist)) { baseTotal += v; baseShare.set(String(k), v); }
  } else {
    for (const [k, e] of cnt) { baseTotal += e.exp; baseShare.set(String(k), e.exp); }
  }

  const items = [];
  for (const [value, e] of cnt) {
    const rate = e.exp > 0 ? e.ng / e.exp : 0;
    const bExp = baseShare.get(value) || 0;
    const bRate = baseTotal > 0 ? bExp / baseTotal : 0;
    items.push({
      value, ng: e.ng, exp: e.exp, rate, baseRate,
      lift: bRate > 0 ? (e.ng / ngN) / bRate : null,   // share ÷ 均匀占比
      share: ngN > 0 ? e.ng / ngN : 0,
      expShare: bRate,
      thin: e.exp < THIN_EXP, seqs: [], machines: []
    });
  }
  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng || String(a.value).localeCompare(String(b.value)));
  return {
    key, label, kind: 'panel',
    exp, ng: ngN, baseRate, items,
    baseSrc: baseDist ? 'baseline' : 'batch',
    baseN: baseTotal,
    spread: items.filter(i => i.ng > 0).length,
    dimsInExposure: items.length,
    unavailable: baseDist ? null : '没有可比对的 OK 板基准，本维度只能给「不良分布占比」，不能给倍数'
  };
}


/* ---------- 同一把吸嘴 / 同一把飞达 跨机台 ----------
   目的：区分「机台效应」和「吸嘴效应」。
   · 同一把吸嘴在 A 机 2.6%、B 机 0.5% → 是机台的问题，换吸嘴没用
   · 同一把吸嘴在 A、B 两台都高          → 才是吸嘴自己的问题
   · 同一把飞达只在一台机出现              → 物理上装在机台上，跨机台无意义（要写清楚） */
function normSF(z) {                       /* 标准正态上尾 P(Z>=z) */
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? p : 1 - p;
}
function zTest(x1, n1, x2, n2) {
  if (n1 < 20 || n2 < 20) return { z: null, p: null, thin: true };
  const p1 = x1 / n1, p2 = x2 / n2, ph = (x1 + x2) / (n1 + n2);
  if (ph <= 0 || ph >= 1) return { z: null, p: null, thin: false };
  const se = Math.sqrt(ph * (1 - ph) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p1 - p2) / se : 0;
  return { z, p: 2 * normSF(Math.abs(z)), thin: false };
}

/* 造一个「取值 × 机台」的矩阵 */
function machineMatrix(ctx, key, label) {
  const ngSet = new Set(ctx.ng.map(r => r.panel + '\u0001' + r.seq));
  const cells = new Map();       // value -> machine -> {exp,ng}
  for (const panel of Object.keys(ctx.place || {})) {
    for (const p of ctx.place[panel]) {
      const v = p[key], m = p.machine;
      if (v === null || v === undefined || String(v).trim() === '') continue;
      if (!m) continue;
      if (!cells.has(v)) cells.set(v, new Map());
      const mm = cells.get(v);
      if (!mm.has(m)) mm.set(m, { exp: 0, ng: 0 });
      const c = mm.get(m);
      c.exp++;
      if (ngSet.has(panel + '\u0001' + p.seq)) c.ng++;
    }
  }
  const machines = [...new Set([].concat(...[...cells.values()].map(mm => [...mm.keys()])))].sort();
  const rows = [];
  for (const [v, mm] of cells) {
    const row = { value: v, cells: {}, machines: [], crossCount: 0, thin: false };
    for (const m of machines) {
      const c = mm.get(m);
      if (!c) continue;
      row.cells[m] = { exp: c.exp, ng: c.ng, rate: c.exp ? c.ng / c.exp : null };
      row.machines.push(m);
    }
    row.exp = row.machines.reduce((s, m) => s + row.cells[m].exp, 0);
    row.ng = row.machines.reduce((s, m) => s + row.cells[m].ng, 0);
    row.crossCount = row.machines.length;
    if (row.machines.length >= 2) {
      const ms = row.machines.filter(m => row.cells[m].exp >= 20);
      if (ms.length >= 2) {
        const a = ms[0], b = ms[1];
        const t = zTest(row.cells[a].ng, row.cells[a].exp, row.cells[b].ng, row.cells[b].exp);
        row.z = t.z; row.p = t.p;
        if (t.p != null && t.p < 0.05) {
          row.winner = row.cells[a].rate > row.cells[b].rate ? a : b;
          row.loser = row.cells[a].rate > row.cells[b].rate ? b : a;
          row.verdict = '机台效应';
        } else {
          row.verdict = '无差异';
        }
      } else { row.verdict = '样本不足'; row.thin = true; }
    } else {
      row.verdict = '只在一台机';
    }
    rows.push(row);
  }
  rows.sort((a, b) => (b.ng - a.ng) || String(a.value).localeCompare(String(b.value)));
  const cross = rows.filter(r => r.crossCount >= 2);
  const tested = cross.filter(r => r.p != null).length;   // 参与检验的取值个数
  for (const r of rows) {
    if (r.p == null) continue;
    r.pAdj = Math.min(1, r.p * Math.max(1, tested));
    if (r.pAdj < 0.05) {
      const ms = r.machines.filter(m => r.cells[m].exp >= 20).slice(0, 2);
      const a = ms[0], b = ms[1];
      r.winner = r.cells[a].rate > r.cells[b].rate ? a : b;
      r.loser = a === r.winner ? b : a;
      r.verdict = '机台效应';
    } else {
      /* 倍差很大但样本不够 → 不能写「无差异」，要写「还没判出来」 */
      const ms = r.machines.filter(m => r.cells[m].exp >= 20).slice(0, 2);
      const p1 = r.cells[ms[0]].rate, p2 = r.cells[ms[1]].rate;
      const hi = Math.max(p1, p2), lo = Math.min(p1, p2);
      r.ratio = lo > 0 ? hi / lo : (hi > 0 ? null : 1);   // null = 分母为 0，JSON 里不能有 Infinity
      if (hi >= 0.01 && (r.ratio == null || r.ratio >= 2)) {   // 分母为 0 也算倍差极大
        r.verdict = '差异未达显著';
        r.winner = p1 > p2 ? ms[0] : ms[1];
      } else {
        r.verdict = '无差异';
      }
    }
  }
  const sig = cross.filter(r => r.verdict === '机台效应');
  const near = cross.filter(r => r.verdict === '差异未达显著');
  return { key, label, machines, rows, crossable: cross.length, sigCount: sig.length, nearCount: near.length };
}

/* 汇总：多数吸嘴在同一台机上更差 → 机台级结论 */
function matrixVerdict(mx) {
  if (!mx || !mx.rows.length) return null;
  if (!mx.crossable) return { level: 'none', text: '这批数据里没有「同一取值跨两台机」的情况，无法分离机台与' + mx.label + '。' };
  const sig = mx.rows.filter(r => r.verdict === '机台效应');
  const near = mx.rows.filter(r => r.verdict === '差异未达显著');
  if (!sig.length) {
    let t = mx.crossable + ' 个取值跨机台，没有一个通过显著性检验';
    if (near.length) {
      t += '；但有 ' + near.length + ' 个「倍差大、样本还不够」：' +
        near.map(r => r.value + ' 在 ' + r.winner + ' 上 ' +
          (r.cells[r.winner].rate * 100).toFixed(1) + '% vs 另一台 ' +
          (r.cells[r.machines.filter(m => m !== r.winner)[0]].rate * 100).toFixed(1) + '%（' +
          (r.ratio == null ? '∞' : r.ratio.toFixed(1)) + ' 倍，p校正 ' +
          (r.pAdj < 0.001 ? '<0.001' : r.pAdj.toFixed(3)) + '）') .join('；') +
        '。把时间窗放到 7 天（不良数翻倍）再跑一次，就能判出来。';
      const dir = {};
      near.forEach(r => { if (r.winner) dir[r.winner] = (dir[r.winner] || 0) + 1; });
      const one = Object.entries(dir).sort((a, b) => b[1] - a[1])[0];
      if (one && one[1] === near.length && near.length >= 3) {
        t += ' ★ 注意：' + near.length + ' 个「倍差大」的方向全部指向 ' + one[0] +
          '，单个不显著但方向一致 —— 这本身就是弱证据，扩样优先验 ' + one[0] + '。';
      }
    } else {
      t += ' —— 机台与' + mx.label + '分得开，且都不构成信号。';
    }
    return { level: near.length ? 'near' : 'none', text: t };
  }
  const tally = {};
  for (const r of sig) tally[r.winner] = (tally[r.winner] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  const share = top[1] / sig.length;
  if (share >= 0.7) {
    return { level: 'machine', machine: top[0],
      text: `同一把${mx.label}在 ${top[0]} 上系统性更差（${top[1]}/${sig.length} 个取值显著偏向 ${top[0]}）—— ` +
        `这是**机台效应**，换${mx.label}没用，要查 ${top[0]} 的真空/压力/校准。` };
  }
  return { level: 'mixed',
    text: `${sig.length} 个取值跨机台有显著差异，但方向不一致（${Object.entries(tally).map(([m, n]) => m + ' ' + n + ' 个').join('、')}）—— 不是单纯机台问题，要逐个看。` };
}


/* ---------- 钢网（同期对照） ----------
   钢网是会换的耗材：拿「前 7 天」做分母会得出假信号（实测某钢网 10/08 才上线，
   前 7 天只有 10 块板 → 算出 64×，实际同期用量 1569 块，根本不是信号）。
   所以分母用「分析窗同期、同线体、该钢网实际印了多少块板」。 */
function stencilDim(ctx) {
  const sw = ctx.base && ctx.base.stencilWindow;
  const head = { key: 'stencil', label: '钢网（同期）', kind: 'stencil' };
  if (!sw || !sw.total) return Object.assign(head, { unavailable: '钢网取数失败或没有 Printer 记录', items: [], exp: 0, ng: 0, spread: 0, dimsInExposure: 0 });
  const ngPanels = new Set(ctx.ng.map(r => r.panel));
  const cnt = new Map();
  let ngN = 0;
  for (const p of Object.keys(ctx.board || {})) {
    const v = ctx.board[p].stencil;
    if (!v) continue;
    const e = cnt.get(v) || { exp: 0, ng: 0 };
    e.exp = sw.byStencil[v] || e.exp;   // 暴露取同期实际用量
    if (ngPanels.has(p)) { e.ng++; ngN++; }
    cnt.set(v, e);
  }
  for (const [v, e] of cnt) if (!e.exp) e.exp = sw.byStencil[v] || 0;
  const baseRate = sw.total ? ngN / sw.total : 0;
  const items = [];
  for (const [value, e] of cnt) {
    const expShare = sw.total ? e.exp / sw.total : 0;
    const share = ngN ? e.ng / ngN : 0;
    items.push({
      value, ng: e.ng, exp: e.exp, rate: e.exp ? e.ng / e.exp : 0,
      lift: expShare > 0 ? share / expShare : null,
      share, expShare, thin: e.exp < 10, seqs: [], machines: []
    });
  }
  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng);
  return Object.assign(head, {
    exp: sw.total, ng: ngN, baseRate, items, baseSrc: 'window', baseN: sw.total,
    spread: items.filter(i => i.ng > 0).length, dimsInExposure: items.length
  });
}

/* ---------- 载具 · 跨工单 ----------
   暴露：这个载具在最近 N 天里跑过的所有板（跨工单）
   不良：其中「同机台 + 同点位 + 同现象」被判 NG 的板
   回答的问题：这个载具在别的工单也出不良吗？只在这一个工单出 → 载具大概率不是主因。 */
function crossDim(ctx) {
  const c = ctx.base && ctx.base.cross;
  const head = { key: 'fixtureX', label: '载具·跨工单', kind: 'cross' };
  if (!c || !c.byFixture || !Object.keys(c.byFixture).length) {
    return Object.assign(head, { unavailable: '跨工单载具取数失败，或这批不良板没有载具号',
      items: [], exp: 0, ng: 0, spread: 0, dimsInExposure: 0 });
  }
  let expTotal = 0, ngTotal = 0;
  for (const v of Object.values(c.byFixture)) { expTotal += v.panels; ngTotal += v.ng; }
  const items = [];
  for (const [f, v] of Object.entries(c.byFixture)) {
    const expShare = expTotal ? v.panels / expTotal : 0;
    const share = ngTotal ? v.ng / ngTotal : 0;
    items.push({
      value: f, ng: v.ng, exp: v.panels,
      rate: v.panels ? v.ng / v.panels : 0,
      lift: expShare > 0 ? share / expShare : null,
      share, expShare,
      thin: v.panels < 10,
      orders: v.orderList || [], ngOrders: v.ngOrders || [],
      panelsByOrder: v.panelsByOrder || {}, ngByOrder: v.orders || {},
      seqs: [], machines: []
    });
  }
  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng || String(a.value).localeCompare(String(b.value)));
  return Object.assign(head, {
    exp: expTotal, ng: ngTotal, items,
    baseSrc: 'cross', baseN: expTotal,
    window: { from: String(c.from).slice(0, 10), to: String(c.to).slice(0, 10) },
    spread: items.filter(i => i.ng > 0).length,
    dimsInExposure: items.length
  });
}

/* ---------- 穴位维度（每板每穴位一次机会，暴露天然均匀） ---------- */
function seqDim(ctx) {
  const panels = Object.keys(ctx.place || {}).length;
  const per = new Map();
  for (const panel of Object.keys(ctx.place || {})) {
    for (const p of ctx.place[panel]) {
      const s = String(p.seq);
      per.set(s, (per.get(s) || 0) + 1);
    }
  }
  const ngBySeq = new Map();
  for (const r of ctx.ng) ngBySeq.set(String(r.seq), (ngBySeq.get(String(r.seq)) || 0) + 1);
  const totalExp = [...per.values()].reduce((a, b) => a + b, 0);
  const ngN = ctx.ng.length;
  const baseRate = totalExp > 0 ? ngN / totalExp : 0;
  const items = [];
  for (const [value, exp] of per) {
    const ng = ngBySeq.get(value) || 0;
    const rate = exp > 0 ? ng / exp : 0;
    items.push({
      value, ng, exp, rate, baseRate,
      lift: baseRate > 0 ? rate / baseRate : null,
      share: ngN > 0 ? ng / ngN : 0, expShare: totalExp > 0 ? exp / totalExp : 0,
      thin: exp < THIN_EXP, seqs: [Number(value)], machines: []
    });
  }
  items.sort((a, b) => (b.lift || 0) - (a.lift || 0) || Number(a.value) - Number(b.value));
  return { key: 'seq', label: '穴位（SeqNo）', kind: 'seq', exp: totalExp, ng: ngN, baseRate, items,
    spread: items.filter(i => i.ng > 0).length, dimsInExposure: items.length };
}

/* 给一个维度挂上显著性（Bonferroni 校正）
   检验口径统一为：把「这批不良」当成样本，看它的分布是否偏离「暴露分布」。
   p = P(X ≥ 实测不良数 | n = 本维总不良数, p = 该取值的暴露占比) */
function attachSignificance(d) {
  const tested = d.items.filter(i => i.exp >= THIN_EXP && i.expShare > 0).length;
  const n = d.ng;
  for (const it of d.items) {
    if (n > 0 && it.expShare > 0 && it.ng > 0) {
      it.p = binomSF(it.ng, n, it.expShare);
      it.pAdj = Math.min(1, it.p * Math.max(1, tested));
      it.sig = it.pAdj < ALPHA && (it.lift || 0) >= LIFT_SIG && it.ng >= MIN_NG;
    } else { it.p = null; it.pAdj = null; it.sig = false; }
  }
  d.tested = tested;
  return d;
}

/* ---------- 趋势（前 N 天同产品同点位） ---------- */
function trend(ctx) {
  const days = (ctx.base && ctx.base.days) || [];
  const ngByDay = (ctx.base && ctx.base.ngByDay) || {};
  const rows = days.map(d => ({ d: d.d, inspected: d.n, ng: ngByDay[d.d] || 0,
    rate: d.n > 0 ? (ngByDay[d.d] || 0) / d.n : 0 }));
  const today = {};
  for (const r of ctx.ng) {
    /* v6.4 修 bug：r.time 是 Date 对象，原来 String(r.time).slice(0,10) 得到的是
       "Mon Oct 19" 这种字符串，和 "2026-10-19" 永远比不相等 —— 导致按天聚合全废。 */
    const d = DU.mesDayOf(r.time);
    if (d) today[d] = (today[d] || 0) + 1;
  }
  return { rows, today };
}


/* ---------- 慢性 / 突发 ----------
   用户提的问题：如果这几天不良本来就很高，所谓「基准」就被污染了，
   算出来的倍数不能说明「这次变差了」。这里单独判断：
   把分析窗的日均条数，和历史 30 天的中位数比 —— 只看条数，不看倍数。 */
/** v6.1：窗口信息只认 ctx.window（collect 算好传进来），没有就用 t0/t1 现算；
 *  两者都不成立时返回 null —— 绝不静默回退成「1 天」。 */
function windowOf(ctx) {
  if (ctx && ctx.window && Number(ctx.window.coveredDays) > 0) return ctx.window;
  if (ctx && ctx.t0 && ctx.t1) {
    const h = DU.coveredHours(ctx.t0, ctx.t1);
    if (h > 0) return { t0: ctx.t0, t1: ctx.t1, coveredHours: h, coveredDays: h / 24 };
  }
  return null;
}

function chronicity(ctx) {
  const h = ctx.base && ctx.base.history;
  if (!h || !h.days || !h.days.length) return null;
  const win = windowOf(ctx);
  if (!win || !(win.coveredDays > 0)) return null;
  const byDay = {};
  for (const r of ctx.ng) {
    /* v6.4 修 bug：同 trend()，r.time 是 Date，必须用 localDayOf 转成 YYYY-MM-DD，
       否则 byDay 的 key 是 "Mon Oct 19"，页面上「本窗」的深色柱一根都匹配不到。 */
    const d = DU.mesDayOf(r.time);
    if (d) byDay[d] = (byDay[d] || 0) + 1;
  }
  /* v6.1 口径修复：分母必须是「窗口实际覆盖天数」，不是「出现不良的天数」。
     旧写法 winDays = Object.keys(byDay).length 会把「7 天里只有 1 天发作」算成每天都发作。 */
  const winDays = win.coveredDays;
  const winTotal = Object.keys(byDay).reduce((a, k) => a + byDay[k], 0);
  const winDaily = winTotal / winDays;
  const med = h.median || 0;
  const ratio = med > 0 ? winDaily / med : (winDaily > 0 ? 99 : 1);
  /* 窗口不足 24 小时时，页面要说明「按实际 X 小时折算」，避免把 6 小时当一天读 */
  const shortWindow = win.coveredHours < 24;
  const winNote = shortWindow
    ? '本窗只有 ' + n1(win.coveredHours) + ' 小时，日均按 ' + n1(win.coveredHours) + ' 小时折算成 ' + n1(winDays) + ' 天；小时级窗口可能受数据回填影响。'
    : '';
  let level, text;
  if (med === 0) {
    level = winDaily > 0 ? 'new' : 'none';
    text = winDaily > 0 ? '过去 30 天这个点位没有不良记录，本窗口是新出现的' : '过去 30 天没有不良记录';
  } else if (ratio < 0.7) {
    level = 'chronic';
    text = '这个点位过去 30 天每天有 ' + med + ' 条左右（P90 ' + h.p90 + '），本窗口日均只有 ' +
      winDaily.toFixed(1) + ' 条（' + ratio.toFixed(2) + ' 倍）—— 属于长期存在的问题，这一窗并不比平时差，甚至更好。' +
      '下面的共性分析回答的是「不良集中在哪」，不是「这次为什么变差」。';
  } else if (ratio < 1.3) {
    level = 'chronic';
    text = '这个点位过去 30 天每天有 ' + med + ' 条左右（P90 ' + h.p90 + '），本窗口日均 ' +
      winDaily.toFixed(1) + ' 条，属于慢性水平、不是突发。下面的共性分析回答的是「不良集中在哪」，不是「这次为什么变差」。';
  } else if (ratio < 2) {
    level = 'slight';
    text = '本窗口日均 ' + winDaily.toFixed(1) + ' 条，是历史中位数（' + med + '）的 ' + ratio.toFixed(1) +
      ' 倍，略有抬升，但还没到突发的程度。';
  } else {
    level = 'outbreak';
    text = '本窗口日均 ' + winDaily.toFixed(1) + ' 条，是历史中位数（' + med + '）的 ' + ratio.toFixed(1) +
      ' 倍 —— 这次确实比平时差，共性分析的倍数可以直接用。';
  }
  /* 一句话结论：这一窗比历史基准是变好还是变差 */
  const delta = med > 0 ? (winDaily - med) / med : 0;
  let tone, verdict;
  if (med === 0) { tone = 'again'; verdict = winDaily > 0 ? '这次新出现（历史无记录）' : '与历史持平'; }
  else if (delta <= -0.15) { tone = 'good'; verdict = '比历史基准好 ' + Math.abs(delta * 100).toFixed(0) + '%'; }
  else if (delta < 0.15) { tone = 'flat'; verdict = '与历史基准持平（' + (delta >= 0 ? '+' : '') + (delta * 100).toFixed(0) + '%）'; }
  else if (delta < 1) { tone = 'bad'; verdict = '比历史基准差 ' + (delta * 100).toFixed(0) + '%'; }
  else if (delta < 3) { tone = 'bad'; verdict = '比历史基准差 ' + (delta * 100).toFixed(0) + '%'; }
  else { tone = 'bad'; verdict = '明显比历史基准差（是基准的 ' + (1 + delta).toFixed(1) + ' 倍）'; }

  return {
    level, text, tone, verdict, winNote, shortWindow,
    winDaily: Number(winDaily.toFixed(1)), winTotal, winDays,
    winHours: win.coveredHours, windowFrom: win.t0, windowTo: win.t1,
    median: med, p90: h.p90, ratio: Number(ratio.toFixed(2)),
    days: h.days, windowDays: winDays, byDay
  };
}

/* ---------- 时间段不良数量分布 + 有无突然上升（v6.4）----------
   用户需求（m14832）：「BE 段有一个时间段不良数量分布直方图，SMT 没有增加一下。
   方便看时间上是不是突然新增的，同时判定的时候也要增加一下，有无突然上升。」
   → SMT 这边补：按天、按小时的条数分布 + detectRise 的判定。
   数据来源只用 ctx.ng（已经取回来的不良明细），不额外查库，所以零成本。 */
function timeProfile(ctx) {
  const days = {};
  const hours = new Array(24).fill(0);
  const dayHour = {};   /* { 'YYYY-MM-DD': [24 个数] } 给热力条用 */
  for (const r of ctx.ng || []) {
    const d = DU.mesDayOf(r.time);
    const hh = DU.mesHourOf(r.time);
    if (d) {
      days[d] = (days[d] || 0) + 1;
      if (!dayHour[d]) dayHour[d] = new Array(24).fill(0);
    }
    if (hh >= 0 && hh < 24) {
      hours[hh] += 1;
      if (d) dayHour[d][hh] += 1;
    }
  }
  const dayKeys = Object.keys(days).sort();
  const byDay = dayKeys.map(d => ({ label: d, ng: days[d] }));
  /* 按天判定「有无突然上升」——只有一天时 detectRise 会自己返回 unknown 并说明原因 */
  const riseDay = BU.detectRise(byDay, { unit: '天' });
  /* 按小时判定：24 个桶，看是不是某个时段突然起来（前提是窗口够长、条数够多） */
  const byHour = hours.map((n, i) => ({ label: String(i).padStart(2, '0') + ':00', ng: n }));
  const hourTotal = hours.reduce((a, b) => a + b, 0);
  const hourBuckets = hours.filter(x => x > 0).length;
  /* 小时维度的「趋势」语义不同：24 个钟点按钟表顺序排，前 1/3 是凌晨、后 1/3 是傍晚，
     所以这里不乱套 detectRise 的趋势结论，只用它的尖峰/中位，另用 shiftFocus 看班次。 */
  const hourPeak = hourTotal > 0 ? hours.indexOf(Math.max.apply(null, hours)) : null;
  const shift = BU.shiftFocus(hours);
  return {
    byDay, byHour, dayHour, dayKeys,
    riseDay,
    hour: {
      total: hourTotal, buckets: hourBuckets, byHour,
      peakHour: hourPeak, peakNg: hourPeak == null ? 0 : hours[hourPeak],
      peakRatio: shift ? shift.peakRatio : null,
      shift: shift ? { topShift: shift.topShift, shiftShare: shift.shiftShare, shifts: shift.shifts } : null,
      /* 小时级判定的诚实措辞：只有一天数据时不能谈「时段规律」 */
      note: hourTotal < BU.MIN_NG
        ? `窗口内只有 ${hourTotal} 条不良，看不出集中在哪个时段。`
        : (dayKeys.length < 2
          ? '窗口只有 1 天，时段分布只能说明这一天内部的情况，不能当成规律。'
          : `峰值在 ${String(hourPeak).padStart(2, '0')}:00（${hours[hourPeak]} 条，是 24 小时平均的 ${shift && shift.peakRatio ? shift.peakRatio : '—'} 倍）。`)
    }
  };
}

/* ---------- 结论 ---------- */
const ACTIONS = {
  machine: '把可疑贴片机与同线其他机台对调生产比对；查该机台的吸嘴真空/贴装压力与校准记录',
  nozzle: '该吸嘴做真空/同心度点检，与同机其他吸嘴对调复测',
  feeder: '该飞达做送料精度点检（步距/料带张力），换飞达复测',
  table: '该料台/轨道做顶针与支撑块检查，核对顶针高度',
  pickPos: '核对该取料位的料带导向与吸嘴下降高度',
  seq: '该穴位做夹具/载具支撑检查；确认拼版排版方向与基准点',
  fixture: '量测可疑载具的定位销/支撑块磨损，换载具复测比对',
  stencil: '核对可疑钢网的开孔尺寸/张力/清洗记录，换钢网复测',
  steel: '核对可疑钢网的开孔设计、张力与清洗记录，换钢网复测',
  program: '对比可疑程序的贴装顺序/速度/吸嘴配置，与正常程序做 diff',
  line: '核对该线体的轨道宽度与接驳台水平度',
  model: '该产品本身的结构/来料差异，转产品工程确认',
  vendor: '该厂商来料做尺寸/共面度抽检，与另一厂商料做对比',
  matr: '该料号做来料检验（尺寸/共面度/镀层），锁定批号',
  lot: '该批号做来料抽检，同时段换另一批号比对',
  spi: '核对印刷/SPI 参数与锡膏批次，查 SPI 是否已提示同一位置'
};

function confound(top, ngDetail) {
  const notes = [];
  if (!top) return notes;
  const rows = (ngDetail || []).filter(r => String(r[top.key]) === String(top.item.value));
  const uniq = k => [...new Set(rows.map(r => r[k]).filter(Boolean))];
  if (top.key === 'nozzle' || top.key === 'feeder') {
    const ms = uniq('machine');
    if (ms.length === 1) {
      notes.push(`「${top.item.value}」在这批不良里只出现在 ${ms[0]} 上，与该机台无法区分——` +
        `要分开验证，得看它换到别的机台后的表现。`);
    }
    const sq = uniq('seq');
    if (sq.length <= 3 && top.dim.spread > 1) {
      notes.push(`「${top.item.value}」的不良集中在穴位 ${sq.join('、')}，` +
        `可能只是这几个穴位恰好用了它，不能直接判定是吸嘴/飞达本身的问题。`);
    }
  }
  if (top.key === 'seq') {
    const ms = uniq('machine');
    const noz = uniq('nozzle');
    if (ms.length === 1) notes.push(`该穴位在这批板里只由 ${ms[0]} 贴装，穴位与机台无法区分。`);
    if (noz.length === 1) notes.push(`该穴位的 ${rows.length} 条不良全部由吸嘴 ${noz[0]} 贴装，穴位与吸嘴无法区分。`);
    if (ms.length > 1) notes.push(`该穴位的 ${rows.length} 条不良分布在 ${ms.length} 台贴片机上 —— 不是单台机的问题，更像穴位/排版本身。`);
  }
  if (top.key === 'fixture' || top.key === 'line') {
    const ms = uniq('machine');
    if (ms.length === 1) notes.push(`该${top.label}这批不良都来自同一机台 ${ms[0]}，载具与机台无法区分。`);
  }
  return notes;
}

function analyze(ctx, opts) {
  opts = opts || {};
  const minNg = opts.minNg || MIN_NG;
  const liftSig = opts.liftSig || LIFT_SIG;

  const ngDetail = [];
  for (const r of ctx.ng) {
    const pl = (ctx.place[r.panel] || []).find(p => String(p.seq) === String(r.seq)) || {};
    ngDetail.push({
      panel: r.panel, seq: r.seq, time: r.time, issue: r.issue,
      nozzle: pl.nozzle, feeder: pl.feeder, table: pl.table, pickPos: pl.pickPos,
      machine: pl.machine, setup: pl.setup,
      matr: pl.matr || null, vendor: pl.vendor || null, lot: pl.lot || null,
      traced: !!pl.machine
    });
  }

  const nozMx = machineMatrix(ctx, 'nozzle', '吸嘴');
  const fdMx = machineMatrix(ctx, 'feeder', '飞达');

  const dims = [
    withinDim(ctx, 'machine', '贴片机台'),
    withinDim(ctx, 'nozzle', '吸嘴'),
    withinDim(ctx, 'feeder', '飞达'),
    withinDim(ctx, 'table', '料台/轨道'),
    withinDim(ctx, 'pickPos', '取料位 PickPos'),
    seqDim(ctx),
    panelDim(ctx, 'fixture', '载具（同工单基准）', b => b.fixture, 'fixture'),
    stencilDim(ctx),
    crossDim(ctx),
    panelDim(ctx, 'line', '线体', b => b.line, 'line'),
    panelDim(ctx, 'program', '贴片程序', b => b.program, 'program'),
    panelDim(ctx, 'spi', 'SPI 结果', b => b.spi, null)
  ];

  // 材料三兄弟：没有料号数据就整维标「不可用」
  const matDims = [
    withinDim(ctx, 'vendor', '材料厂商'),
    withinDim(ctx, 'matr', '材料料号'),
    withinDim(ctx, 'lot', '材料批号')
  ];
  for (const d of matDims) {
    if (d.exp === 0) { d.unavailable = '这批板的贴装记录里没有材料条码（TrackTrace 无对应行）'; }
    dims.push(d);
  }

  // 覆盖率
  const traced = ngDetail.filter(d => d.traced).length;
  const coverage = ngDetail.length ? traced / ngDetail.length : 0;

  // 显著性：先算维度内的 Bonferroni（pAdjDimension，仅诊断用）
  for (const d of dims) if (!d.unavailable) attachSignificance(d);
  /* ★ v6.1 Task4：再把「全部维度的全部候选」放进同一个 Holm 家族做全局校正。
     页面/报告/导出只看 pAdjGlobal；pAdjDimension 留作诊断。 */
  const correction = ADJ.applyGlobalCorrection(dims, {
    alpha: ALPHA, liftSig: liftSig, minNg,
    include: (d, it) => it.exp >= (d.kind === 'within' ? 5 : 10) && it.expShare > 0 && it.ng > 0
  });

  // 排名：只收「达到最小样本 + lift≥1.5 + 多重比较后仍显著」的取值
  const ranked = [];
  const weak = [];
  for (const d of dims) {
    if (d.unavailable) continue;
    for (const it of d.items) {
      if (it.ng < minNg || it.thin) continue;
      if (it.exp < (d.kind === 'within' ? 5 : 10)) continue;   // 暴露太少（如某载具只跑过 3 块板）不许上结论
      if (it.lift === null || it.lift < liftSig) continue;
      /* v6.1：入选只认 pAdjGlobal（it.sig 已由 applyGlobalCorrection 按全局口径重算） */
      const row = { key: d.key, label: d.label, kind: d.kind, item: it, dim: d };
      if (it.pAdjGlobal == null || it.pAdjGlobal >= ALPHA) { weak.push(row); continue; }
      if (it.sig) ranked.push(row); else weak.push(row);
    }
  }
  ranked.sort((a, b) => b.item.lift - a.item.lift || b.item.ng - a.item.ng);
  weak.sort((a, b) => b.item.lift - a.item.lift || b.item.ng - a.item.ng);

  /* 每个维度最多进 3 项：否则「载具」这种取值多的维度会把榜刷满，
     真正的穴位/吸嘴信号被挤到看不见。被截掉的只记数量，不丢数据（dims 里仍是全量）。 */
  const PER_DIM_CAP = 3;
  const capCount = {};
  const capped = [];
  for (const r of ranked) {
    capCount[r.key] = (capCount[r.key] || 0) + 1;
    if (capCount[r.key] > PER_DIM_CAP) { r.overflow = true; continue; }
    capped.push(r);
  }
  const overflow = {};
  for (const r of ranked) if (r.overflow) overflow[r.label] = (overflow[r.label] || 0) + 1;
  ranked.length = 0;
  Array.prototype.push.apply(ranked, capped);

  /* v6.3：被动共现分离。
     用户的原话场景：载具 90 号穴位有异物 → 穴位维度集中、同批材料也集中、
     贴 90 号穴位的吸嘴/轨道也跟着「显得集中」，但吸嘴/轨道本身没问题。
     判据是「剔掉 B 的命中点后 A 还集中吗」（passive.js），不猜因果。
     放在 PER_DIM_CAP 之后：只对真正会上榜的项做分离，否则白算。 */
  let passive = null;
  try {
    passive = PS.separate(ctx, ranked.map(r => ({
      key: r.key, value: r.item.value, lift: r.item.lift, ng: r.item.ng, exp: r.item.exp
    })));
    for (const r of ranked) {
      const hit = passive.clusters.find(c =>
        c.members.some(m => m.key === r.key && m.value === String(r.item.value)));
      if (!hit) continue;
      r.passive = hit.consumed
        ? { kind: 'passive', by: hit.by, liftClean: hit.liftClean, cov: hit.cov, lift: hit.lift }
        : {
            kind: hit.coupled ? 'coupled' : (hit.liftClean != null ? 'partial' : 'self'),
            by: hit.by, liftClean: hit.liftClean, cov: hit.cov, lift: hit.lift,
            coupledWith: hit.coupled
              ? hit.members.filter(m => !(m.key === r.key && String(m.value) === String(r.item.value)))
                  .map(m => ({ key: m.key, label: m.label, value: m.value }))
              : null
          };
    }
  } catch (e) {
    passive = { error: String((e && e.message) || e), clusters: [], note: null,
      counts: { signals: 0, clusters: 0, coupled: 0, survivors: 0, consumed: 0 } };
  }

  // 分散判定：所有维度都没有显著集中 → 分散本身是结论
  const scattered = ranked.length === 0;
  const top = ranked[0] || null;
  const confoundNotes = top ? confound(top, ngDetail) : [];

  const spreadNotes = [];
  if (scattered) {
    for (const d of dims) {
      if (d.unavailable) continue;
      if (d.kind === 'cross') {
        spreadNotes.push(`${d.label}：回看窗口（${d.window ? d.window.from + '~' + d.window.to : '近 N 天'}）内 ${d.ng} 条不良散在 ${d.spread} 个载具上 —— 没有哪个载具特别集中`);
      } else if (d.spread >= 3) {
        spreadNotes.push(`${d.label}：${d.ng} 条不良散在 ${d.spread} 个不同取值上`);
      }
    }
  }

  const approx = ADJ.approxNote(ctx, dims);
  const has8d = false;
  let headline;
  let level;
  const statNote = ranked.length || weak.length
    ? `（判据：二项上尾检验 + Holm 跨维度校正（全部维度的全部候选合成一个检验家族），α=0.05；样本少时"看着高"不等于显著）` : '';
  if (scattered) {
    level = 'scattered';
    /* v6.1：锁定文案。原来把分散写成「已排除机台/吸嘴/飞达/料台」——样本少、追溯覆盖低、
       维度不可用时这句话不成立，会被当成「已证明没问题」，所以整段换掉。 */
    /* 标题只讲「看到什么」，解释与「不等于排除」交给页面用 SCATTERED 正文展开，避免重复两遍 */
    headline = `${ADJ.SCATTERED.title}——${ctx.ng.length} 条不良散在 ` +
      `${dims.filter(d => d.kind === 'within' && !d.unavailable).length} 个贴片段维度上。`;
    if (weak.length) {
      headline += ` 另有 ${weak.length} 项「看着偏高但没通过显著性检验」（如 ${weak.slice(0, 3).map(w => w.label + ' ' + w.item.value).join('、')}），不能当结论。`;
    }
  } else {
    level = (top.item.lift >= 3 && top.item.ng >= 5) ? 'high' : 'mid';
    /* 说人话：把「暴露」讲成「在这批板的贴装机会里占多少」 */
    const unit = top.kind === 'within' ? '贴装机会' : '基准板';
    headline = `${level === 'high' ? '高度怀疑' : '中度怀疑'}「${top.label}：${top.item.value}」` +
      `（风险比 ${n1(top.item.lift)} — ${top.item.ng} 条不良里占 ${pct(top.item.share)}，` +
      `但它只占这批${unit}的 ${pct(top.item.expShare)}）`;
  }

  // 建议动作
  const suggestions = [];
  if (!scattered) {
    for (const r of ranked.slice(0, 3)) {
      const a = ACTIONS[r.key];
      if (a && !suggestions.some(s => s.act === a)) suggestions.push({ dim: r.label, value: r.item.value, act: a });
    }
  } else {
    suggestions.push({ dim: '印刷/来料/程序', value: '—',
      act: '贴片段已排除：查这 3 天的锡膏批次与钢网清洗记录、来料批号切换点，以及贴片程序是否改版' });
  }

  const matrices = {
    nozzle: { label: '吸嘴', machines: nozMx.machines, rows: nozMx.rows, crossable: nozMx.crossable,
      verdict: matrixVerdict(nozMx) },
    feeder: { label: '飞达', machines: fdMx.machines, rows: fdMx.rows, crossable: fdMx.crossable,
      verdict: matrixVerdict(fdMx) }
  };

  return {
    level, headline, statNote, ranked, weak, dims, matrices, overflow, confoundNotes, spreadNotes, suggestions,
    chronicity: chronicity(ctx),
    correction, approx, scattered: ADJ.SCATTERED,
    passive: passive && passive.note ? {
      note: passive.note, counts: passive.counts,
      root: passive.root ? { key: passive.root.rep.key, label: passive.root.rep.label,
        value: passive.root.rep.value, lift: passive.root.lift, ng: passive.root.ng } : null,
      consumed: passive.consumed.map(c => ({
        key: c.rep.key, label: c.rep.label, value: c.rep.value, lift: c.lift,
        by: c.by, liftClean: c.liftClean, cov: c.cov
      })),
      coupled: passive.clusters.filter(c => c.coupled).map(c => ({
        members: c.members.map(m => ({ key: m.key, label: m.label, value: m.value, lift: m.lift }))
      })),
      error: passive.error || null
    } : null,
    coverage, ngDetail,
    counts: { ng: ctx.ng.length, boards: Object.keys(ctx.place || {}).length,
      placements: dims.find(d => d.key === 'machine') ? dims.find(d => d.key === 'machine').exp : 0 },
    trend: trend(ctx),
    timeProfile: timeProfile(ctx)
  };
}

module.exports = { analyze, withinDim, panelDim, seqDim, trend, timeProfile, crossDim, machineMatrix, matrixVerdict, zTest, ACTIONS, pct, n1, MIN_NG, LIFT_SIG, chronicity, windowOf };
