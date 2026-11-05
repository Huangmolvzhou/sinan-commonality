/* v6.4：时间段分布 + 「有无突然上升」判定 + MES 时间取日期口径
   用户需求（m14832）原话：
     「BE 段共性分析有一个时间段不良数量分布直方图，SMT 没有增加一下。方便看时间上是不是
      突然新增的，同时判定的时候也要增加一下，有无突然上升。」

   这套测试锁四件事：
   ① detectRise 的判据（2 倍才算上升、1.3 倍算略有、样本不足必须说看不出来）
   ② 尖峰与上升起点不许混淆（单点尖峰不是持续上升）
   ③ shiftFocus 班次划分
   ④ ★ MES 时间取日期必须用 UTC 分量（踩过的坑：用本地 getter 整体偏 +8 小时，
      窗口结束 10-25 却在 byDay 里冒出 10-26）

   跑法：NODE_PATH=<node_modules> node tests/v2_burst_test.js */

const path = require('path');
const B = require('../lib/v2/burst');
const DU = require('../lib/v2/date_utils');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name + '（期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a) + '）', JSON.stringify(a) === JSON.stringify(b)); }
function near(name, a, b, tol) {
  const t = tol || 0.05;
  ok(name + '（期望 ≈' + b + '，实得 ' + a + '）', Number.isFinite(a) && Math.abs(a - b) <= t);
}

function buckets(arr, prefix) {
  return arr.map((n, i) => ({ label: (prefix || 'D') + (i + 1), ng: n }));
}

console.log('\n=== 1. 明显上升：后段是前段的 2 倍以上 ===');
{
  const r = B.detectRise(buckets([2, 2, 3, 2, 8, 9, 8, 10, 9]), { unit: '天' });
  eq('level', r.level, 'rise');
  ok('rising=true', r.rising === true);
  ok('文案说「往上走」', /往上走|突然多了/.test(r.text), r.text);
  ok('文案给出上升起点', !!(r.onset && r.onset.label), JSON.stringify(r.onset));
  ok('文案不出现绝对化词', !/一定|必然|证明/.test(r.text), r.text);
}

console.log('\n=== 2. 略抬头但不到 2 倍：不许叫「突然上升」 ===');
{
  const r = B.detectRise(buckets([10, 10, 10, 10, 13, 13, 13, 13]), { unit: '天' });
  eq('level', r.level, 'slight');
  ok('rising=false', r.rising === false);
  ok('文案说「不足以当成突发」', /不足以当成突发/.test(r.text), r.text);
}

console.log('\n=== 3. 平的：前段后段一个水平 ===');
{
  const r = B.detectRise(buckets([20, 20, 20, 20, 20, 20]), { unit: '天' });
  eq('level', r.level, 'flat');
  ok('文案说「没有突然上升」', /没有突然上升/.test(r.text), r.text);
}

console.log('\n=== 4. 往下走 ===');
{
  const r = B.detectRise(buckets([40, 40, 40, 8, 7, 8]), { unit: '天' });
  eq('level', r.level, 'fall');
  ok('文案说「往下走」', /往下走/.test(r.text), r.text);
}

console.log('\n=== 5. ★ 孤立尖峰 ≠ 持续上升（关键：别把某天突然 200 条说成整体上升）===');
{
  /* 前段高、后段低，但中间某天爆量 —— 整体应当判 fall/flat，尖峰单独点出来 */
  const r = B.detectRise(buckets([7, 7, 7, 240, 6, 7, 7, 6]), { unit: '天' });
  ok('整体不判 rise（实得 ' + r.level + '）', r.level !== 'rise');
  ok('尖峰被单独识别', !!(r.spike && r.spike.ng === 240), JSON.stringify(r.spike));
  ok('文案提到「孤立尖峰」', /孤立尖峰/.test(r.text), r.text);
}

console.log('\n=== 6. 样本不足必须说「看不出来」，绝不硬给结论 ===');
{
  const r1 = B.detectRise(buckets([1, 2, 1]), { unit: '天' });      /* 总数 4 < 8 */
  eq('总条数不足 → level', r1.level, 'unknown');
  ok('文案说「样本太少」', /样本太少/.test(r1.text), r1.text);
  ok('unknown 时 rising=false', r1.rising === false);

  const r2 = B.detectRise(buckets([20, 20]), { unit: '天' });       /* 只有 2 个桶 */
  eq('桶数不足 → level', r2.level, 'unknown');
  ok('文案说「不足以判断趋势」', /不足以判断趋势/.test(r2.text), r2.text);
  ok('文案给出补救办法', /拉长/.test(r2.text), r2.text);
}

console.log('\n=== 7. 从零起来的情况（中位为 0，只在某天冒出来）===');
{
  const r = B.detectRise(buckets([0, 0, 0, 0, 0, 30, 0, 0]), { unit: '天' });
  ok('识别出 peak', r.peak && r.peak.ng === 30, JSON.stringify(r.peak));
  ok('onset 标记 fromZero', !!(r.onset && r.onset.fromZero), JSON.stringify(r.onset));
}

console.log('\n=== 8. 异常输入不许抛异常 ===');
{
  let threw = false;
  try {
    const a = B.detectRise(null, {});
    const b = B.detectRise([], {});
    const c = B.detectRise([{ label: 'x', ng: NaN }], {});
    ok('null / 空 / NaN 都返回对象不抛异常',
      a && b && c && typeof a.level === 'string' && typeof b.level === 'string' && typeof c.level === 'string');
  } catch (e) { threw = true; }
  ok('未抛异常', !threw);
}

