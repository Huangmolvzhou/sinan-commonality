/* v6.6：仅 BE 段快通道的回归测试
   ============================================================================
   锁定的不变量（每条都对应一次真实踩坑或用户明确要求）：

   1. traceBe 不取 SMT 对照板 —— 用户原话：「当前的 BE 追溯 SN 太多的情况下很慢。
      所以做一个 SMT/BE 联合追溯，再放一个单独 BE 段的追溯。」单独这条路存在的
      唯一理由就是「SN 多也不慢」，一旦它偷偷去查邻居板，理由就没了。
   2. beDenom 不许用 COUNT(DISTINCT PanelCode) —— 实测同一条 SQL 加 DISTINCT 从
      2,560ms 涨到 137,307ms（这张表每行 PCBCount 基本为 1，行数就是板数）。
      只要有人在 SQL 里写回 DISTINCT，100 个 SN 就会变成 200 秒超时。
   3. beSnsHit 是「有后段过站记录的 SN 数」不是「有不良的 SN 数」—— 曾经写错，
      界面因此显示 0，看着像一块都没查到。
   4. procAgg 的 boards 是「这批 SN 走过该工序的块数」，denomPanels 才是全厂同期总板数。
      两者不能互换，否则「这批 2 块」会被写成「全厂 2 块」。
   5. denom 取不到时给 null 不给 0 —— 「没基准」和「0 块板」是两件事。
   6. exportBe 表头 17 列，每行必须同长（v6.5 的 exportDetail 就是列数不齐导致整体错位）。
   7. 空数据要返回 {empty:true, reason}，不能给一张空表让人以为查过没问题。
   8. 跨 SN 共性只算 BE 六维 —— SMT 维度在 BE 单段模式下全是空数组，跟着算会造出
      「所有这些板 smtMachine 都为空」这种假共性。
   9. 「只有 1 块板查到」不能说成「散在不同机台上」—— 样本不够 ≠ 查过了没问题。
  10. 两个模式互斥：mode='be' 不传 neighborPcs，mode='both' 才传。
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('../lib/v2/sn_trace');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function src(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); }

const SRC = src('lib/v2/sn_trace.js');
const SRV = require('./_src').SRV();   /* v6.7：发行包里叫 server.js */
const IDX = src('public/index.html');

console.log('\n=== v6.6 仅 BE 段快通道 ===\n');

/* ── 1. 接口存在且签名对 ─────────────────────────────────────────── */
console.log('[1] 导出与签名');
ok('traceBe 已导出', typeof T.traceBe === 'function');
ok('exportBe 已导出', typeof T.exportBe === 'function');
ok('beDenom 已导出', typeof T.beDenom === 'function');
ok('crossSnFor 已导出', typeof T.crossSnFor === 'function');
ok('traceBe(sns, opt) 两个参数', T.traceBe.length === 2, 'length=' + T.traceBe.length);
ok('beDenom(procs, days, budgetMs) 三个参数', T.beDenom.length === 3, 'length=' + T.beDenom.length);

/* ── 2. beDenom 的 SQL 里不许出现 DISTINCT ──────────────────────── */
console.log('\n[2] beDenom 不许 COUNT(DISTINCT ...)');
const dnBody = (SRC.match(/async function beDenom[\s\S]*?\n}/) || [''])[0];
ok('beDenom 函数体取到了', dnBody.length > 200);
ok('beDenom 里没有 COUNT(DISTINCT', !/COUNT\s*\(\s*DISTINCT/i.test(dnBody),
  (dnBody.match(/COUNT\s*\(\s*DISTINCT[^)]*\)/i) || [''])[0]);
ok('beDenom 用 COUNT(*)', /COUNT\(\*\)/i.test(dnBody));
ok('beDenom 按天切片（GROUP BY Process）', /GROUP BY\s+t?\.?Process/i.test(dnBody));
ok('beDenom 有 budgetMs 预算闸', /budgetMs/.test(dnBody) && /budget/.test(dnBody));
ok('beDenom 只取最近 3 天', /slice\(-3\)/.test(dnBody));
ok('beDenom 返回 panels 字段', /\.panels\s*=/.test(dnBody));

