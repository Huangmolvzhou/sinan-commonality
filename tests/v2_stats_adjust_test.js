/* Task 4 回归测试：跨维度多重比较校正 + 「分散」措辞护栏
   ★ 背景：v6.0 的 Bonferroni 只作用在单个维度内部，一次分析同时检验 15 个 SMT 维度、
     整体假阳性率远高于 0.05；而且分散结论写「可以排除机台/吸嘴/飞达/料台」，样本少时这话不成立。
   本测试锁定：① 家族 = 全部维度的全部候选；② 全局校正值必 >= 维度内校正值；
              ③ ranked 只接受 pAdjGlobal < alpha；④ 分散文案不得出现「排除」。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/v2/stats_adjust');
const E = require('../lib/v2/engine');
const BE = require('../lib/v2/be_engine');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('\n【Task 4】跨维度校正');

/* ---------- Holm 本体 ---------- */
ok('Holm：空输入返回空 Map', () => {
  assert.strictEqual(A.holmAdjust([]).size, 0);
  assert.strictEqual(A.holmAdjust(null).size, 0);
});

ok('Holm：排序正确（最小 p 乘 m，依次递减因子）', () => {
  const m = A.holmAdjust([{ id: 'a', p: 0.001 }, { id: 'b', p: 0.02 }, { id: 'c', p: 0.5 }]);
  assert.ok(Math.abs(m.get('a') - 0.003) < 1e-12, 'a=' + m.get('a'));
  assert.ok(Math.abs(m.get('b') - 0.04) < 1e-12, 'b=' + m.get('b'));
  assert.strictEqual(m.get('c'), 0.5);
});

ok('Holm：单调不降（后面的项不会比前面便宜，允许持平）', () => {
  const m = A.holmAdjust([{ id: 'a', p: 0.01 }, { id: 'b', p: 0.011 }, { id: 'c', p: 0.9 }]);
  assert.ok(m.get('a') <= m.get('b'), 'a=' + m.get('a') + ' b=' + m.get('b'));
  assert.ok(m.get('b') <= m.get('c'));
});

ok('Holm：并列 p 值各得各的（都按各自的排名因子算）', () => {
  const m = A.holmAdjust([{ id: 'a', p: 0.02 }, { id: 'b', p: 0.02 }]);
  assert.ok(m.get('a') > 0 && m.get('b') > 0);
  assert.ok(Math.max(m.get('a'), m.get('b')) <= 0.04 + 1e-12);
});

ok('Holm：p>1 会被截断到 1', () => {
  const m = A.holmAdjust([{ id: 'a', p: 0.9 }, { id: 'b', p: 0.9 }, { id: 'c', p: 0.9 }]);
  assert.strictEqual(m.get('c'), 1);
  assert.ok(m.get('a') <= 1 && m.get('b') <= 1);
});

ok('Holm：忽略 p 为 null / NaN 的项', () => {
  const m = A.holmAdjust([{ id: 'a', p: null }, { id: 'b', p: NaN }, { id: 'c', p: 0.01 }]);
  assert.strictEqual(m.size, 1);
  assert.ok(m.has('c'));
});

ok('BH：空输入返回空 Map，且不超过 1', () => {
  assert.strictEqual(A.bhAdjust([]).size, 0);
  const m = A.bhAdjust([{ id: 'a', p: 0.001 }, { id: 'b', p: 0.5 }]);
  assert.ok(m.get('a') <= m.get('b') && m.get('b') <= 1);
});

/* ---------- 跨维度：家族 = 全部维度 ---------- */
function dimsOf() {
  return [
    { key: 'nozzle', label: '吸嘴', items: [
      /* 本维度只有 1 个候选：维度内 Bonferroni 因子=1 → pAdjDimension 就是 0.02 */
      { value: 'N1', p: 0.02, pAdj: 0.02, ng: 10, lift: 3, exp: 100 }
    ] },
    { key: 'feeder', label: '飞达', items: [
      { value: 'F1', p: 0.005, pAdj: 0.015, ng: 9, lift: 2.8, exp: 100 },
      { value: 'F2', p: 0.01, pAdj: 0.03, ng: 8, lift: 2.2, exp: 100 },
      { value: 'F3', p: 0.015, pAdj: 0.045, ng: 7, lift: 1.9, exp: 100 }
    ] },
    { key: 'blocked', label: '无数据维度', unavailable: '没有数据', items: [{ value: 'X', p: 0.001, lift: 9 }] }
  ];
}

