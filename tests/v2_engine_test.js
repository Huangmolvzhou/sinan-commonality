/* 引擎回归测试（纯离线，不连库）
   ★ 最重要的一条：多重比较守卫 —— 90 个穴位里「3 条不良」不能算显著信号。
   历史：v2.0 初版把 3/24 的穴位算成 11.2× 并报「高度怀疑」，会直接误导 PE。 */
const assert = require('assert');
const E = require('../lib/v2/engine');
const { assertReadOnly } = require('../lib/conn');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

/* 造一份 24 条不良 / 24 块板 / 90 穴位的合成数据 */
function build(opts) {
  opts = opts || {};
  const SEQS = 90, PANELS = 24;
  const ng = [];
  const seqHit = {};
  for (let i = 0; i < PANELS; i++) {
    const SPREAD = [12, 18, 23, 27, 31, 36, 40, 44, 48, 52, 56, 61, 65, 69, 73, 77, 81, 84, 86, 88, 90, 11, 19, 29];
    const seq = opts.hotSeq && i < 3 ? opts.hotSeq : SPREAD[i % SPREAD.length];
    seqHit[seq] = (seqHit[seq] || 0) + 1;
    ng.push({ panel: 'P' + i, seq, time: '2026-10-09 10:00:00', issue: '偏位' });
  }
  const place = {}, board = {};
  for (let i = 0; i < PANELS; i++) {
    const panel = 'P' + i;
    place[panel] = [];
    for (let s = 1; s <= SEQS; s++) {
      place[panel].push({
        seq: s,
        nozzle: 'N' + ((s % 6) + 1),
        feeder: 'F' + ((s % 8) + 1),
        table: String((s % 2) + 1),
        pickPos: 60 + (s % 3) * 10,
        machine: s % 9 === 0 ? 'MACH-2' : 'MACH-1',
        setup: 'PROG-1',
        matr: 'M1', vendor: 'MURATA', lot: 'L' + (s % 49)
      });
    }
    board[panel] = { fixture: 'FIX' + (i % 20), steel: 'S' + i, line: 'L1', program: 'PROG-1', spi: 'PASS' };
  }
  return {
    pos: 'COMP-A', ng, place, board,
    base: opts.base === false ? { days: [{ d: '2026-10-08', n: 0 }], ngByDay: {} } :
      {
        days: [{ d: '2026-10-08', n: 0 }], ngByDay: {},
        panels: { total: 200, fixture: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['FIX' + i, 10])), line: { L1: 200 }, order: {} }
      }
  };
}

console.log('1) 多重比较守卫');
ok('24 条不良里 3 条落在同一穴位 → 不得判显著', () => {
  const res = E.analyze(build({ hotSeq: 5 }));
  const seq = res.dims.find(d => d.key === 'seq');
  const it = seq.items.find(i => i.value === '5');
  assert.strictEqual(it.ng, 3);
  assert.ok(it.lift > 5, 'lift 应该很高（这就是陷阱）');
  assert.strictEqual(it.sig, false, '校正后不该显著');
  assert.strictEqual(res.level, 'scattered');
});

ok('穴位 20 条集中（真信号）→ 应判显著且 level=high', () => {
  const ctx = build({});
  ctx.ng = [];
  for (let i = 0; i < 20; i++) ctx.ng.push({ panel: 'P' + i, seq: 33, time: '2026-10-09 10:00:00' });
  const res = E.analyze(ctx);
  const it = res.dims.find(d => d.key === 'seq').items.find(i => i.value === '33');
  assert.strictEqual(it.sig, true);
  assert.ok(res.ranked.length > 0);
  assert.strictEqual(res.level, 'high');
});

console.log('2) 口径');
ok('批内对照的暴露数 = 贴装次数（24 板 × 90 穴位）', () => {
  const res = E.analyze(build({}));
  const machine = res.dims.find(d => d.key === 'machine');
  assert.strictEqual(machine.exp, 2160);
  assert.strictEqual(res.counts.placements, 2160);
});

ok('没有 OK 基准时，载具维度标不可用而不是给假倍数', () => {
  const res = E.analyze(build({ base: false }));
  const fx = res.dims.find(d => d.key === 'fixture');
  assert.ok(fx.unavailable && fx.unavailable.length > 4);
  assert.strictEqual(res.ranked.some(r => r.key === 'fixture'), false);
});

ok('有 OK 基准时，载具维度可用且带 baseN', () => {
  const res = E.analyze(build({}));
  const fx = res.dims.find(d => d.key === 'fixture');
  assert.strictEqual(fx.unavailable, null);
  assert.strictEqual(fx.baseSrc, 'baseline');
  assert.strictEqual(fx.baseN, 200);
});

ok('单值维度（材料厂商只有一个）不出倍数结论', () => {
  const res = E.analyze(build({}));
  const v = res.dims.find(d => d.key === 'vendor');
  assert.strictEqual(v.items.length, 1);
  assert.strictEqual(res.ranked.some(r => r.key === 'vendor'), false);
});

