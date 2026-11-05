/* v6.7 回归测试：三件事
   ① 不良上限 300 → 1000（拉高的前提是贴装明细改成小批并发，不是拍脑袋）
   ② 工作台粘贴识别默认折叠（用户原话：「给我一个折叠选项，默认折叠，有需要再打开」）
   ③ 修掉 Claude 带进来的两处隐患：版本号各说各话、mapSide 匹配顺序把 AVI-EB 吃成 AVI
   ★ 每条断言都对应一次真实踩坑，不要因为「看起来太细」而删。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SM = require('../lib/v2/sampling');
const S = require('../lib/v2/sql');

let pass = 0, fail = 0;
function ok(name, fn, extra) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message + (extra ? ' | ' + extra : '')); }
}
const ROOT = path.join(__dirname, '..');
const IDX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const COL = fs.readFileSync(path.join(ROOT, 'lib', 'v2', 'collect.js'), 'utf8');
const SQLF = fs.readFileSync(path.join(ROOT, 'lib', 'v2', 'sql.js'), 'utf8');
/* 发行包里 server_v2.js 会改名成 server.js，测试要两种都能读（v6.7 打包时踩到） */
const SRV_PATH = ['server_v2.js', 'server.js']
  .map(f => path.join(ROOT, f)).find(f => fs.existsSync(f));
const SRV = fs.readFileSync(SRV_PATH, 'utf8');