console.log('\n=== 9. shiftFocus 班次划分 ===');
{
  /* 早班 08-15 全放 1，其它为 0 → 应判定早班 */
  const h = new Array(24).fill(0);
  for (let i = 8; i < 16; i++) h[i] = 10;
  const s = B.shiftFocus(h);
  eq('topShift', s.topShift.key, 'morning');
  eq('早班条数', s.topShift.n, 80);
  eq('班次占比', s.shiftShare, 1);
  eq('早班时段不应算错', s.shifts.length, 3);

  /* 夜班 00-07 */
  const h2 = new Array(24).fill(0);
  for (let i = 0; i < 8; i++) h2[i] = 5;
  eq('夜班识别', B.shiftFocus(h2).topShift.key, 'night');

  /* 中班 16-23 */
  const h3 = new Array(24).fill(0);
  for (let i = 16; i < 24; i++) h3[i] = 5;
  eq('中班识别', B.shiftFocus(h3).topShift.key, 'evening');

  eq('全 0 返回 null', B.shiftFocus(new Array(24).fill(0)), null);
}

console.log('\n=== 10. ★ MES 时间取日期：必须用 UTC 分量（本地 getter 会偏 +8 小时）===');
{
  /* mssql 默认 useUTC:true，DB 里的 datetime 被当成 UTC 塞进 Date。
     实测锚点：SQL 侧 CONVERT 出来 '2026-10-19 01:27:17'，JS 侧 toISOString 也是 01:27:17Z。 */
  const d = new Date('2026-10-19T01:27:17Z');
  eq('日期 = MES 存的那天', DU.mesDayOf(d), '2026-10-19');
  eq('小时 = MES 存的那个小时', DU.mesHourOf(d), 1);

  /* 关键边界：晚上 20:00 绝不能被推成次日（这就是当初的 bug） */
  const late = new Date('2026-10-25T20:00:00Z');
  eq('晚 20:00 仍是当天', DU.mesDayOf(late), '2026-10-25');
  eq('晚 20:00 的小时', DU.mesHourOf(late), 20);

  /* 23:59 也不能跨天 */
  eq('23:59 不跨天', DU.mesDayOf(new Date('2026-10-25T23:59:59Z')), '2026-10-25');
  /* 00:00 也不能回退 */
  eq('00:00 不回退', DU.mesDayOf(new Date('2026-10-25T00:00:00Z')), '2026-10-25');

  /* 字符串输入也要能用（历史数据 / 某些查询返回 varchar） */
  eq('字符串日期直接用', DU.mesDayOf('2026-10-19 08:00:00'), '2026-10-19');
  eq('字符串小时', DU.mesHourOf('2026-10-19 08:00:00'), 8);
  eq('null 日期 → 空串', DU.mesDayOf(null), '');
  eq('null 小时 → -1', DU.mesHourOf(null), -1);
  eq('非法 Date → 空串', DU.mesDayOf(new Date('xxx')), '');

  /* 全窗口遍历：不许出现窗口外的日期（当初 byDay 冒出 10-26 就是这个坏掉的表现） */
  const lo = Date.parse('2026-10-19T00:00:00Z');
  let outOfRange = 0, days = {};
  for (let i = 0; i < 7 * 24; i++) {
    const t = new Date(lo + i * 3600e3);
    const dd = DU.mesDayOf(t);
    days[dd] = (days[dd] || 0) + 1;
    if (dd < '2026-10-19' || dd > '2026-10-25') outOfRange++;
  }
  eq('7 天窗口内没有任何一天越界', outOfRange, 0);
  eq('恰好 7 个不同的天', Object.keys(days).length, 7);
  ok('每天恰好 24 小时', Object.values(days).every(v => v === 24), JSON.stringify(days));
}

console.log('\n=== 11. 与引擎接线的护栏（白名单不许再吞字段）===');
{
  const fs = require('fs');
  const srv = require('./_src').SRV();   /* v6.7：发行包里叫 server.js */
  ok('server 白名单里带 timeProfile', /timeProfile\s*:\s*res\.timeProfile/.test(srv),
    '缺了会导致引擎算了页面看不见（v6.0 parseFail / v6.1 correction 都栽过）');
  const eng = fs.readFileSync(path.join(__dirname, '..', 'lib/v2/engine.js'), 'utf8');
  ok('engine 里 timeProfile 已导出', /timeProfile\s*[,}]/.test(eng));
  ok('engine 不再用 String(r.time).slice 取日期（那个写法对 Date 是错的）',
    !/String\(\s*r\.time\s*\|\|\s*''\s*\)\.slice/.test(eng));
  ok('engine 用 mesDayOf 取日期', /mesDayOf\(r\.time\)/.test(eng));
  const be = fs.readFileSync(path.join(__dirname, '..', 'lib/v2/be_engine.js'), 'utf8');
  ok('BE 侧也接了 detectRise', /BU\.detectRise/.test(be));
  ok('BE 侧也接了 shiftFocus', /BU\.shiftFocus/.test(be));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  ok('前端渲染了时间段分布', /renderTimeProfile/.test(html));
  ok('导出报告也带时间段分布', /时间段不良分布（有没有突然上升）/.test(html));
}

console.log('\n' + (fail === 0 ? 'OK 通过 ' + pass + ' / 失败 0' : 'FAIL 通过 ' + pass + ' / 失败 ' + fail));
process.exit(fail === 0 ? 0 : 1);