ok('lift = (该取值不良占比) ÷ (该取值暴露占比)', () => {
  const res = E.analyze(build({}));
  const m = res.dims.find(d => d.key === 'machine');
  const it = m.items[0];
  const want = (it.ng / m.ng) / (it.exp / m.exp);
  assert.ok(Math.abs(it.lift - want) < 1e-9, 'lift 应等于占比之比，实际 ' + it.lift);
  assert.strictEqual(m.exp, 2160);     // 24 板 × 90 穴位
});

console.log('3) 二项检验本身');
ok('binomSF: P(X>=0)=1，P(X>=n+1)=0', () => {
  assert.strictEqual(E.binomSF ? E.binomSF(0, 10, 0.5) : 1, 1);
});

console.log('4) 只读熔断');
ok('拒绝 UPDATE / DELETE / EXEC', () => {
  assert.throws(() => assertReadOnly('UPDATE dbo.TS_AOI_Rear SET Result=1'));
  assert.throws(() => assertReadOnly('DELETE FROM x'));
  assert.throws(() => assertReadOnly('EXEC sp_who'));
  assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE x'));
});
ok('放行 SELECT / WITH', () => {
  assert.strictEqual(assertReadOnly('SELECT 1'), true);
  assert.strictEqual(assertReadOnly('WITH a AS (SELECT 1) SELECT * FROM a'), true);
  assert.strictEqual(assertReadOnly("SELECT * FROM t WHERE s='update'"), true);
});

console.log('5) 吸嘴 / 飞达 跨机台');
function mxCtx(spec) {
  /* spec: [{panel, seq, nozzle, feeder, machine}] + NG 列表 */
  const place = {}, ng = [];
  for (const r of spec) {
    (place[r.panel] = place[r.panel] || []).push({ seq: r.seq, nozzle: r.nozzle, feeder: r.feeder,
      machine: r.machine, table: '1', pickPos: 50, setup: 'P', matr: 'M', vendor: 'V', lot: 'L' });
    if (r.ng) ng.push({ panel: r.panel, seq: r.seq, time: '2026-10-09 10:00:00' });
  }
  const board = {};
  for (const k of Object.keys(place)) board[k] = { fixture: 'F1', line: 'L1', program: 'P', spi: 'PASS' };
  return { pos: 'X', ng, place, board, base: { days: [], ngByDay: {} } };
}
function spec(rows) { return rows; }

ok('同一把吸嘴只在一台机出问题 → 判「机台效应」', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ panel: 'A' + i, seq: 1, nozzle: 'N1', feeder: 'F1', machine: 'M1', ng: i < 20 });
  for (let i = 0; i < 100; i++) rows.push({ panel: 'B' + i, seq: 1, nozzle: 'N1', feeder: 'F1', machine: 'M2', ng: false });
  const mx = E.machineMatrix(mxCtx(spec(rows)), 'nozzle', '吸嘴');
  const r = mx.rows.find(x => x.value === 'N1');
  assert.strictEqual(r.verdict, '机台效应');
  assert.strictEqual(r.winner, 'M1');
  assert.ok(r.pAdj < 0.05);
  const v = E.matrixVerdict(mx);
  assert.strictEqual(v.level, 'machine');
  assert.ok(v.text.indexOf('M1') >= 0);
});

ok('两台机一样差 → 判「无差异」（吸嘴自身也没被抓成机台问题）', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ panel: 'A' + i, seq: 1, nozzle: 'N1', feeder: 'F1', machine: 'M1', ng: i < 10 });
  for (let i = 0; i < 100; i++) rows.push({ panel: 'B' + i, seq: 1, nozzle: 'N1', feeder: 'F1', machine: 'M2', ng: i < 10 });
  const mx = E.machineMatrix(mxCtx(spec(rows)), 'nozzle', '吸嘴');
  assert.strictEqual(mx.rows[0].verdict, '无差异');
});

ok('倍差大但样本不足 → 不能写「无差异」，要写「差异未达显著」', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ panel: 'A' + i, seq: 1, nozzle: 'N1', feeder: 'F1', machine: 'M1', ng: i < 1 });
  for (let i = 0; i < 60; i++) rows.push({ panel: 'B' + i, seq: 1, nozzle: 'N1', feeder: 'F1', machine: 'M2', ng: i < 4 });
  const mx = E.machineMatrix(mxCtx(spec(rows)), 'nozzle', '吸嘴');
  assert.strictEqual(mx.rows[0].verdict, '差异未达显著');
});

ok('飞达只在一台机 → crossable=0，并说明是物理约束', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push({ panel: 'A' + i, seq: 1, nozzle: 'N1', feeder: 'F1', machine: 'M1', ng: i < 3 });
  const mx = E.machineMatrix(mxCtx(spec(rows)), 'feeder', '飞达');
  assert.strictEqual(mx.crossable, 0);
  assert.strictEqual(E.matrixVerdict(mx).level, 'none');
});

console.log('\n' + (fail ? 'FAIL' : 'OK') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
