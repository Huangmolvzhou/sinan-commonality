/* v6.3 被动共现分离（passive co-occurrence separation）
   ------------------------------------------------------------------
   用户提出的真实场景：
     载具的 90 号穴位有异物 → 90 号穴位的不良当然集中；
     但同一批材料、贴 90 号穴位的吸嘴、用到的轨道也会跟着「显得集中」。
     吸嘴/轨道本身没问题，是被载具（穴位）拖出来的。

   判据（不猜因果方向，只用数据做分离）：
     A 能不能被 B 解释 = 剔除 B 的全部命中点后，A 的风险比掉到 LIFT_SIG 以下，
     且 A 的不良里有足够比例同时落在 B 上（覆盖度）。
     反过来 B 能否被 A 解释，必须**不对称**才成立：
       · B 解释得掉 A、A 解释不掉 B → B 是真凶方向，A 是被动共现
       · 两边互相解释得掉（且覆盖度都高） → 这两项是「同一条线索的两个视角」
         （典型：某把飞达专门取某个批号的材料，8/69 完全重合），
         不能拆成根因+被动，要合并成一簇，一起查
   这一步只回答「能不能被解释」，不宣称因果。文案必须如实交代这个边界。

   两类分析单元：
     · 贴装级维度（吸嘴/飞达/料台/取料位/材料三兄弟/穴位/机台）—— 单元 = 一条贴装记录
     · 面板级维度（载具/钢网/线体/程序）—— 单元 = 一块板
   两类各自独立算，绝不混算（贴装级剔除会改变基准率，混算会得出假的下降）。 */

const LIFT_SIG = 1.5;
const COV_MERGE = 0.8;    // 双向覆盖都超过这个 → 同一簇
const COV_EXPLAIN = 0.5;  // 单向覆盖超过这个 → 才算「B 能解释 A」
/* 倍数差太多就不许并簇：穴位 139（233×）和贴片机台 MACH-3（1.9×）不良板确实完全重叠，
   但倍数差 100 倍，说「这是同一条线索」等于把可执行结论稀释掉。
   实测案例就是把这两项并成一簇后，用户看不出该先动哪个 —— 所以要求倍数同量级才并。 */
const MERGE_LIFT_RATIO = 3;

const PLACE_DIMS = new Set(['machine', 'nozzle', 'feeder', 'table', 'pickPos', 'seq', 'vendor', 'matr', 'lot']);
const PANEL_DIMS = new Set(['fixture', 'stencil', 'line', 'program']);

const NAMES = {
  machine: '贴片机台', nozzle: '吸嘴', feeder: '飞达', table: '料台/轨道',
  pickPos: '取料位', seq: '穴位', vendor: '材料厂商', matr: '材料料号', lot: '材料批号',
  fixture: '载具', stencil: '钢网', line: '线体', program: '贴片程序'
};
function dimName(key) { return NAMES[key] || key; }

function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

/* 统一单元表 */
function buildUnits(ctx) {
  const ngSet = new Set(ctx.ng.map(r => r.panel + '\u0001' + r.seq));
  const ngPanels = new Set(ctx.ng.map(r => r.panel));
  const board = ctx.board || {};
  const place = ctx.place || {};

  const placeUnits = [];
  for (const panel of Object.keys(place)) {
    const b = board[panel] || {};
    for (const p of place[panel]) {
      placeUnits.push({
        panel, seq: String(p.seq),
        ng: ngSet.has(panel + '\u0001' + p.seq) ? 1 : 0,
        vals: {
          machine: p.machine, nozzle: p.nozzle, feeder: p.feeder,
          table: p.table, pickPos: p.pickPos, seq: String(p.seq),
          vendor: p.vendor, matr: p.matr, lot: p.lot
        },
        fixture: b.fixture, stencil: b.stencil, line: b.line, program: b.program
      });
    }
  }
  const panelUnits = [];
  for (const panel of Object.keys(board)) {
    const b = board[panel] || {};
    panelUnits.push({
      panel, seq: null, ng: ngPanels.has(panel) ? 1 : 0,
      vals: { fixture: b.fixture, stencil: b.stencil, line: b.line, program: b.program }
    });
  }
  return { placeUnits, panelUnits };
}

function valOf(u, key) {
  if (PLACE_DIMS.has(key)) return u.vals[key];
  const d = u.vals[key];
  return d != null ? d : u[key];
}

function unitsFor(units, key) { return PLACE_DIMS.has(key) ? units.placeUnits : units.panelUnits; }

/* 某个 (key,value) 的暴露/不良，以及命中单元的 NG 位图 */
function profile(us, key, value) {
  const v = String(value);
  const hit = new Uint8Array(us.length);
  let exp = 0, ng = 0;
  for (let i = 0; i < us.length; i++) {
    const uv = valOf(us[i], key);
    if (isBlank(uv) || String(uv) !== v) continue;
    hit[i] = 1; exp++; ng += us[i].ng;
  }
  return { exp, ng, rate: exp ? ng / exp : 0, hit };
}

