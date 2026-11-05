/* Task 2 回归测试：本窗日均必须按「实际分析窗口」算，空白日期计 0
   ★ 背景：v6.0 的 chronicity() 用「出现不良的日期数」当分母
       const winDays = Object.keys(byDay).length || 1;
     结果：7 天窗口只有 1 天有 10 条不良 → winDays=1、winDaily=10 → 误判「明显突发」。
   本测试锁定：日均 = 窗内不良总数 ÷ 窗口实际覆盖天数（含 0 不良的日子）。 */
const assert = require('assert');
const E = require('../lib/v2/engine');
const D = require('../lib/v2/date_utils');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('\n【Task 2】本窗日均口径');

/* 造 ctx：history 中位数 med、逐日不良 */
function ctxOf(opts) {
  const { t0, t1, perDay, med = 1, p90 = 3 } = opts;
  const ng = [];
  const start = D.parseDateOnly(String(t0).slice(0, 10)).ms;
  Object.keys(perDay).forEach((day, i) => {
    for (let k = 0; k < perDay[day]; k++) {
      ng.push({ panel: 'P' + day + '_' + k, seq: 10, time: day + ' 10:00:00', issue: '偏位' });
    }
  });
  const days = [];
  for (let i = 29; i >= 1; i--) days.push({ d: D.addDays(String(t1).slice(0, 10), -i), n: med });
  return {
    ng,
    t0, t1,
    window: {
      t0, t1,
      coveredHours: D.coveredHours(t0, t1),
      coveredDays: D.coveredDays(t0, t1)
    },
    base: {
      history: { days, median: med, p90, windowDays: 30 },
      days: [], ngByDay: {}, panels: 100, baseDays: 7, b0: '2026-09-27', b1: '2026-10-03'
    },
    place: {}, board: {}
  };
}

ok('7 天窗口、只有 1 天有 10 条：winDays=7 而不是 1', () => {
  const c = E.chronicity(ctxOf({
    t0: '2026-10-04 00:00:00', t1: '2026-10-10 23:59:59',
    perDay: { '2026-10-10': 10 }, med: 1
  }));
  assert.strictEqual(c.winDays, 7, 'winDays 实际 ' + c.winDays);
});

ok('7 天窗口、只有 1 天有 10 条：winDaily≈1.4 而不是 10', () => {
  const c = E.chronicity(ctxOf({
    t0: '2026-10-04 00:00:00', t1: '2026-10-10 23:59:59',
    perDay: { '2026-10-10': 10 }, med: 1
  }));
  assert.ok(Math.abs(c.winDaily - 1.4) < 0.15, 'winDaily 实际 ' + c.winDaily);
});

ok('7 天窗口、只有 1 天有 10 条：不得判为 outbreak', () => {
  const c = E.chronicity(ctxOf({
    t0: '2026-10-04 00:00:00', t1: '2026-10-10 23:59:59',
    perDay: { '2026-10-10': 10 }, med: 1
  }));
  assert.notStrictEqual(c.level, 'outbreak', '仍然被判突发，文本：' + c.text);
});

ok('7 天窗口、7 天各 10 条：winDaily=10 且判为突发', () => {
  const perDay = {};
  for (let i = 4; i <= 10; i++) perDay['2026-10-' + String(i).padStart(2, '0')] = 10;
  const c = E.chronicity(ctxOf({
    t0: '2026-10-04 00:00:00', t1: '2026-10-10 23:59:59', perDay, med: 1
  }));
  assert.strictEqual(c.winDays, 7);
  assert.strictEqual(c.winDaily, 10);
  assert.strictEqual(c.level, 'outbreak');
});

ok('1 天窗口、10 条：winDays=1、winDaily=10', () => {
  const c = E.chronicity(ctxOf({
    t0: '2026-10-10 00:00:00', t1: '2026-10-10 23:59:59',
    perDay: { '2026-10-10': 10 }, med: 1
  }));
  assert.strictEqual(c.winDays, 1);
  assert.strictEqual(c.winDaily, 10);
});

ok('6 小时窗口、6 条：winDays=0.25、winDaily=24', () => {
  const c = E.chronicity(ctxOf({
    t0: '2026-10-10 00:00:00', t1: '2026-10-10 05:59:59',
    perDay: { '2026-10-10': 6 }, med: 1
  }));
  assert.strictEqual(c.winDays, 0.25, 'winDays 实际 ' + c.winDays);
  assert.strictEqual(c.winDaily, 24, 'winDaily 实际 ' + c.winDaily);
});

ok('完全相同的不良，只把窗口从 7 天拉长到 14 天：日均必须变小', () => {
  const perDay = { '2026-10-10': 10 };
  const a = E.chronicity(ctxOf({ t0: '2026-10-04 00:00:00', t1: '2026-10-10 23:59:59', perDay, med: 1 }));
  const b = E.chronicity(ctxOf({ t0: '2026-09-27 00:00:00', t1: '2026-10-10 23:59:59', perDay, med: 1 }));
  assert.ok(b.winDaily < a.winDaily, '14 天 ' + b.winDaily + ' 应小于 7 天 ' + a.winDaily);
});

ok('窗口无效（coveredDays=0）时返回 null，不得静默回退成 1 天', () => {
  const c = ctxOf({ t0: '2026-10-10 08:00:00', t1: '2026-10-10 08:00:00', perDay: {}, med: 1 });
  const r = E.chronicity(c);
  assert.strictEqual(r, null);
});

ok('没有 ctx.window 时能从 t0/t1 自己算出来（兼容旧调用）', () => {
  const c = ctxOf({ t0: '2026-10-04 00:00:00', t1: '2026-10-10 23:59:59', perDay: { '2026-10-10': 7 }, med: 1 });
  delete c.window;
  const r = E.chronicity(c);
  assert.strictEqual(r.winDays, 7);
});

ok('窗口 <24h 时带上 winHours，供页面写「按实际 X 小时折算」', () => {
  const c = E.chronicity(ctxOf({
    t0: '2026-10-10 00:00:00', t1: '2026-10-10 05:59:59',
    perDay: { '2026-10-10': 6 }, med: 1
  }));
  assert.strictEqual(c.winHours, 6);
});

ok('后段 be_engine 的 chronicity 同样按窗口天数折算', () => {
  const BE = require('../lib/v2/be_engine');
  const r = BE.chronicity({
    winDays: 0, t0: '2026-10-04 00:00:00', t1: '2026-10-10 23:59:59',
    codes: [], times: [['2026-10-10 10', 10]],
    history: [{ day: '2026-10-01', ng: 1 }], ngTotal: 10
  });
  assert.ok(r === null || r.winDays === 7, '后段 winDays 实际 ' + (r && r.winDays));
});

console.log('\n' + (fail ? 'FAIL' : 'OK') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