/* ── 3. traceBe 不碰 SMT 侧 ─────────────────────────────────────── */
console.log('\n[3] traceBe 不取 SMT 对照（快通道的立身之本）');
const beBody = (SRC.match(/async function traceBe[\s\S]*?\n}\n/) || [''])[0];
ok('traceBe 函数体取到了', beBody.length > 500);
ok('traceBe 里没有 neighbors(', !/neighbors\s*\(/.test(beBody));
ok('traceBe 里没有 neighborsPcs(', !/neighborsPcs\s*\(/.test(beBody));
ok('traceBe 里没有 chAoi(', !/chAoi\s*\(/.test(beBody));
ok('traceBe 里没有 chSpi(', !/chSpi\s*\(/.test(beBody));
ok('traceBe 里没有 smtStations(', !/smtStations\s*\(/.test(beBody));

/* ── 4. beSnsHit 口径 ──────────────────────────────────────────── */
console.log('\n[4] beSnsHit 是「查到过站」不是「有不良」');
ok('beSnsHit 判据含 beStations5.length', /beSnsHit:\s*outRows\.filter\([\s\S]{0,120}beStations5/.test(SRC));
ok('另有 beSnsNg 单独记有不良的块数', /beSnsNg:\s*outRows\.filter/.test(SRC));

/* ── 5. procAgg 口径 ───────────────────────────────────────────── */
console.log('\n[5] procAgg：boards 与 denomPanels 分开');
ok('碰不到基准时给 null 不给 0', /denomPanels:\s*d\s*\?\s*d\.panels\s*:\s*null/.test(SRC),
  (SRC.match(/denomPanels:[^,\n]*/) || [''])[0]);
ok('share 也是 null 兜底', /share:\s*\(d && d\.panels\)/.test(SRC));

/* ── 6. exportBe 表头与列数 ─────────────────────────────────────── */
console.log('\n[6] exportBe 17 列、每行同长');
const ebBody = (SRC.match(/function exportBe[\s\S]*?\n}\n/) || [''])[0];
const headM = ebBody.match(/head\s*=\s*\[([\s\S]*?)\]/);
let headCols = 0;
if (headM) headCols = (headM[1].match(/'/g) || []).length / 2;
ok('exportBe 表头 17 列', headCols === 17, '实际 ' + headCols);
ok('exportBe 为空时给 empty+reason', /empty:\s*true/.test(ebBody) && /reason/.test(ebBody));
ok('exportBe 接受 (raw, cross) 两个参数', /function\s+exportBe\s*\(\s*raw\s*,\s*cross\s*\)/.test(SRC));

/* 真跑一次 exportBe（用假数据），断言每行长度 == 表头 */
(function () {
  const raw = {
    mode: 'be',
    beOnly: { procs: [], denom: { byProc: {}, window: {}, partial: false }, note: '', chNote: '' },
    rows: [{
      sn: 'SN0001', role: '你查的', product: 'P-1', machine: 'M-1',
      procs: ['VSWR'], machines: ['M-1'], holders: ['0001'], seats: ['01'], lanes: ['L'],
      days: ['2026-10-28'], ngCount: 1, retestCount: 0,
      beStations5: [{ proc: 'VSWR', station: '0001', machine: 'M-1', line: 'L1', lane: 'ZDM1VSWR0001-01L', t: '2026-10-28T01:00:00Z', okCount: 0 }],
      defects: [{ proc: 'VSWR', issue: 'RC1', memo: '驻波超', point: 'ZDM1VSWR0001-01L', retest: 0, t: '2026-10-28T01:05:00Z' }],
      smtMachines: [], smtNozzles: []
    }]
  };
  const r = T.exportBe(raw, null);
  ok('exportBe 真跑有表头', Array.isArray(r.head) && r.head.length === 17);
  const bad = (r.rows || []).filter(x => x.length !== r.head.length);
  ok('exportBe 每行长度 == 表头', bad.length === 0, bad.length + ' 行不齐');
  ok('exportBe 有数据时 empty 不为 true', r.empty !== true);
  const r2 = T.exportBe({ mode: 'be', beOnly: {}, rows: [] }, null);
  ok('exportBe 空数据返回 empty', r2.empty === true && !!r2.reason, JSON.stringify(r2.reason || '').slice(0, 40));
})();

/* ── 7. crossSnFor 只算指定维度 ─────────────────────────────────── */
console.log('\n[7] crossSnFor 可只算 BE 六维');
ok('crossSnFor(rows, dims) 两个参数', T.crossSnFor.length === 2, 'length=' + T.crossSnFor.length);
const beDims = T.COMMON_DIMS.filter(d => d.group === 'BE');
ok('COMMON_DIMS 里有 6 个 BE 维', beDims.length === 6, '实际 ' + beDims.length);
ok('BE 维全是 be* 前缀', beDims.every(d => /^be[A-Z]/.test(d.key)));
(function () {
  const rows = [
    { sn: 'A', beMachines: ['M1'], beHolders: ['0001'], beSeats: ['01'], beRails: ['L'], beProcs: ['VSWR'], beDays: ['2026-10-28'], smtMachines: [] },
    { sn: 'B', beMachines: ['M1'], beHolders: ['0001'], beSeats: ['02'], beRails: ['L'], beProcs: ['VSWR'], beDays: ['2026-10-28'], smtMachines: [] }
  ];
  const c = T.crossSnFor(rows, beDims);
  ok('只回 BE 六维的 key', Object.keys(c.dims).length === 6, JSON.stringify(Object.keys(c.dims)));
  ok('没有 smtMachine 维', !c.dims.smtMachine, '不该出现 SMT 维');
  ok('机器两台都撞 → maxPerSn=1 且 allSame', c.dims.beMachine.maxPerSn === 1 && c.dims.beMachine.allSame === true,
    'maxPerSn=' + c.dims.beMachine.maxPerSn);
  /* maxPerSn = 同一个取值最多被几个 SN 共用。两台的穴位分别是 01 / 02，
     各自只被 1 个 SN 用到 → maxPerSn 必须是 1（不是「有几个不同取值」）。
     这条守的是「别把『有走过』说成『都撞在这』」。 */
  ok('穴位不同 → maxPerSn=1 且 allSame=false',
    c.dims.beSeat.maxPerSn === 1 && c.dims.beSeat.allSame === false,
    'maxPerSn=' + c.dims.beSeat.maxPerSn + ' allSame=' + c.dims.beSeat.allSame);
  ok('穴位不同 → items 有两条', (c.dims.beSeat.items || []).length === 2);
})();

/* ── 8. 服务层接线 ─────────────────────────────────────────────── */
console.log('\n[8] server_v2 接线');
ok('/api/sn/trace 读 mode', /String\(b\.mode\s*\|\|\s*'both'\)/.test(SRV));
ok("mode='be' 走 traceBe", /traceBe\s*\(/.test(SRV));
ok("mode='be' 时 crossSnFor 只传 BE 维", /COMMON_DIMS\.filter\([^)]*group\s*===?\s*'BE'/.test(SRV));
ok("返回体带 mode", /mode:\s*'be'/.test(SRV) && /mode:\s*'both'/.test(SRV));
ok("导出分支 kind==='be'", /kind\s*===?\s*'be'/.test(SRV));
ok('导出文件名含「BE段」', /SN追溯_BE段/.test(SRV));
ok('be 模式在 neighborPcs 之前分流（不依赖对照参数）',
  /if\s*\(mode\s*===?\s*'be'\s*\)\s*\{[\s\S]{0,600}?traceBe/.test(SRV));
ok('APP_VER 与页面版本号一致（且是 v6.7）', /APP_VER\s*=\s*'v6\.7'/.test(SRV), (SRV.match(/APP_VER\s*=\s*'[^']+'/) || [''])[0]);

/* ── 9. 前端接线 ───────────────────────────────────────────────── */
console.log('\n[9] 前端接线');
ok('有 #snMode 选择器', /id="snMode"/.test(IDX));
ok('两个 option：both / be', /<option value="both"/.test(IDX) && /<option value="be"/.test(IDX));
ok('有 #snBe 导出按钮', /id="snBe"/.test(IDX));
ok('renderSnResult 按 mode 分流', /rep\.mode\s*===?\s*'be'/.test(IDX) && /renderBeOnly\s*\(/.test(IDX));
ok('存在 renderBeOnly', /function\s+renderBeOnly\s*\(/.test(IDX));
ok("be 模式请求体不传 neighborPcs", /mode:\s*'be'/.test(IDX));
ok('切模式会清掉上一个模式的结果', /ST\.sn\s*=\s*null|delete\s+ST\.sn/.test(IDX));
/* 「只有 1 块查到」不能判成「散在不同机台」 */
ok('单块查到的情形单独分支（hitRows.length < 2）', /hitRows\.length\s*<\s*2/.test(IDX));
ok('有「查到了几个」的提示（missRows）', /missRows/.test(IDX));
/* 占比小到 0 时不写「0%」 */
ok('极小占比显示 <0.01% 而不是 0%', /&lt;0\.01%/.test(IDX));

/* ── 10. 版本一致性 ────────────────────────────────────────────── */
console.log('\n[10] 版本号一致');
ok('index.html 里没有残留 v6.5 / v6.6', !/v6\.[56]/.test(IDX), (IDX.match(/v6\.[56]/g) || []).length + ' 处');
ok('index.html 出现 v6.7', /v6\.7/.test(IDX));
/* v6.7 新修：页面标题/徽章不能各说各话 —— index.html 静态写的版本必须和服务端 APP_VER 一致 */
ok('页面静态版本号 == 服务端 APP_VER（防「标题 v6.7 徽章 v6.6」）', (function(){
  const sv = (SRV.match(/APP_VER\s*=\s*'([^']+)'/) || [])[1];
  const hv = (IDX.match(/<title>[^<]*?(v\d+\.\d+)/) || [])[1];
  return !!sv && sv === hv;
})(), 'server=' + (SRV.match(/APP_VER\s*=\s*'([^']+)'/)||[])[1] + ' index=' + (IDX.match(/<title>[^<]*?(v\d+\.\d+)/)||[])[1]);

console.log('\n' + (fail === 0 ? 'OK 通过 ' : 'FAIL 通过 ') + pass + ' / 失败 ' + fail + '\n');
process.exit(fail === 0 ? 0 : 1);
