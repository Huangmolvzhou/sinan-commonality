/* v6.1 Task 4：跨维度的多重比较校正（Holm）+ 「分散」措辞护栏
   为什么要这一层：
     v6.0 的 Bonferroni 只在「每个维度内部」做（attachSignificance 里乘 d.tested）。
     但一次分析会同时检验 15 个 SMT 维度、6 个 BE 维度，每个维度又各有一堆取值
     —— 整体假阳性率远高于 0.05。同一条不良被 15 个维度反复"考"一遍，
     总有一次碰巧显著。所以校正家族必须是「全部候选值」，不是「一个维度的候选值」。

   两个层级的 p 值都保留：
     pAdjDimension —— 只在本维度内校正（v6.0 的老口径，留作诊断）
     pAdjGlobal    —— 在整个家族里用 Holm 校正（页面/报告/导出只用这个）
     两者必然满足 pAdjGlobal >= pAdjDimension：家族越大，门槛越严。

   ⚠ 这是近似：同一块板上的多个穴位、同一载具、同一机台共享工艺与物料，
     不是独立试验。第一阶段只把 p 当成"提示强度"，不当因果证据；
     板级重采样（Task 8）之后才有资格收紧措辞。
*/
'use strict';

/** Holm step-down（控制 family-wise error rate） */
function holmAdjust(tests) {
  const out = new Map();
  const list = (tests || [])
    .filter(t => t && t.p != null && isFinite(t.p))
    .map(t => ({ id: t.id, p: Math.max(0, Number(t.p)) }))
    .sort((a, b) => a.p - b.p || String(a.id).localeCompare(String(b.id)));
  const m = list.length;
  if (!m) return out;
  let running = 0;
  for (let i = 0; i < m; i++) {
    const factor = m - i;
    const adj = Math.min(1, list[i].p * factor);
    /* 单调化：Holm 的校正值必须随原始 p 递增，否则排序靠后的项会"变便宜" */
    running = Math.max(running, adj);
    out.set(list[i].id, Math.min(1, running));
  }
  return out;
}

/** Benjamini–Hochberg（FDR），只用于对照展示，不作为入选判据 */
function bhAdjust(tests) {
  const out = new Map();
  const list = (tests || [])
    .filter(t => t && t.p != null && isFinite(t.p))
    .map(t => ({ id: t.id, p: Math.max(0, Number(t.p)) }))
    .sort((a, b) => a.p - b.p || String(a.id).localeCompare(String(b.id)));
  const m = list.length;
  if (!m) return out;
  let running = 1;
  const res = new Array(m);
  for (let i = m - 1; i >= 0; i--) {
    const adj = Math.min(1, list[i].p * m / (i + 1));
    running = Math.min(running, adj);
    res[i] = Math.min(1, running);
  }
  for (let i = 0; i < m; i++) out.set(list[i].id, res[i]);
  return out;
}

/**
 * 给 SMT / BE 的维度统一挂上全局校正结果。
 * @param {Array|Object} dims 引擎产出的维度集合（数组或以数字为键的对象）
 * @param {Object} options {alpha, liftSig, minNg, include(dim,item), method}
 */