console.log('\n[1] 不良上限 300 → 1000');
ok('上限常量是 1000', () => assert.strictEqual(SM.MAX_ANALYZED, 1000));
ok('SQL 取数上限 = 1000+1（多取一条判截断）', () => {
  assert.ok(new RegExp('TOP\\s+' + (SM.MAX_ANALYZED + 1) + '\\b', 'i').test(SM.fetchLimitSql()), '实际 ' + SM.fetchLimitSql());
});
ok('抽样仍然按 MD5 稳定哈希排序，没有退回 NEWID()', () => {
  assert.ok(/HASHBYTES\(\s*'MD5'/i.test(SM.orderBySql('r')));
  assert.ok(!/NEWID\(/i.test(SM.orderBySql('r')));
});
ok('collect 里不再有死常量 MAX_NG（唯一的真上限是 SM.MAX_ANALYZED）', () => {
  assert.ok(!/const\s+MAX_NG\s*=/.test(COL), 'MAX_NG 又回来了');
});
ok('贴装明细改成了小批并发（PLACE_CHUNK / PLACE_CONC 存在且被用）', () => {
  assert.ok(/const\s+PLACE_CHUNK\s*=\s*\d+/.test(COL));
  assert.ok(/const\s+PLACE_CONC\s*=\s*\d+/.test(COL));
  assert.ok(/runBatched\(\s*usedPanels/.test(COL), '贴装/载具/SPI/钢网没有走 runBatched');
});
ok('runBatched 按批顺序回填（下游顺序与串行版一致，不能改成 push 到共享数组）', () => {
  assert.ok(/const out = new Array\(parts\.length\)/.test(COL), '缺少按序号回填的 buckets');
  assert.ok(/out\[i\] = await fn\(parts\[i\]\)/.test(COL));
});
ok('并发数不超过连接池 max=4 的两倍（6 是实测上限，别乱加）', () => {
  const m = COL.match(/const\s+PLACE_CONC\s*=\s*(\d+)/);
  assert.ok(m && Number(m[1]) <= 8, '实际 ' + (m && m[1]));
});

console.log('\n[2] 工作台粘贴识别默认折叠');
ok('有折叠头 #pqmHead 与折叠体 #pqmBody', () => {
  assert.ok(/id="pqmHead"/.test(IDX), '缺 #pqmHead');
  assert.ok(/id="pqmBody"/.test(IDX), '缺 #pqmBody');
});
ok('#pqmBody 默认 hidden（默认折叠）', () => {
  assert.ok(/id="pqmBody"[^>]*\bhidden\b/.test(IDX), '初始没有 hidden');
});
ok('折叠状态记进 localStorage，下次打开保持上次的样子', () => {
  assert.ok(/localStorage\.setItem\(PQM_OPEN_KEY/.test(IDX));
  assert.ok(/localStorage\.getItem\(PQM_OPEN_KEY/.test(IDX));
});
ok('点头部能展开/收起，且同步 aria-expanded（键盘可达）', () => {
  assert.ok(/el\('pqmHead'\)\.addEventListener\('click'/.test(IDX));
  assert.ok(/setAttribute\('aria-expanded'/.test(IDX));
  assert.ok(/keydown/.test(IDX), '缺键盘支持');
});
ok('从工作台点「查共性」跳进来时自动展开（否则用户看不到识别结果）', () => {
  assert.ok(/function openPasteBox/.test(IDX));
  assert.ok(/if\(Q\.project\|\|Q\.side\|\|Q\.from\)\{ openPasteBox\(\);/.test(IDX), 'boot 里没调 openPasteBox');
});

console.log('\n[3] 版本号各说各话（Claude 引入的隐患）');
ok('服务端 APP_VER 是 v6.7', () => assert.ok(/APP_VER\s*=\s*'v6\.7'/.test(SRV)));
ok('页面静态版本 == 服务端 APP_VER', () => {
  const sv = (SRV.match(/APP_VER\s*=\s*'([^']+)'/) || [])[1];
  const hv = (IDX.match(/<title>[^<]*?(v\d+\.\d+)/) || [])[1];
  assert.strictEqual(hv, sv, 'index=' + hv + ' server=' + sv);
});
ok('页面里没有残留旧版本号 v6.5 / v6.6', () => {
  const bad = IDX.match(/v6\.[56]/g) || [];
  assert.strictEqual(bad.length, 0, '残留 ' + bad.join(','));
});

console.log('\n[4] mapSide 匹配顺序（AVI-EB 不能被 AVI 吃掉）');
const mapSideSrc = (IDX.match(/var MAP_RULES=\[[\s\S]*?\];/) || [''])[0];
ok('MAP_RULES 规则表存在，且按「长 key 先」排列', () => {
  assert.ok(mapSideSrc, '没有 MAP_RULES');
  const aviEb = mapSideSrc.indexOf("'AVI-EB'"), avi = mapSideSrc.indexOf("['AVI','be|AVI']");
  assert.ok(aviEb >= 0, '缺 AVI-EB 规则');
  assert.ok(aviEb < avi, 'AVI-EB 必须排在 AVI 之前');
});
ok('PRESSURE 有自己的规则（以前落到 CR 或漏掉）', () => {
  assert.ok(/PRESSURE/.test(mapSideSrc), '缺 PRESSURE');
});
ok('mapSide 按规则表逐条比，不再写死 if 链', () => {
  assert.ok(/for\(var i=0;i<MAP_RULES\.length;i\+\+\)/.test(IDX));
});
ok('所有 key 都能落到 #side 的合法值上（前缀只能是 be| / front| / rear|）', () => {
  const vals = [...mapSideSrc.matchAll(/'((?:be|front|rear)\|[A-Za-z-]+)'/g)].map(m => m[1]);
  assert.ok(vals.length >= 10, '只解析出 ' + vals.length + ' 条规则');
  for (const v of vals) assert.ok(/^(be|front|rear)\|[A-Za-z-]+$/.test(v), '非法值 ' + v);
});
ok('BE 工序 key 与 BE_PROCS 定义对得上', () => {
  const beKeys = [...IDX.matchAll(/\{\s*key:\s*'([A-Z-]+)',\s*label:/g)].map(m => m[1]);
  const mapBe = [...mapSideSrc.matchAll(/'be\|([A-Z-]+)'/g)].map(m => m[1]);
  for (const k of mapBe) assert.ok(beKeys.includes(k), 'mapSide 里的 ' + k + ' 不在 BE_PROCS 里');
});

console.log('\n[5] windowPanelsQuery 必须钉死 RECOMPILE（v6.7 修真 bug）');
ok('windowPanelsQuery 带 OPTION (MAXDOP 4, RECOMPILE)', () => {
  const m = SQLF.match(/function windowPanelsQuery[\s\S]{0,900}?OPTION\s*\(([^)]*)\)/);
  assert.ok(m, '没有 OPTION 提示');
  assert.ok(/RECOMPILE/i.test(m[1]), '实际 OPTION(' + m[1] + ')');
});
ok('注释里留下了实测证据（158 秒 vs 0.6 秒），以后有人想删提示先读注释', () => {
  const blk = SQLF.match(/function windowPanelsQuery[\s\S]{0,1600}/)[0];
  assert.ok(/158/.test(blk) && /RECOMPILE/.test(blk), '注释里没有实测数字');
});

console.log('\n' + (fail ? 'FAIL 通过 ' : 'OK 通过 ') + pass + ' / 失败 ' + fail + '\n');
process.exit(fail ? 1 : 0);
