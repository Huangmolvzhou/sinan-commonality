/* v6.2 回归测试：后段「首因 / 传导」判读
   ★ 用户的原话（m13582 / m13732）：
     「因为工序是有先后顺序的，所以可能存在置件问题，导致后续工站都出现高基准或共性，
       这种应该如何判读，是否是备注下首站共性，其他的可能属于被动有集中性。」
   本测试锁定四件事：
     ① 首因率的分母是「有首因记录的板」，不是「全部不良板」；
     ② 前站已 NG 的板数 = 块数（fcBoards - fcFirst），不是比例；
     ③ 首因率阈值三档：>=0.8 首因 / <=0.5 疑似传导 / 中间各半；样本 <5 不给判定；
     ④ 疑似传导的项必须被踢出 ranked（降级到 weak），不能当结论。 */
const assert = require('assert');
const BE = require('../lib/v2/be_engine');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

/* 造一批首因行：bar 板号 / rc 本站 ResCode / fp 首因工序（空=查不到更早 = 本站首因） */
function mkRows(spec) {
  const rows = [];
  let i = 0;
  Object.keys(spec).forEach(fp => {
    for (let k = 0; k < spec[fp]; k++) {
      /* ResCode 用能被 BEC.parse 解析的格式：机台 A1-LAB2 / 工位 0005 / 穴位 03（代号，不是真实产线） */
      rows.push({ bar: 'BAR' + (i++), rc: 'ZDA1LAB2VSWR0005-03R', fp: fp === 'self' ? 'VSWR' : fp });
    }
  });
  return rows;
}

function mkCtx(rows) {
  return { firstCause: rows, opt: { beProc: 'VSWR' } };
}

console.log('\n【v6.2 首因判读】');

/* ---------- 1. 全部首因 ---------- */
ok('全部是本站首因 → firstRate = 1，priorBoards = 0', () => {
  const fc = BE.firstCauseOf(mkCtx(mkRows({ self: 40 })));
  assert.strictEqual(fc.boards, 40);
  assert.strictEqual(fc.firstBoards, 40);
  assert.strictEqual(fc.priorBoards, 0);
  assert.strictEqual(fc.firstRate, 1);
});

ok('fp 为空串也当首因（往前 30 天查不到更早的 NG）', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ bar: 'B' + i, rc: 'ZDA1LAB2VSWR0005-03R', fp: '' });
  const fc = BE.firstCauseOf(mkCtx(rows));
  assert.strictEqual(fc.firstBoards, 10, '空 fp 应算首因');
  assert.strictEqual(fc.firstRate, 1);
});

/* ---------- 2. 混杂 ---------- */
ok('30 首因 + 10 前站 → firstRate 0.75、priorBoards 10', () => {
  const fc = BE.firstCauseOf(mkCtx(mkRows({ self: 30, ICT: 10 })));
  assert.strictEqual(fc.boards, 40);
  assert.strictEqual(fc.firstBoards, 30);
  assert.strictEqual(fc.priorBoards, 10);
  assert.strictEqual(fc.firstRate, 0.75);
  assert.strictEqual(fc.priorRate, 0.25);
});

ok('前站分布按块数降序，带中文工序名', () => {
  const fc = BE.firstCauseOf(mkCtx(mkRows({ self: 5, ICT: 3, VSWR: 0, LEAKAGE: 1 })));
  assert.strictEqual(fc.prior.length, 2, '只有 ICT 和 LEAKAGE');
  assert.strictEqual(fc.prior[0].proc, 'ICT');
  assert.strictEqual(fc.prior[0].n, 3);
  assert.ok(fc.prior[0].label && fc.prior[0].label !== 'ICT', '工序名要翻成中文：' + fc.prior[0].label);
});

/* ---------- 3. 空数据不崩 ---------- */
ok('没有首因数据 → 各计数为 0、firstRate 为 null（不是 NaN/Infinity）', () => {
  const fc = BE.firstCauseOf({ firstCause: [], opt: { beProc: 'AVI' } });
  assert.strictEqual(fc.boards, 0);
  assert.strictEqual(fc.firstRate, null);
  assert.ok(!isNaN(fc.boards));
});

/* ---------- 4. 贴到维度取值上 ---------- */
ok('attachFirstCause：fcPrior = 块数差，不是比例', () => {
  const fc = BE.firstCauseOf(mkCtx(mkRows({ self: 8, ICT: 2 })));
  const dim = { key: 'machine', items: [{ value: 'A1-LAB2' }] };
  BE.attachFirstCause(dim, fc);
  const it = dim.items[0];
  assert.strictEqual(it.fcBoards, 10);
  assert.strictEqual(it.fcFirst, 8);
  assert.strictEqual(it.fcPrior, 2, '前站块数应为 10-8=2');
  assert.strictEqual(it.firstRate, 0.8);
});

ok('attachFirstCause：没匹配到的取值不贴字段（不写 0，避免假装有数据）', () => {
  const fc = BE.firstCauseOf(mkCtx(mkRows({ self: 5 })));
  const dim = { key: 'holder', items: [{ value: '9999' }] };
  BE.attachFirstCause(dim, fc);
  assert.strictEqual(dim.items[0].firstRate, undefined);
});

/* ---------- 5. 判定三档 ---------- */
ok('首因率 80% 及以上 → 判定「首因」', () => {
  const vd = BE.verdictOf({ firstRate: 0.99, fcBoards: 100, fcPrior: 1 }, null);
  assert.strictEqual(vd.kind, 'first');
});

ok('首因率 50% 及以下 → 判定「疑似传导」，并点名前站', () => {
  const fc = { prior: [{ label: 'ICT 电测', n: 30 }] };
  const vd = BE.verdictOf({ firstRate: 0.2, fcBoards: 50, fcPrior: 40 }, fc);
  assert.strictEqual(vd.kind, 'carry');
  assert.ok(/ICT 电测/.test(vd.note), '要在文案里点名前站：' + vd.note);
  assert.ok(/先查前站/.test(vd.note), '要给出动作：' + vd.note);
});

ok('中间段（50%~80%）→ 判定「首因/传导各半」', () => {
  const vd = BE.verdictOf({ firstRate: 0.65, fcBoards: 50, fcPrior: 17 }, null);
  assert.strictEqual(vd.kind, 'mixed');
  assert.ok(/两条都要查/.test(vd.note));
});

ok('样本不足 5 块 → 不给判定（返回 null）', () => {
  assert.strictEqual(BE.verdictOf({ firstRate: 0.99, fcBoards: 4, fcPrior: 0 }, null), null);
});

ok('firstRate 是 null → 不给判定', () => {
  assert.strictEqual(BE.verdictOf({ firstRate: null, fcBoards: 100 }, null), null);
});

/* ---------- 6. 文案不许写死结论 ---------- */
ok('首因判定的文案说明「源头大概率在本工序」，不写「一定是」', () => {
  const vd = BE.verdictOf({ firstRate: 1, fcBoards: 100 }, null);
  assert.ok(/大概率/.test(vd.note), vd.note);
  assert.ok(!/一定|必然|确认是/.test(vd.note), '不能写死：' + vd.note);
});

console.log('\n' + (fail ? '✗ ' : 'OK ') + '通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
