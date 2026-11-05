/* Task 1 回归测试：日期时区与窗口计算（纯离线）
   ★ 背景：v6.0 用 `new Date('YYYY-MM-DDT00:00:00').toISOString().slice(0,10)` 取日期，
     在 Asia/Shanghai(GMT+8) 下会回退到前一天（本地 00:00 = UTC 前一天 16:00）。
     实测：分析开始 2026-10-09 基准 7 天 → 输出 b0=2026-10-01（应为 10-02）。
   本测试必须在 TZ=Asia/Shanghai 与 TZ=UTC 下都通过。 */
const assert = require('assert');
const D = require('../lib/v2/date_utils');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('\n【Task 1】日期时区与窗口');

/* ---------- addDays ---------- */
ok('addDays: 基准 7 天回退（v6.0 在此回退成 10-01）', () => {
  assert.strictEqual(D.addDays('2026-10-09', -7), '2026-10-02');
});

ok('addDays: 历史 30 天回退（v6.0 在此回退成 09-09）', () => {
  assert.strictEqual(D.addDays('2026-10-10', -30), '2026-09-10');
});

ok('addDays: 载具回看 14 天（v6.0 在此回退成 09-25）', () => {
  assert.strictEqual(D.addDays('2026-10-10', -14), '2026-09-26');
});

ok('addDays: 跨年 2026-12-31 +1 = 2027-01-01', () => {
  assert.strictEqual(D.addDays('2026-12-31', 1), '2027-01-01');
});

ok('addDays: 跨年 2027-01-01 -1 = 2026-12-31', () => {
  assert.strictEqual(D.addDays('2027-01-01', -1), '2026-12-31');
});

ok('addDays: 闰年 2028-02-28 +1 = 2028-02-29', () => {
  assert.strictEqual(D.addDays('2028-02-28', 1), '2028-02-29');
});

ok('addDays: 平年 2027-02-28 +1 = 2027-03-01', () => {
  assert.strictEqual(D.addDays('2027-02-28', 1), '2027-03-01');
});

ok('addDays: days=0 原样返回', () => {
  assert.strictEqual(D.addDays('2026-10-09', 0), '2026-10-09');
});

ok('addDays: 非法日期直接报错，不自动纠偏', () => {
  assert.throws(() => D.addDays('2026-13-01', 1), /日期/);
  assert.throws(() => D.addDays('2026-02-30', 1), /日期/);
  assert.throws(() => D.addDays('2026/10/09', 1), /日期/);
  assert.throws(() => D.addDays('', 1), /日期/);
  assert.throws(() => D.addDays('2026-10-09', 'x'), /天数/);
});

/* ---------- inclusiveDayCount ---------- */
ok('inclusiveDayCount: 10-04 到 10-10 = 7 天', () => {
  assert.strictEqual(D.inclusiveDayCount('2026-10-04', '2026-10-10'), 7);
});

ok('inclusiveDayCount: 同一天 = 1 天', () => {
  assert.strictEqual(D.inclusiveDayCount('2026-10-10', '2026-10-10'), 1);
});

ok('inclusiveDayCount: 结束早于开始 → 0', () => {
  assert.strictEqual(D.inclusiveDayCount('2026-10-10', '2026-10-04'), 0);
});

/* ---------- coveredHours / coveredDays ---------- */
ok('coveredDays: 整天 00:00:00–23:59:59 = 1 天', () => {
  assert.strictEqual(D.coveredDays('2026-10-10 00:00:00', '2026-10-10 23:59:59'), 1);
});

ok('coveredHours: 整天 = 24 小时', () => {
  assert.strictEqual(D.coveredHours('2026-10-10 00:00:00', '2026-10-10 23:59:59'), 24);
});

ok('coveredHours: 7 整天 = 168 小时', () => {
  assert.strictEqual(D.coveredHours('2026-10-04 00:00:00', '2026-10-10 23:59:59'), 168);
});

ok('coveredDays: 6 小时窗口 = 0.25 天', () => {
  assert.strictEqual(D.coveredDays('2026-10-10 00:00:00', '2026-10-10 05:59:59'), 0.25);
});

ok('coveredDays: 1 小时窗口 = 1/24 天', () => {
  const v = D.coveredDays('2026-10-10 08:00:00', '2026-10-10 08:59:59');
  assert.ok(Math.abs(v - 1 / 24) < 1e-9, '实际 ' + v);
});

ok('coveredDays: 结束早于开始 → 0（不返回负数）', () => {
  assert.strictEqual(D.coveredDays('2026-10-10 10:00:00', '2026-10-10 08:00:00'), 0);
});

ok('coveredDays: 参数缺失 → 0', () => {
  assert.strictEqual(D.coveredDays(null, '2026-10-10 08:00:00'), 0);
  assert.strictEqual(D.coveredDays('2026-10-10 08:00:00', undefined), 0);
});

/* ---------- 与本地时区无关 ---------- */
ok('与本地时区无关：同一输入在任何 TZ 下结果一致', () => {
  const snap = D.addDays('2026-10-09', -7) + '|' + D.coveredDays('2026-10-04 00:00:00', '2026-10-10 23:59:59');
  assert.strictEqual(snap, '2026-10-02|7');
  /* 直接证明没有走 Date 的本地时区路径 */
  const d = new Date('2026-10-09T00:00:00');
  const bad = new Date(d.getTime() - 7 * 86400e3).toISOString().slice(0, 10);
  if (process.env.TZ && /Shanghai|Chongqing|Asia\/Shanghai/.test(process.env.TZ)) {
    assert.strictEqual(bad, '2026-10-01', '旧写法在 Asia/Shanghai 下应回退一天（本断言用于证明测试环境正确）');
  }
});

/* ---------- todayCN / ymd 等辅助（导出文件名用） ---------- */
ok('todayCN: 返回 YYYY-MM-DD 且等于上海时区的今天', () => {
  const t = D.todayCN();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(t), '格式不对: ' + t);
  const shanghai = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  assert.strictEqual(t, shanghai);
});

ok('stampCN: 返回 YYYYMMDD', () => {
  assert.ok(/^\d{8}$/.test(D.stampCN()));
});

console.log('\n' + (fail ? 'FAIL' : 'OK') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