/* 剔除 B 的命中单元后，A 的（以及新的基准）风险比 */
function liftExcluding(us, hitA, hitB) {
  let exp = 0, ng = 0, allExp = 0, allNg = 0;
  for (let i = 0; i < us.length; i++) {
    if (hitB[i]) continue;
    allExp++; allNg += us[i].ng;
    if (hitA[i]) { exp++; ng += us[i].ng; }
  }
  const br = allExp ? allNg / allExp : 0;
  const rate = exp ? ng / exp : 0;
  return { exp, ng, rate, baseRate: br, lift: br > 0 ? rate / br : null };
}

/* 覆盖度：A 的不良里有多大比例同时命中了 B */
function coverage(hitA, hitB, us) {
  let ngA = 0, both = 0;
  for (let i = 0; i < us.length; i++) {
    if (!hitA[i] || !us[i].ng) continue;
    ngA++;
    if (hitB[i]) both++;
  }
  return ngA ? both / ngA : 0;
}

/* 主函数
   sigItems: [{key, value, lift, ng, exp}] —— 只传「进入显著榜」的项 */
function separate(ctx, sigItems) {
  const units = buildUnits(ctx);
  const list = (sigItems || []).filter(it => !isBlank(it.value) && unitsFor(units, it.key).length > 0);

  /* 1) 每项自己的画像（按单元级分组，贴装级与面板级各算各的） */
  const prof = list.map(it => {
    const us = unitsFor(units, it.key);
    const p = profile(us, it.key, it.value);
    const br = (() => { let e = 0, n = 0; for (const u of us) { e++; n += u.ng; } return e ? n / e : 0; })();
    return {
      key: it.key, label: dimName(it.key), value: String(it.value),
      lift: it.lift != null ? it.lift : (br > 0 ? p.rate / br : null),
      ng: p.ng, exp: p.exp, us, hit: p.hit
    };
  });

  /* 2) 两两关系（只在同一分析单元层级内比较） */
  const rel = new Map();   // "A|B" -> {liftClean, cov}
  for (const a of prof) {
    for (const b of prof) {
      if (a === b) continue;
      if (a.us !== b.us) continue;         // 贴装级 vs 面板级不混算
      if (a.key === b.key) continue;       // 同维度内不当解释（穴位 19 解释穴位 139 没意义）
      const ex = liftExcluding(a.us, a.hit, b.hit);
      rel.set(a.key + '=' + a.value + '||' + b.key + '=' + b.value, {
        liftClean: ex.lift, cleanNg: ex.ng, cleanExp: ex.exp,
        cov: coverage(a.hit, b.hit, a.us)
      });
    }
  }
  const getRel = (a, b) => rel.get(a.key + '=' + a.value + '||' + b.key + '=' + b.value) || null;

  /* 3) 判「同簇」：双向覆盖都高 → 同一条线索的两个视角，合并 */
  const clusterOf = new Map();  // index -> clusterId
  const clusters = [];
  for (let i = 0; i < prof.length; i++) {
    if (clusterOf.has(i)) continue;
    const members = [i];
    for (let j = i + 1; j < prof.length; j++) {
      if (clusterOf.has(j)) continue;
      const a = prof[i], b = prof[j];
      if (a.us !== b.us || a.key === b.key) continue;
      const r1 = getRel(a, b), r2 = getRel(b, a);
      if (!r1 || !r2) continue;
      /* 倍数必须同量级才并簇，否则「233× 的穴位」和「1.9× 的机台」会被说成同一条线索 */
      const hi = Math.max(a.lift || 0, b.lift || 0), lo = Math.min(a.lift || 0, b.lift || 0);
      if (lo > 0 && hi / lo > MERGE_LIFT_RATIO) continue;
      if (r1.cov >= COV_MERGE && r2.cov >= COV_MERGE) { members.push(j); clusterOf.set(j, clusters.length); }
    }
    clusterOf.set(i, clusters.length);
    clusters.push({ id: clusters.length, members });
  }

  /* 4) 簇内选代表（lift 最高），并判每个簇「是否被别人解释掉」 */
  const cls = clusters.map(c => {
    const ms = c.members.map(i => prof[i]);
    const rep = ms.slice().sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng)[0];
    return { id: c.id, members: ms, rep, lift: rep.lift, ng: rep.ng, exp: rep.exp,
      coupled: ms.length > 1, consumed: false, by: null, liftClean: null, cov: 0 };
  });

  for (const c of cls) {
    if (c.coupled) continue;              // 同簇本身就是一条线索，不参与互相解释
    let best = null;
    for (const o of cls) {
      if (o === c || o.coupled) continue;
      if (o.members[0].us !== c.rep.us) continue;
      if (o.rep.key === c.rep.key) continue;
      const r1 = getRel(c.rep, o.rep);      // 剔掉 o 后 c 还剩多少
      const r2 = getRel(o.rep, c.rep);      // 剔掉 c 后 o 还剩多少
      if (!r1 || !r2) continue;
      if (r1.cleanExp < 5) continue;
      if (r1.cov < COV_EXPLAIN) continue;                       // 覆盖不够不算「能解释」
      const oDies = r2.liftClean == null || r2.liftClean < LIFT_SIG;
      const cDies = r1.liftClean == null || r1.liftClean < LIFT_SIG;
      if (!cDies) continue;
      if (oDies) continue;                                      // 互相都解释得掉 → 留给同簇或都不判
      if (!best || r1.liftClean < best.r.liftClean) best = { o, r: r1 };
    }
    if (best) {
      c.consumed = true;
      c.by = { key: best.o.rep.key, label: best.o.rep.label, value: best.o.rep.value };
      c.liftClean = best.r.liftClean;
      c.cleanNg = best.r.cleanNg; c.cleanExp = best.r.cleanExp;
      c.cov = best.r.cov;
    }
  }

  /* 5) 剩下的簇 = 独立信号；其中 lift 最高的当「优先查」 */
  const survivors = cls.filter(c => !c.consumed)
    .sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.ng - a.ng);
  const consumed = cls.filter(c => c.consumed)
    .sort((a, b) => (a.liftClean || 0) - (b.liftClean || 0));
  const root = survivors[0] || null;

  const note = buildNote(root, survivors, consumed, cls);
  return {
    clusters: cls, root, survivors, consumed,
    explains: countExplains(consumed),
    note,
    counts: { signals: list.length, clusters: cls.length, coupled: cls.filter(c => c.coupled).length,
      survivors: survivors.length, consumed: consumed.length }
  };
}