ok('维度内显著的候选，跨维度校正后只会更严或持平（不会更松）', () => {
  const d = dimsOf();
  A.applyGlobalCorrection(d, { alpha: 0.05 });
  const noz = d[0].items[0];
  /* 吸嘴 N1：维度内 0.02（显著），进 4 个候选的家族后应被抬到 0.03 */
  assert.ok(Math.abs(noz.pAdjDimension - 0.02) < 1e-9, '维度内 ' + noz.pAdjDimension);
  assert.ok(Math.abs(noz.pAdjGlobal - 0.03) < 1e-9, '全局 ' + noz.pAdjGlobal);
  assert.ok(noz.pAdjGlobal > noz.pAdjDimension, '全局没有变严');
});

ok('全局家族覆盖两个维度的全部候选且排除不可用维度', () => {
  const d = dimsOf();
  const r = A.applyGlobalCorrection(d, { alpha: 0.05 });
  assert.strictEqual(r.family, 4, '实际 ' + r.family);
  assert.strictEqual(r.method, 'holm');
});

ok('pAdj 等于 pAdjGlobal（页面只认这一个）', () => {
  const d = dimsOf();
  A.applyGlobalCorrection(d, { alpha: 0.05 });
  for (const dim of d) for (const it of (dim.items || [])) {
    if (it.pAdjGlobal === null) continue;
    assert.strictEqual(it.pAdj, it.pAdjGlobal);
  }
});

ok('未纳入家族的项 pAdjGlobal 为 null 而不是 undefined', () => {
  const d = dimsOf();
  A.applyGlobalCorrection(d, { alpha: 0.05 });
  const blocked = d[2].items[0];
  assert.strictEqual(blocked.pAdjGlobal, null);
  assert.strictEqual(blocked.sigGlobal, false);
});

/* ---------- 引擎接线：ranked 只接受 pAdjGlobal < alpha ---------- */
function buildCtx() {
  const SEQS = 20, PANELS = 32;
  const ng = [], place = {}, board = {};
  for (let i = 0; i < PANELS; i++) {
    ng.push({ panel: 'P' + i, seq: 3, time: '2026-10-09 10:00:00', issue: '偏位' });
    place['P' + i] = [];
    for (let s = 1; s <= SEQS; s++) {
      place['P' + i].push({ seq: s, nozzle: 'N1', feeder: 'F' + ((s % 4) + 1),
        table: String((s % 2) + 1), pickPos: 60, machine: s % 9 === 0 ? 'MACH-2' : 'MACH-1',
        setup: 'PROG-1', matr: 'M' + ((s % 3) + 1), vendor: 'MURATA', lot: 'L' + ((s % 5) + 1) });
    }
    board['P' + i] = { fixture: 'FX' + ((i % 2) + 1), steel: 'ST1', order: 'O1', model: 'LINE-A', line: 'L1', program: 'PROG-1', spi: 'OK' };
  }
  return {
    pos: 'CL_X', ng, place, board,
    t0: '2026-10-09 00:00:00', t1: '2026-10-10 23:59:59',
    window: { coveredDays: 2, coveredHours: 48 },
    base: { days: [], ngByDay: {}, panels: 0, baseDays: 7, b0: '2026-10-02', b1: '2026-10-08', history: null }
  };
}

ok('ranked 里每一项都满足 pAdjGlobal < 0.05', () => {
  const res = E.analyze(buildCtx());
  assert.ok(Array.isArray(res.ranked));
  for (const r of res.ranked) {
    assert.ok(r.item.pAdjGlobal != null, r.label + '/' + r.item.value + ' 缺 pAdjGlobal');
    assert.ok(r.item.pAdjGlobal < 0.05, r.label + '/' + r.item.value + ' pAdjGlobal=' + r.item.pAdjGlobal);
  }
});