function applyGlobalCorrection(dims, options) {
  const o = options || {};
  const alpha = o.alpha != null ? o.alpha : 0.05;
  const liftSig = o.liftSig != null ? o.liftSig : 1.5;
  const minNg = o.minNg != null ? o.minNg : 3;
  const include = o.include || (() => true);
  const arr = Array.isArray(dims) ? dims : Object.keys(dims || {}).map(k => dims[k]);
  const usable = arr.filter(d => d && !d.unavailable);

  /* 1) 先把维度内的校正值另存为诊断字段，再把整个家族收齐 */
  const family = [];
  for (const d of usable) {
    for (const it of (d.items || [])) {
      if (it.pAdjDimension === undefined) it.pAdjDimension = it.pAdj == null ? null : it.pAdj;
      if (it.p == null || !isFinite(it.p)) continue;
      if (!include(d, it)) continue;
      family.push({ id: d.key + '|' + it.value, p: it.p, dim: d, it });
    }
  }

  /* 2) 一个家族、一次校正 */
  const holm = holmAdjust(family.map(t => ({ id: t.id, p: t.p })));
  const bh = o.withBh === false ? new Map() : bhAdjust(family.map(t => ({ id: t.id, p: t.p })));
  for (const t of family) {
    const g = holm.get(t.id);
    t.it.pAdjGlobal = g == null ? null : g;
    t.it.pAdjBH = bh.get(t.id) == null ? null : bh.get(t.id);
    t.it.pAdj = t.it.pAdjGlobal;                  /* 页面/报告只看这个 */
    t.it.sigGlobal = t.it.pAdjGlobal != null && t.it.pAdjGlobal < alpha;
    t.it.sig = t.it.sigGlobal
      && (t.it.lift == null || t.it.lift >= liftSig)
      && (t.it.ng == null || t.it.ng >= minNg);
  }

  /* 3) 没进家族的项也要有字段，避免前端拿到 undefined
        （不可用维度的项同样要显式置 null——否则页面 `pAdjGlobal < 0.05` 会落进 undefined 分支） */
  for (const d of arr) {
    if (!d) continue;
    for (const it of (d.items || [])) {
      if (it.pAdjGlobal === undefined) { it.pAdjGlobal = null; it.sigGlobal = false; it.sig = false; }
    }
  }
  for (const d of usable) {
    for (const it of (d.items || [])) {
      if (it.pAdjGlobal === undefined) { it.pAdjGlobal = null; it.sigGlobal = false; }
      if (it.pAdjDimension === undefined) it.pAdjDimension = it.pAdj == null ? null : it.pAdj;
      if (it.sig === undefined) it.sig = false;
    }
  }

  return { method: 'holm', alpha, family: family.length, dims: usable.length };
}

/** 近似 p 值提示：单板太少，或同一块板上不良行数明显多于板数 → p 只能当提示 */
function approxNote(ctx, dims) {
  const ng = (ctx && ctx.ng) || [];
  const boards = new Set(ng.map(r => r.panel).filter(Boolean)).size;
  const rows = ng.length;
  const perBoard = boards ? rows / boards : 0;
  const arr = Array.isArray(dims) ? dims : Object.keys(dims || {}).map(k => dims[k]);
  const covNote = arr.some(d => d && d.unavailable) ? '另有维度没有数据（已在页面上标注不可用），这些维度不能下「排除」结论' : '';
  if (!boards) return { low: true, text: '这批数据里没有可用的单板号，p 值只作提示，不能作为因果证据。' };
  if (boards < 30) {
    return { low: true, text: '本批只有 ' + boards + ' 块单板参与检验（<30 块），同一块板上的多个穴位可能相关，p 值为近似值，请勿当作严格因果证据。' + (covNote ? ' ' + covNote + '。' : '') };
  }
  if (perBoard >= 2) {
    return { low: true, text: '本批 ' + boards + ' 块板共 ' + rows + ' 条不良（平均每板 ' + perBoard.toFixed(1) + ' 条），同一块板上的多个穴位可能相关，p 值为近似值。' + (covNote ? ' ' + covNote + '。' : '') };
  }
  return { low: false, text: covNote ? '注意：' + covNote + '。' : '' };
}

/* 「分散」结论的锁定文案（规格书第 5 节 Task 4 原文，禁止改写为「可以排除」） */
const SCATTERED = {
  title: '本批未发现通过门槛的显著集中',
  body: '这表示当前样本中暂不优先锁定已分析维度，不等于已经排除。请结合分析条数、抽样比例、'
    + '追溯覆盖率和未覆盖维度判断；如需下排查结论，建议扩大时间窗或补做现场验证。',
  action: '先核验未覆盖维度与样本充足性，再决定是否转向印刷、来料、程序或现场拆解。'
};

module.exports = { holmAdjust, bhAdjust, applyGlobalCorrection, approxNote, SCATTERED };