function countExplains(consumed) {
  const m = new Map();
  for (const c of consumed) {
    if (!c.by) continue;
    const k = c.by.key + '=' + c.by.value;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function r1(x) { return x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1); }
function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }

function buildNote(root, survivors, consumed, cls) {
  const n = { title: '被动共现分离', head: '', body: [], caveat: '', idle: false };
  const coupled = cls.filter(c => c.coupled);

  if (!consumed.length && !coupled.length) {
    n.idle = true;
    n.head = '这批信号之间没有「谁拖累谁」的关系，各自独立。';
    n.caveat = '说明：每项剔掉其他项后风险比仍在 1.5× 以上，或者彼此不良板几乎不重叠。' +
      '这一步只回答「A 的集中能不能被 B 解释」，不是因果证明。';
    return n;
  }

  if (root) {
    n.head = `最该动手的是「${root.rep.label}：${root.rep.value}」（风险比 ${r1(root.lift)}×）`;
    const cnt = consumed.filter(c => c.by && c.by.key === root.rep.key && String(c.by.value) === root.rep.value).length;
    if (cnt) n.head += `——把它剔掉，另外 ${cnt} 项就不集中了`;
    n.head += '。';
  } else {
    n.head = '这批信号都被更靠前的项解释掉了，但也不能反过来说明前面的项清白。';
  }

  for (const c of consumed) {
    const mem = c.coupled ? c.members.map(m => m.label + '：' + m.value).join(' / ') : c.rep.label + '：' + c.rep.value;
    /* 「只剩 0.0×」读起来像 bug —— 一条不良都不剩时要直说 */
    const tail = (c.liftClean == null || c.liftClean === 0)
      ? '一条不良都不剩了'
      : `只剩 ${r1(c.liftClean)}×`;
    n.body.push(`「${mem}」风险比 ${r1(c.lift)}× → 剔掉「${c.by.label}：${c.by.value}」后${tail}，` +
      `且它的不良有 ${pct(c.cov)} 同时落在「${c.by.value}」上 —— 属于被动共现，不是它自己坏了。`);
  }

  for (const c of coupled) {
    if (c.consumed) continue;
    const mem = c.members.map(m => `${m.label}：${m.value}`).join(' / ');
    n.body.push(`「${mem}」这几项的不良板几乎完全重叠 —— 它们是同一条线索的不同视角（通常是同一次取料/同一套工装），` +
      `要一起查、不要当成几个独立问题。`);
  }

  const partials = survivors.filter(c => c.liftClean != null);
  if (partials.length) {
    n.body.push('另有 ' + partials.length + ' 项剔掉别人后仍然偏高，属于「自己也有问题」，不能全推给前站。');
  }

  n.caveat = '这一步只回答「A 的集中能不能被 B 解释」，不是因果证明。「谁先坏」要靠换件复测确认：' +
    '把被怀疑的载具/穴位/吸嘴换掉，再用同一窗口跑一次，信号消失才算坐实。';
  return n;
}

module.exports = {
  separate, buildUnits, profile, liftExcluding, coverage, dimName,
  PLACE_DIMS, PANEL_DIMS, LIFT_SIG, COV_MERGE, COV_EXPLAIN, MERGE_LIFT_RATIO
};
