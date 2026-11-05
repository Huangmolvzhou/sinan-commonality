/* Task 5 回归测试：本机并发闸门 + 并发作用域声明
   ★ 背景：JOB / STMT 是 Node 进程内变量。每个人双击启动工具，就各自有一套「最多 2 个分析」，
     所以单机受控、部门整体不受控。页面/文档不许再暗示「全公司最多 2 个」。
   本测试锁定：① 闸门真的限住并发；② 排队时告知前面几个、约等多久；
              ③ QUEUE_MODE=central 但没配地址时必须启动失败，不许悄悄回退成本机模式。 */
const assert = require('assert');
const G = require('../lib/gate');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
function okAsync(name, fn) {
  return fn().then(() => { pass++; console.log('  ✓ ' + name); })
    .catch(e => { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); });
}

console.log('\n【Task 5】本机并发闸门');

(async () => {
  /* ---------- 闸门本体 ---------- */
  await okAsync('上限 2：5 个任务同时进来，峰值并发恰好 2', async () => {
    const gate = G.makeGate(2);
    let running = 0, peak = 0;
    const task = () => gate.run(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 20));
      running--;
    });
    await Promise.all([task(), task(), task(), task(), task()]);
    assert.strictEqual(peak, 2, '峰值实际 ' + peak);
  });

  await okAsync('排队时会回调 onWait，并给出前面几个 + 预计等待', async () => {
    const gate = G.makeGate(1);
    const waits = [];
    const slow = () => gate.run(() => new Promise(r => setTimeout(r, 30)), w => waits.push(w));
    await Promise.all([slow(), slow(), slow()]);
    assert.ok(waits.length >= 2, 'onWait 只被调用 ' + waits.length + ' 次');
    assert.strictEqual(waits[0].ahead, 1);
    assert.ok(waits[1].ahead >= 2, 'ahead=' + waits[1].ahead);
    assert.ok(waits[0].etaMs > 0, 'etaMs=' + waits[0].etaMs);
  });

  await okAsync('跑满后 stats() 如实反映 running / waiting / max', async () => {
    const gate = G.makeGate(1);
    const slow = () => gate.run(() => new Promise(r => setTimeout(r, 40)));
    const ps = [slow(), slow()];
    await new Promise(r => setTimeout(r, 5));
    const st = gate.stats();
    assert.strictEqual(st.max, 1);
    assert.strictEqual(st.running, 1);
    assert.ok(st.waiting >= 1, 'waiting=' + st.waiting);
    await Promise.all(ps);
  });

  await okAsync('任务抛异常也会释放名额（不会把闸门锁死）', async () => {
    const gate = G.makeGate(1);
    await gate.run(async () => { throw new Error('boom'); }).catch(() => {});
    const r = await gate.run(async () => 'ok');
    assert.strictEqual(r, 'ok');
  });

  /* ---------- 并发作用域 ---------- */
  ok('并发作用域常量 = process（本机进程内，不是全公司）', () => {
    assert.strictEqual(G.SCOPE, 'process');
  });

  ok('默认 QUEUE_MODE=local，且文案明确写「仅本机限流」', () => {
    delete process.env.QUEUE_MODE;
    const q = G.queueConfig();
    assert.strictEqual(q.mode, 'local');
    assert.ok(/仅本机限流/.test(q.note), '实际: ' + q.note);
    assert.ok(/本机同时最多运行/.test(q.note), '实际: ' + q.note);
  });

  ok('QUEUE_MODE=central 但没配 QUEUE_COORDINATOR_URL → 抛错（不许悄悄回退）', () => {
    process.env.QUEUE_MODE = 'central';
    delete process.env.QUEUE_COORDINATOR_URL;
    assert.throws(() => G.queueConfig(), /QUEUE_COORDINATOR_URL/);
  });

  ok('QUEUE_MODE=central 且配了地址 → 通过，并声明由服务端协调', () => {
    process.env.QUEUE_MODE = 'central';
    process.env.QUEUE_COORDINATOR_URL = 'http://10.0.0.9:8600';
    const q = G.queueConfig();
    assert.strictEqual(q.mode, 'central');
    assert.strictEqual(q.url, 'http://10.0.0.9:8600');
    assert.ok(/服务端/.test(q.note), '实际: ' + q.note);
  });

  ok('QUEUE_MODE 写了非法值 → 抛错，不静默当 local', () => {
    process.env.QUEUE_MODE = 'global';
    assert.throws(() => G.queueConfig(), /QUEUE_MODE/);
  });

  delete process.env.QUEUE_MODE;
  delete process.env.QUEUE_COORDINATOR_URL;

  /* ---------- 页面文案不得暗示全局 ---------- */
  ok('前端不再出现「全局最多 2 个」这类暗示', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const bad = /全公司最多|全局最多|整个部门最多/.exec(html);
    assert.strictEqual(bad, null, '命中: ' + (bad && bad[0]));
  });

  console.log('\n' + (fail ? 'FAIL' : 'OK') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
