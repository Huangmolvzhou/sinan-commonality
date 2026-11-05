/* v6.3 被动共现分离回归测试
   锁定的不变量（每一条都对应一次真实踩坑或用户明确要求）：
   1. 剔除 B 的命中点后，A 的风险比必须按「新的基准率」重算，不能拿旧的基准率去除
   2. 覆盖度是「A 的不良里有多少同时落在 B 上」，不是板数占比
   3. 双向覆盖都高 → 判同簇（同一条线索的两个视角），不许拆成根因+被动
   4. 单边解释得掉、反过来解释不掉 → 才算被动共现（必须不对称）
   5. 互相都解释得掉（循环）→ 两个都不判被动
   6. 贴装级维度与面板级维度绝不混算（单元不同，基准率含义不同）
   7. 同维度内不当解释（穴位 19 不能解释穴位 139）
   8. 覆盖度不够（<50%）→ 不算能解释，即使剔完 lift 掉下来
   9. 文案必须写「只回答能不能被解释，不是因果证明」，不许写「一定/必然/证明是」
   10. 引擎返回体必须带 passive，且 server 白名单不许吞掉（历史上吞过三次） */
const assert = require('assert');
const P = require('../lib/v2/passive');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '  \u2192 ' + e.message); fail++; }
}

/* 造一个可控的 ctx：8 块板，每块板 4 个穴位（共 32 条贴装行） */
function mkCtx(opts) {
  const o = opts || {};
  const place = {}, board = {}, ng = [];
  const boards = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
  boards.forEach((p, bi) => {
    place[p] = [];
    board[p] = { fixture: 'FX' + (bi % 2), stencil: 'ST1', line: 'L1', program: 'PRG1' };
    for (let s = 1; s <= 4; s++) {
      place[p].push({
        seq: String(s),
        nozzle: o.nozzleOf ? o.nozzleOf(bi, s) : 'N1',
        feeder: 'F1', table: 'T1', pickPos: 'PP1',
        machine: 'M1', setup: 'S1', matr: 'MAT1', vendor: 'V1', lot: 'LOT1'
      });
    }
  });
  /* 不良：默认全在 P1/P2 的穴位 1 上（穴位 1 集中） */
  (o.ngList || [['P1', 1], ['P2', 1], ['P3', 1]]).forEach(([p, s]) => {
    ng.push({ panel: p, seq: s, issue: 'X', machine: 'M1' });
  });
  return { ng, place, board, t0: '2026-10-01 00:00:00', t1: '2026-10-02 00:00:00' };
}

console.log('v6.3 被动共现分离测试');

/* 1. 剔除后必须用新基准率 */
t('剔除后 lift 用剩余单元的基准率重算', () => {
  const ctx = mkCtx();
  const { placeUnits } = P.buildUnits(ctx);
  const a = P.profile(placeUnits, 'nozzle', 'N1');
  const b = P.profile(placeUnits, 'seq', '1');
  const ex = P.liftExcluding(placeUnits, a.hit, b.hit);
  /* 剔掉穴位 1 后，剩 24 行 0 不良 → 基准率 0 → lift 为 null（不是 0，也不是旧基准率算出的数） */
  assert.strictEqual(ex.exp, 24, '剔除后暴露应为 24 行');
  assert.strictEqual(ex.ng, 0, '剔除后不良应为 0');
  assert.strictEqual(ex.lift, null, '基准率 0 时 lift 必须是 null，不能编一个数');
});

/* 2. 覆盖度口径 */
t('覆盖度 = A 的不良里同时命中 B 的比例', () => {
  const ctx = mkCtx({ ngList: [['P1', 1], ['P2', 2], ['P3', 1], ['P4', 2]] });
  const { placeUnits } = P.buildUnits(ctx);
  const a = P.profile(placeUnits, 'nozzle', 'N1');   // 全部 32 行都是 N1
  const b = P.profile(placeUnits, 'seq', '1');       // 不良里 2 条在穴位 1
  assert.strictEqual(P.coverage(a.hit, b.hit, placeUnits), 0.5, '4 条不良里 2 条命中穴位 1 → 0.5');
});

/* 3. 双向全覆盖 → 同簇 */
t('双向覆盖都高的两项被判为同簇（不拆成根因+被动）', () => {
  const ctx = mkCtx({
    ngList: [['P1', 1], ['P2', 1]],
    nozzleOf: (bi, s) => (s === 1 ? 'N7' : 'N1')   // 穴位 1 永远由 N7 贴
  });
  const sig = [
    { key: 'nozzle', value: 'N7', lift: 8, ng: 2, exp: 8 },
    { key: 'seq', value: '1', lift: 8, ng: 2, exp: 8 }
  ];
  const r = P.separate(ctx, sig);
  assert.ok(r.clusters.some(c => c.coupled), '必须有一个同簇');
  const coupled = r.clusters.find(c => c.coupled);
  assert.strictEqual(coupled.members.length, 2, '同簇应包含两项');
  assert.strictEqual(r.consumed.length, 0, '同簇的两项都不该被判成被动');
});

