/* 一次性生成 ~/.config/sinan/mes.local.json 与 be.local.json（凭据从这里读，源码里没有） */
const fs = require('fs'), os = require('os'), path = require('path'), readline = require('readline');
const dir = process.env.SINAN_CONFIG_DIR || path.join(os.homedir(), '.config', 'sinan');
fs.mkdirSync(dir, { recursive: true });

/* 用行队列而不是 rl.question：管道输入时 question 会丢行，行队列稳 */
const r = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const buf = [], waiters = [];
r.on('line', l => { const w = waiters.shift(); if (w) w(l); else buf.push(l); });
const closed = new Promise(res => r.on('close', res));
function nextLine() {
  if (buf.length) return Promise.resolve(buf.shift());
  return new Promise(res => { const w = waiters.shift(); waiters.push(res); closed.then(() => res(null)); });
}
async function ask(q, def) {
  process.stdout.write(q + (def ? ' [' + def + '] ' : ' ') + '\n');
  const a = (await nextLine() || '').trim();
  return a || def || '';
}

(async () => {
  console.log('\n  司南 SINAN · 首次配置数据库连接');
  console.log('  （只填一次，存在 ' + dir + '；不进源码、不进发行包）\n');
  const mes = {
    host: await ask('MES 主库地址（IP）', '<MES_HOST>'),
    port: Number(await ask('端口', '1433')) || 1433,
    database: await ask('数据库名', 'mes40'),
    user: await ask('用户名', ''),
    password: await ask('密码', '')
  };
  fs.writeFileSync(path.join(dir, 'mes.local.json'), JSON.stringify(mes, null, 2), { mode: 0o600 });
  console.log('  ✓ 主库写好：' + path.join(dir, 'mes.local.json'));
  const beHost = await ask('后段（成品测试）库地址，不清楚就直接回车跳过', '');
  if (beHost) {
    const be = {
      host: beHost,
      port: Number(await ask('后段端口', '1433')) || 1433,
      database: await ask('后段数据库名', 'mes40'),
      user: await ask('后段用户名（回车＝同主库）', mes.user),
      password: await ask('后段密码（回车＝同主库）', mes.password)
    };
    fs.writeFileSync(path.join(dir, 'be.local.json'), JSON.stringify(be, null, 2), { mode: 0o600 });
    console.log('  ✓ 后段库写好：' + path.join(dir, 'be.local.json'));
  } else {
    console.log('  · 没填后段地址：按 SN 查与后段联动会提示「后段库未配置」');
  }
  r.close();
  console.log('\n  完成。直接双击「启动工具」即可。\n');
})();
