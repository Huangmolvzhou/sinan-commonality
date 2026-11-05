/* 闸门 v6.0 —— 控制同时打到 MES 上的压力
   ★ 起因：实测 5 人同时点「开始分析」，服务器并发请求从 20 涨到 142、工作线程
     857/1216、单条查询从 16 秒变 166 秒；8 人同时点一半请求直接 ECONNRESET。
     所以必须在本地排队，不能让人多点几下就把 MES 拖慢。

   两层闸门：
   1) 语句闸（DB_MAX）：同一时刻最多几条 SQL 在飞。配合连接池 max=4。
   2) 任务闸（JOB_MAX）：同一时刻最多几个「一次分析」在跑。其余排队并告知要等多久。
*/

function makeGate(max) {
  let running = 0;
  const waiters = [];
  /* 最近若干次任务耗时，用来估排队时间（估不准就写「约」） */
  const recent = [];
  function avgMs() {
    if (!recent.length) return 20000;
    return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
  }
  async function acquire() {
    if (running < max) { running++; return; }
    await new Promise(res => waiters.push(res));
    running++;
  }
  function release() {
    running = Math.max(0, running - 1);
    const next = waiters.shift();
    if (next) next();
  }
  return {
    async run(fn, onWait) {
      const ahead = waiters.length;
      if (running >= max) onWait && onWait({ ahead: ahead + 1, etaMs: (ahead + 1) * avgMs() });
      await acquire();
      const t = Date.now();
      try { return await fn(); }
      finally {
        recent.push(Date.now() - t);
        if (recent.length > 20) recent.shift();
        release();
      }
    },
    stats() { return { max, running, waiting: waiters.length, avgMs: avgMs() }; }
  };
}

/* 语句闸：4 条并发（连接池 max=4），多出来的在 Node 侧等，不堆到 SQL Server 上 */
const STMT = makeGate(4);
/* 任务闸：2 个「一次分析」并发。单人用永远不排队；多人同时用自动串起来 */
const JOB = makeGate(2);

/* ★ v6.1 Task5：并发作用域 = 进程内。
   JOB / STMT 都是这个 Node 进程里的变量：每个人双击启动就是一套独立名额，
   所以「最多 2 个」只对本机成立，部门整体并发并没有因此受控。 */
const SCOPE = 'process';

/**
 * 读 QUEUE_MODE / QUEUE_COORDINATOR_URL。
 * local（默认）：仅本机限流，页面和文档必须这么写。
 * central      ：共享排队服务，必须给地址；没给就抛错，绝不悄悄回退成本机模式
 *                （回退会让所有人以为自己排队了，实际上只是各自本机排队）。
 */
function queueConfig() {
  const raw = process.env.QUEUE_MODE;
  const mode = raw === undefined || raw === '' ? 'local' : String(raw).toLowerCase();
  if (mode !== 'local' && mode !== 'central') {
    throw new Error('QUEUE_MODE 只能是 local 或 central（当前是「' + raw + '」）。');
  }
  if (mode === 'central') {
    const url = String(process.env.QUEUE_COORDINATOR_URL || '').trim();
    if (!url) {
      throw new Error('QUEUE_MODE=central 但没有配 QUEUE_COORDINATOR_URL，无法启动。'
        + '要么配上共享排队服务地址，要么改回 QUEUE_MODE=local（仅本机限流）。');
    }
    return { mode, url, note: '共享排队服务已配置，排队由服务端协调。' };
  }
  return {
    mode: 'local',
    url: null,
    note: '仅本机限流：本机同时最多运行 2 个分析；多人共用时，需要部门共享服务才能实现全局排队。'
  };
}

module.exports = { STMT, JOB, makeGate, SCOPE, queueConfig };