ok('ranked 里每一项的 pAdjGlobal 都 >= pAdjDimension', () => {
  const res = E.analyze(buildCtx());
  for (const r of res.ranked) {
    if (r.item.pAdjDimension == null) continue;
    assert.ok(r.item.pAdjGlobal >= r.item.pAdjDimension - 1e-12);
  }
});

ok('dim 里所有候选都有 pAdjDimension / pAdjGlobal 字段', () => {
  const res = E.analyze(buildCtx());
  for (const d of res.dims) {
    if (d.unavailable) continue;
    for (const it of d.items) {
      assert.ok('pAdjDimension' in it, d.key + '/' + it.value + ' 缺 pAdjDimension');
      assert.ok('pAdjGlobal' in it, d.key + '/' + it.value + ' 缺 pAdjGlobal');
    }
  }
});

ok('analyze 返回全局校正的 family 大小（用于方法说明）', () => {
  const res = E.analyze(buildCtx());
  assert.ok(res.correction && res.correction.family >= 1, '实际 ' + JSON.stringify(res.correction));
});

/* ---------- 分散文案 ---------- */
ok('分散标题 = 规格书锁定文案', () => {
  assert.strictEqual(A.SCATTERED.title, '本批未发现通过门槛的显著集中');
});

ok('分散正文包含「不等于已经排除」，不含「可以排除」', () => {
  assert.ok(/不等于已经排除/.test(A.SCATTERED.body));
  assert.ok(!/可以排除/.test(A.SCATTERED.body));
});

ok('引擎源码里不再出现「可以排除」', () => {
  for (const f of ['../lib/v2/engine.js', '../lib/v2/be_engine.js', '../public/index.html']) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const hit = /可以排除/.exec(s);
    assert.strictEqual(hit, null, f + ' 仍有「可以排除」');
  }
});

ok('分散结论走 SCATTERED 文案而不是自己拼', () => {
  const res = E.analyze(buildCtx());
  if (res.level !== 'scattered') return;   /* 这批数据可能被抓出集中，跳过 */
  assert.ok(res.headline.indexOf('不等于已经排除') >= 0 || res.headline === A.SCATTERED.title,
    '实际标题: ' + res.headline);
});

/* ---------- 近似 p 值提示 ---------- */
ok('单板 < 30 时给出近似 p 值提示', () => {
  const n = A.approxNote({ ng: [{ panel: 'A' }, { panel: 'B' }] }, []);
  assert.strictEqual(n.low, true);
  assert.ok(/近似值/.test(n.text), '实际: ' + n.text);
});

ok('单板足够、且每板不良 < 2 条时不提示', () => {
  const ng = [];
  for (let i = 0; i < 40; i++) ng.push({ panel: 'P' + i });
  const n = A.approxNote({ ng }, []);
  assert.strictEqual(n.low, false);
});

ok('每板不良 >= 2 条时提示「同一块板上的多个穴位可能相关」', () => {
  const ng = [];
  for (let i = 0; i < 40; i++) { ng.push({ panel: 'P' + i }); ng.push({ panel: 'P' + i }); ng.push({ panel: 'P' + i }); }
  const n = A.approxNote({ ng }, []);
  assert.strictEqual(n.low, true);
  assert.ok(/同一块板上的多个穴位可能相关/.test(n.text), '实际: ' + n.text);
});

ok('不可用维度会进提示（不能对没数据的维度下排除结论）', () => {
  const ng = [];
  for (let i = 0; i < 40; i++) ng.push({ panel: 'P' + i });
  const n = A.approxNote({ ng }, [{ key: 'matr', unavailable: '没有材料条码' }]);
  assert.ok(n.low === true || /没有数据|未覆盖/.test(n.text), '实际: ' + JSON.stringify(n));
});

/* ---------- SMT 与 BE 用同一个校正函数 ---------- */
ok('be_engine 也导出同一套校正（源码引用 stats_adjust）', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'v2', 'be_engine.js'), 'utf8');
  assert.ok(/stats_adjust/.test(s), 'be_engine 没有引用 stats_adjust');
});

ok('SMT 与 BE 的 alpha / lift 门槛一致', () => {
  assert.strictEqual(E.MIN_NG, BE.MIN_NG);
  assert.strictEqual(E.LIFT_SIG, BE.LIFT_SIG);
});

console.log('\n' + (fail ? 'FAIL' : 'OK') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
