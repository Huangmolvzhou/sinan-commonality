/* Task 3 回归测试：不良抽样必须「稳定、可复现、口径透明」
   ★ v6.7：上限从 300 提到 1000（贴装明细改并行后实测跑得动）。本测试改成
     「跟着 SM.MAX_ANALYZED 走，不再写死 300」，并额外锁定「上限就是 1000」这一条，
     防止有人没想清楚又改回去或改更大。
   ★ 背景：v6.0 的 ngQuery 按 CreateTime DESC 排序、把全部不良回传给 Node，再 slice(0,300)。
     后果：①长窗口只看到最后发生的那批；②数据库仍返回大量明细，限流没落在 SQL 侧；
          ③页面只说「截断」，容易被理解成「只少了一点」。
   本测试锁定：稳定哈希抽样 + 全量/抽样口径元数据 + 文案不再出现「最近 300 条」。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SM = require('../lib/v2/sampling');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('\n【Task 3】300 条稳定抽样');

ok('v6.7：抽样上限就是 1000（不是 300，也不是更大）', () => {
  assert.strictEqual(SM.MAX_ANALYZED, 1000, '实际: ' + SM.MAX_ANALYZED);
});

ok('SQL 侧有 TOP (上限+1)，多取 1 条用来判断是否超限', () => {
  const sql = SM.fetchLimitSql();
  assert.ok(new RegExp('TOP\\s+' + (SM.MAX_ANALYZED + 1) + '\\b', 'i').test(sql), '实际: ' + sql);
});

ok('排序用稳定哈希，不是 NEWID()', () => {
  const o = SM.orderBySql('r');
  assert.ok(/HASHBYTES\(\s*'MD5'/i.test(o), '实际: ' + o);
  assert.ok(!/NEWID\(/i.test(o));
});

ok('排序表达式引用了稳定唯一键 r.ID', () => {
  assert.ok(/r\.ID/.test(SM.orderBySql('r')));
});

ok('相同输入 → 相同抽样顺序（跑两次完全一致）', () => {
  const ids = [];
  for (let i = 1; i <= 500; i++) ids.push(100000 + i);
  const a = SM.stableOrder(ids).slice(0, 50).join(',');
  const b = SM.stableOrder(ids).slice(0, 50).join(',');
  assert.strictEqual(a, b);
});

ok('抽样顺序与输入顺序无关（打乱输入结果一致）', () => {
  const ids = [];
  for (let i = 1; i <= 200; i++) ids.push('R' + i);
  const a = SM.stableOrder(ids).slice(0, 30).join(',');
  const shuffled = ids.slice().reverse();
  const b = SM.stableOrder(shuffled).slice(0, 30).join(',');
  assert.strictEqual(a, b);
});

ok('抽样顺序按 md5 升序（与 SQL 的 ORDER BY 同序）', () => {
  const crypto = require('crypto');
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const want = ids.slice().sort((x, y) =>
    crypto.createHash('md5').update(String(x)).digest('hex')
      .localeCompare(crypto.createHash('md5').update(String(y)).digest('hex')));
  assert.deepStrictEqual(SM.stableOrder(ids), want);
});

ok('population=238 → 全量，method=full，ratio=1', () => {
  const m = SM.buildMeta(238, 238);
  assert.strictEqual(m.method, 'full');
  assert.strictEqual(m.population, 238);
  assert.strictEqual(m.analyzed, 238);
  assert.strictEqual(m.ratio, 1);
  assert.strictEqual(m.maxAnalyzed, SM.MAX_ANALYZED);
});

ok('population=2000 → 抽样 1000 条，method=stable_hash_id，ratio=0.5', () => {
  const m = SM.buildMeta(2000, 1000);
  assert.strictEqual(m.method, 'stable_hash_id');
  assert.strictEqual(m.population, 2000);
  assert.strictEqual(m.analyzed, 1000);
  assert.ok(Math.abs(m.ratio - 0.5) < 0.001, '实际 ' + m.ratio);
  assert.strictEqual(m.truncated, true);
});

ok('population=1000 正好不截断（刚好等于上限）', () => {
  const m = SM.buildMeta(1000, 1000);
  assert.strictEqual(m.method, 'full');
  assert.strictEqual(m.truncated, false);
});

ok('population=0 不炸，ratio 取 0 而不是 NaN', () => {
  const m = SM.buildMeta(0, 0);
  assert.strictEqual(m.ratio, 0);
  assert.ok(Number.isFinite(m.ratio));
});

ok('人话文案同时给出 总体 / 分析 / 比例', () => {
  const t = SM.describe(SM.buildMeta(2000, 1000));
  assert.ok(/2000/.test(t), '缺总数: ' + t);
  assert.ok(/1000/.test(t), '缺分析数: ' + t);
  assert.ok(/50\.0%/.test(t), '缺比例: ' + t);
});

ok('全量时文案不说「抽样」', () => {
  const t = SM.describe(SM.buildMeta(238, 238));
  assert.ok(!/抽样/.test(t), '实际: ' + t);
  assert.ok(/238/.test(t));
});

ok('文案禁止「最近 300 条」这种时间偏置说法', () => {
  const t = SM.describe(SM.buildMeta(2000, 1000));
  assert.ok(!/最近\s*\d+\s*条/.test(t), '实际: ' + t);
});

ok('前端不再出现「只取最近」/「最近 N 条」的时间偏置文案', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const bad = /只取最近|最近的\s*300|最近\s*300\s*条/.exec(html);
  assert.strictEqual(bad, null, '命中: ' + (bad && bad[0]));
});

ok('ngQuery 构造器带 TOP (上限+1) + 稳定哈希排序', () => {
  const S = require('../lib/v2/sql');
  const qq = S.ngQuery({ side: 'rear', t0: '2026-10-09 00:00:00', t1: '2026-10-10 23:59:59', position: 'COMP-A' });
  assert.ok(new RegExp('TOP\\s+' + (SM.MAX_ANALYZED + 1) + '\\b', 'i').test(qq.sql), '没有 TOP (上限+1)：' + qq.sql.slice(0, 200));
  assert.ok(/HASHBYTES\(\s*'MD5'/i.test(qq.sql), '没有哈希排序');
  assert.ok(!/ORDER BY r\.CreateTime DESC/.test(qq.sql), '仍在按时间倒序取 TOP');
  assert.ok(!/NEWID\(/i.test(qq.sql));
});

ok('ngCountQuery 仍能给出总不良数（派生表里必须去掉 ORDER BY）', () => {
  const S = require('../lib/v2/sql');
  const cq = S.ngCountQuery({ side: 'rear', t0: '2026-10-09 00:00:00', t1: '2026-10-10 23:59:59', position: 'COMP-A' });
  assert.ok(/COUNT\(\*\)/i.test(cq.sql));
  assert.ok(!/ORDER BY/i.test(cq.sql), '派生表里带 ORDER BY 会报错');
});

console.log('\n' + (fail ? 'FAIL' : 'OK') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