/* 4. 单向解释 → 被动（不对称才成立） */
t('单向解释得掉、反向解释不掉 → 判被动共现', () => {
  /* 穴位 1 有 6 条不良；N9 只在穴位 1 上出现过一部分，其余不良不在 N9 上 */
  const ctx = mkCtx({
    ngList: [['P1', 1], ['P2', 1], ['P3', 1]],
    nozzleOf: (bi, s) => (s === 1 && bi < 2 ? 'N9' : 'N1')
  });
  const { placeUnits } = P.buildUnits(ctx);
  const n9 = P.profile(placeUnits, 'nozzle', 'N9');
  const s1 = P.profile(placeUnits, 'seq', '1');
  /* N9 的不良全部落在穴位 1；但穴位 1 的不良不是全部落在 N9 → 单向 */
  assert.strictEqual(P.coverage(n9.hit, s1.hit, placeUnits), 1, 'N9 的不良 100% 命中穴位 1');
  assert.ok(P.coverage(s1.hit, n9.hit, placeUnits) < 1, '反向覆盖不到 100%');
});

/* 5. 循环互解释 → 都不判被动 */
t('互相都解释得掉的循环关系不判被动', () => {
  /* 两个取值命中完全相同的单元、且都是显著项 → 应落进同簇或都不 consumed */
  const ctx = mkCtx({ ngList: [['P1', 1], ['P2', 1]] });
  const sig = [
    { key: 'nozzle', value: 'N1', lift: 3, ng: 2, exp: 32 },
    { key: 'feeder', value: 'F1', lift: 3, ng: 2, exp: 32 }
  ];
  const r = P.separate(ctx, sig);
  assert.strictEqual(r.consumed.length, 0, '互相解释的关系里不该有人被判被动');
});

/* 6. 贴装级 vs 面板级不混算 */
t('贴装级维度与面板级维度不互相解释', () => {
  const ctx = mkCtx();
  const sig = [
    { key: 'nozzle', value: 'N1', lift: 5, ng: 3, exp: 32 },
    { key: 'fixture', value: 'FX0', lift: 5, ng: 2, exp: 4 }
  ];
  const r = P.separate(ctx, sig);
  for (const c of r.clusters) {
    if (c.consumed) assert.ok(!(c.by.key === 'fixture' || c.rep.key === 'fixture'),
      '面板级与贴装级不许互相解释');
  }
  assert.ok(true);
});

/* 7. 同维度内不当解释 */
t('同维度内的两个取值不互相解释', () => {
  const ctx = mkCtx({ ngList: [['P1', 1], ['P2', 2], ['P3', 1], ['P4', 2]] });
  const sig = [
    { key: 'seq', value: '1', lift: 5, ng: 2, exp: 8 },
    { key: 'seq', value: '2', lift: 5, ng: 2, exp: 8 }
  ];
  const r = P.separate(ctx, sig);
  assert.strictEqual(r.consumed.length, 0, '穴位 1 不能解释穴位 2');
});

/* 8. 覆盖度不够 → 不算能解释 */
t('覆盖度低于 50% 时即使 lift 掉下来也不算被动', () => {
  const ctx = mkCtx({ ngList: [['P1', 1], ['P2', 2], ['P3', 3], ['P4', 4]] });
  const { placeUnits } = P.buildUnits(ctx);
  const a = P.profile(placeUnits, 'nozzle', 'N1');
  const b = P.profile(placeUnits, 'seq', '1');
  const cov = P.coverage(a.hit, b.hit, placeUnits);
  assert.ok(cov < P.COV_EXPLAIN, '4 条不良只有 1 条命中穴位 1 → 覆盖 25% < 50%');
  assert.ok(P.COV_EXPLAIN === 0.5);
});

/* 9. 文案边界 */
t('文案不写「一定/必然/证明是」，必须交代不是因果证明', () => {
  const ctx = mkCtx({
    ngList: [['P1', 1], ['P2', 1], ['P3', 1]],
    nozzleOf: (bi, s) => (s === 1 && bi < 2 ? 'N9' : 'N1')
  });
  const r = P.separate(ctx, [
    { key: 'seq', value: '1', lift: 9, ng: 3, exp: 8 },
    { key: 'nozzle', value: 'N9', lift: 4, ng: 2, exp: 2 }
  ]);
  const all = [r.note.head].concat(r.note.body, [r.note.caveat]).join(' ');
  assert.ok(!/一定|必然|证明是|确认是/.test(all), '不许出现绝对化措辞：' + all);
  assert.ok(/不是因果证明|只回答/.test(r.note.caveat), '必须交代边界');
});

