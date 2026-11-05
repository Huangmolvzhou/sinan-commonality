/* v6.7：发行包里 server_v2.js 会改名成 server.js，测试要两种都能读。
   原来 4 个测试各自写死 'server_v2.js'，一进发行包就跑不起来（打包时踩到）。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function readFirst(names) {
  for (const n of names) {
    const f = path.join(ROOT, n);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  throw new Error('找不到以下任一文件：' + names.join(' / ') + '（目录 ' + ROOT + '）');
}
const SRV = () => readFirst(['server_v2.js', 'server.js']);
module.exports = { SRV, readFirst, ROOT };