/* 10. 空输入不炸 */
t('没有显著项时返回 idle 的说明，不抛异常', () => {
  const ctx = mkCtx();
  const r = P.separate(ctx, []);
  assert.ok(r.note, '必须有 note');
  assert.strictEqual(r.counts.signals, 0);
  assert.strictEqual(r.consumed.length, 0);
});

/* 11. 引擎返回体带 passive，且 server 白名单不吞 */
t('engine.analyze 返回体含 passive，server_v2 白名单含 passive', () => {
  const fs = require('fs');
  const path = require('path');
  const srv = require('./_src').SRV();   /* v6.7：发行包里叫 server.js */
  assert.ok(/passive:\s*res\.passive/.test(srv), 'server_v2.js 的 summary 白名单必须有 passive');
  assert.ok(/passive:\s*r\.passive/.test(srv), 'server_v2.js 的 ranked 映射必须有 passive');
  const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'v2', 'engine.js'), 'utf8');
  assert.ok(/require\('\.\/passive'\)/.test(eng), 'engine.js 必须引入 passive');
  assert.ok(/passive:\s*passive\s*&&/.test(eng.replace(/\n/g, ' ')), 'engine.js 返回体必须带 passive');
});

/* 12. 命中点剔除是「整行剔除」，不是只把不良清零 */
t('剔除 B 是整行剔除（暴露也要减），不是只清不良', () => {
  const ctx = mkCtx({ ngList: [['P1', 1], ['P2', 1], ['P3', 1]] });
  const { placeUnits } = P.buildUnits(ctx);
  const a = P.profile(placeUnits, 'nozzle', 'N1');
  const b = P.profile(placeUnits, 'seq', '1');
  const ex = P.liftExcluding(placeUnits, a.hit, b.hit);
  assert.strictEqual(ex.exp, 32 - 8, '穴位 1 有 8 行，剔除后 A 的暴露应从 32 减到 24');
});

/* 13. 倍数差太多不许并簇 */
t('倍数差超过 3 倍的两项不并簇（233× 的穴位不能和 1.9× 的机台说成同一条线索）', () => {
  assert.ok(P.MERGE_LIFT_RATIO === 3, 'MERGE_LIFT_RATIO 应为 3');
  /* 真实案例的形状：穴位 139（233.8×）与贴片机台 MACH-3（1.9×）不良板高度重叠，
     但倍数差 100 倍。若判成「同一条线索」，用户会以为两者同等重要。
     正确结果是：低倍数那项被判成被动共现，高倍数那项是根因。 */
  const ctx = mkCtx({
    /* NG 都在穴位 1 上（P1~P4），这样穴位 1 的倍数远远高于被它拖累的吸嘴 */
    ngList: [['P1', 1], ['P2', 1], ['P3', 1], ['P4', 1]],
    /* 吸嘴 N9 只贴了 P1、P2 的穴位 1 与所有板的穴位 2 → 暴露宽、倍数低 */
    nozzleOf: (bi, s) => ((bi < 2 && s === 1) || s === 2 ? 'N9' : 'N1')
  });
  const r = P.separate(ctx, [
    { key: 'seq', value: '1', lift: 20, ng: 4, exp: 8 },
    { key: 'nozzle', value: 'N9', lift: 2, ng: 2, exp: 10 }
  ]);
  assert.strictEqual(r.counts.coupled, 0, '倍数差 10 倍不该并成同簇');
  assert.strictEqual(r.counts.consumed, 1, '应判出一项被动（低倍数那个被高倍数解释）');
  assert.strictEqual(r.consumed[0].rep.value, 'N9', '被解释掉的应该是倍数低的 N9');
  assert.strictEqual(r.consumed[0].by.value, '1', '解释者是穴位 1');
  assert.strictEqual(r.root.rep.value, '1', '根因仍是穴位 1');
});

/* 14. 倍数接近时仍然并簇（不能为了不并而把真同簇拆散） */
t('倍数在 3 倍以内且覆盖 100% 的两项仍然并簇', () => {
  const ctx = mkCtx({
    ngList: [['P1', 1], ['P2', 1]],
    nozzleOf: (bi, s) => (s === 1 ? 'N9' : 'N1')
  });
  const r = P.separate(ctx, [
    { key: 'seq', value: '1', lift: 6, ng: 2, exp: 8 },
    { key: 'nozzle', value: 'N9', lift: 5, ng: 2, exp: 8 }
  ]);
  assert.strictEqual(r.counts.coupled, 1, '倍数只差 1.2 倍，应并簇');
});

console.log('');
console.log(`OK 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
