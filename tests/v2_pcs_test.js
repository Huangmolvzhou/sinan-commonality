/* v6.5 SN 追溯 pcs 口径回归测试
   锁定的不变量（每条都对应一次真实踩坑或用户明确要求）：
   1. 邻居按 pcs 不按 panel —— 用户原话「不要是 panel 的，因为 SMT 段 1 panel 对应好几十个产品」
      （实测 1 panel 平均 102 个 pcs、最多 360 个，200 块 panel ≈ 2 万个 pcs）
   2. 对照 pcs 必须真的只用「选中的那些 pcs」当基准 —— 不许把同块 panel 上没选中的 pcs 混进来
      （用户选 30 个，基准就该是 30 个，不能偷偷变成 280 个）
   3. pcs 口径下 compare 的基准键要退化成 loc —— 每块 pcs 只有一个 ModuleID，
      用 loc|modid 做键会让目标和对照永远对不上（实测输出 0 行空表）
   4. 目标 pcs 的排除必须按 panel+ModuleID，不能按 panelcode —
      否则同板上的对照 pcs 会被当成目标排掉，对照组整表消失
   5. exportDetail 的 AOI 行字段数必须等于表头列数（历史 bug：17 个值对 18 列表头，
      OffsetX/OffsetY/Rotation 在 Excel 里整体右移一格）
   6. 空字符串的测量值必须当「没测」返回 null，不能变成 0
      （Number('') === 0，会写成「实测 0.00 / 规格 0~0 / 不超规」）
   7. exportFull 只出你查的那一块 pcs 的记录，不出整块 panel 的
   8. exportFull 的 SPI 行要用「板号基码 + 穴位」认目标，不能拿 SN 比（实测会全掉光）
   9. server 路由必须接 neighborPcs 与 kind=full，且不能吞字段
  10. pcs 档位只认 1..500，超了要夹住 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/v2/sn_trace');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '  \u2192 ' + e.message); fail++; }
}

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib/v2/sn_trace.js'), 'utf8');
const SRV = require('./_src').SRV();   /* v6.7：发行包里叫 server.js */

/* 造一份最小 raw，够 exportFull / exportDetail 用 */
function mkRaw(opt) {
  const o = opt || {};
  const panel = 'PANEL00001-2610220001';
  const pcb = 'SN00000005';
  const base = 'PANEL00001';
  return {
    rows: [{ sn: pcb, panel, seq: 280, product: 'P', machine: 'M', t: '2026-10-23T22:00:00Z' }],
    targetPanels: [panel],
    neighPanels: [panel],
    neighPcs: [
      { pcb: 'SN00000006', panel, seq: 1, t: '2026-10-23T21:00:00Z', of: pcb, side: 'before' }
    ],
    mode: 'pcs',
    smt: {
      stations: [{ panel, procn: 'Stick-Tape', station: 'ST', machine: 'M', line: 'L', fixture: 'FX', steel: 'S',
        morder: 'MO', product: 'P', pcbCount: 1, okCount: 1, t: '2026-10-23T21:00:00Z' }],
      aoi: [
        { side: 'Rear', panel, seq: 280, machine: 'M', res: true, fixture: 'FX', product: 'P', station: 'S', procn: 'AOI-Rear', morder: 'MO', t: '2026-10-23T22:00:00Z' },
        /* 非目标穴位，exportFull 不该输出 */
        { side: 'Rear', panel, seq: 7, machine: 'M', res: true, fixture: 'FX', product: 'P', station: 'S', procn: 'AOI-Rear', morder: 'MO', t: '2026-10-23T22:00:00Z' }
      ],
      spi: [{ panel, seq: 280, res: true, fixture: 'FX', product: 'P', station: 'S', t: '2026-10-23T21:00:00Z' }],
      dims: { board: [], sub: [], mat: [] }
    },
    be: { stations: [], defects: [] },
    chAoi: [
      { panelcode: panel, modid: '280', loc: 'J_ANT14', comp: 'X', res: 'OK', defect: '',
        OffsetX: '20.931', OffsetX_LSL: '-75', OffsetX_USL: '75',
        OffsetY: '1.2', OffsetY_LSL: '-200', OffsetY_USL: '200',
        Rotation: '0.4', Rotation_USL: '5', Lift: '0.1', BodyLift_USL: '1.5',
        Height: '0.09', Height_LSL: '0.05', Height_USL: '0.15', t: '2026-10-23 22:00:00' },
      /* 同板别的穴位：exportFull 不该输出它的测量值 */
      { panelcode: panel, modid: '7', loc: 'J_ANT14', comp: 'X', res: 'OK', defect: '',
        OffsetX: '9.9', OffsetX_LSL: '-75', OffsetX_USL: '75', t: '2026-10-23 22:00:00' },
      /* 测量值为空串：必须当成没测 */
      { panelcode: panel, modid: '280', loc: 'J_ANT15', comp: 'Y', res: 'OK', defect: '',
        OffsetX: '', OffsetX_LSL: '', OffsetX_USL: '', t: '2026-10-23 22:00:00' }
    ],
    chNeighborAoi: [],
    chSpi: [
      /* SPI 用板号基码 + 穴位 */
      { barcode: base, modid: '280', comp: 'C1', pad: '1', res: 'PASS',
        vol: '109.87', volUsl: '160', volLsl: '40', area: '96.7', areaUsl: '160', areaLsl: '40',
        hgt: '0.0883', hgtUsl: '160', hgtLsl: '40', offx: '-0.0218', offy: '-0.0183',
        offxSpec: '-6.595', offySpec: '-4.959', t: '2026-10-23 21:57:25' },
      { barcode: base, modid: '7', comp: 'C2', pad: '1', res: 'PASS',
        vol: '100', volUsl: '160', volLsl: '40', t: '2026-10-23 21:57:25' }
    ],
    /* 让 neighStations 存在，避免 exportFull 走异步补取 */
    neighStations: []
  };
}

/* 1. 邻居取的是 pcs，不是 panel */
t('neighborsPcs 是独立函数，参数名是 pcs 而不是 panel', () => {
  assert.ok(typeof T.neighborsPcs === 'function', 'neighborsPcs 必须导出');
  assert.ok(typeof T.pcsOfPanels === 'function', 'pcsOfPanels 必须导出');
  assert.ok(/neighborsPcs\(targets, N\)/.test(SRC), '函数签名应是 neighborsPcs(targets, N)');
});

/* 2. trace 默认走 pcs 口径 */
t('trace 默认走 pcs 口径，只有显式传 neighborN 才回退块数口径', () => {
  assert.ok(/const pcsMode = !o\.neighborN;/.test(SRC), 'pcsMode 判定缺失');
  assert.ok(/o\.neighborPcs\) \|\| 30/.test(SRC), '默认档位应是 30 pcs');
  assert.ok(/neighborsPcs\(rows\.filter\(r => r\.panel\), wantPcs\)/.test(SRC), '应调 neighborsPcs');
});

/* 3. 对照只用选中 pcs 当基准 */
t('对照 AOI 必须按选中 pcs 名单过滤，不许同板未选中的混进来', () => {
  assert.ok(/const keep = new Set\(\[\.\.\.nb\.before, \.\.\.nb\.after\]/.test(SRC), '缺少 pcs 名单过滤');
  assert.ok(/nAoi = raw\.filter\(r => keep\.has\(/.test(SRC), '过滤没作用到 nAoi');
});

/* 4. compare 的基准键在 pcs 模式下退化成 loc */
t('pcs 口径下 compare 用 loc 做基准键，避免同板目标/对照对不上', () => {
  assert.ok(/const keyOf = r => pcsMode \? str\(r\.loc\) : \(str\(r\.loc\) \+ '\|' \+ str\(r\.modid\)\);/.test(SRC),
    'keyOf 未按口径退化');
  assert.ok(/const pcsMode = !!o\.pcsMode;/.test(SRC), 'compare 没接 pcsMode');
});

/* 5. 目标 pcs 排除按 panel+ModuleID */
t('目标 pcs 身份是 panel+ModuleID，不是 panelcode', () => {
  assert.ok(/tgtPcs\.has\(str\(r\.panelcode\) \+ '\|' \+ str\(r\.modid\)\)/.test(SRC),
    '排除条件应按 panel+ModuleID');
  assert.ok(/if \(pcsMode\) \{\s*if \(tgtPcs && tgtPcs\.has/.test(SRC), 'pcs 分支没写进排除逻辑');
});

/* 6. exportDetail AOI 行字段数 == 表头列数 */
t('exportDetail 的 AOI 行与表头列数一致（修 17 vs 18 的错位）', () => {
  const raw = mkRaw();
  const d = T.exportDetail(raw, 'all');
  assert.strictEqual(d.head.length, 18, '表头应为 18 列');
  const aoiRows = d.rows.filter(r => r[0] === 'AOI');
  assert.ok(aoiRows.length > 0, '应该有 AOI 行');
  for (const r of aoiRows) assert.strictEqual(r.length, d.head.length, 'AOI 行字段数必须等于列数');
  const spiRows = d.rows.filter(r => r[0] === 'SPI');
  for (const r of spiRows) assert.strictEqual(r.length, d.head.length, 'SPI 行字段数必须等于列数');
});

/* 7. 空串测量值不能变成 0 */
t('空字符串的测量值不写 0，直接跳过（Number("")===0 的坑）', () => {
  const d = T.exportFull(mkRaw(), []);
  const bad = d.rows.filter(r => r[18] === '0' && r[19] === '0' && r[20] === '0');
  assert.strictEqual(bad.length, 0, '不该出现「实测 0 / 规格 0~0」的行');
  const hit = d.rows.filter(r => r[6] === 'SMT-AOI测量' && r[5] === '280' && r[17] === 'OffsetX');
  assert.strictEqual(hit.length, 1, '目标穴位 280 的 OffsetX 应只有 1 行（空串那条跳过）');
  assert.strictEqual(hit[0][18], '20.931');
  assert.strictEqual(hit[0][19], '-75');
  assert.strictEqual(hit[0][20], '75');
});

/* 8. Rotation 对称量补负 LSL */
t('Rotation 只有 USL 时自动补对称的 LSL', () => {
  const d = T.exportFull(mkRaw(), []);
  const rot = d.rows.filter(r => r[6] === 'SMT-AOI测量' && r[17] === 'Rotation');
  assert.ok(rot.length >= 1, '应有 Rotation 行');
  assert.strictEqual(rot[0][19], '-5', 'Rotation LSL 应为 -USL');
  assert.strictEqual(rot[0][20], '5');
});

/* 9. exportFull 只出目标 pcs，不出整块 panel */
t('exportFull 只输出目标 pcs 的测量值，同板其他穴位不出', () => {
  const d = T.exportFull(mkRaw(), []);
  const aoiM = d.rows.filter(r => r[6] === 'SMT-AOI测量');
  assert.ok(aoiM.length > 0, '应有 AOI 测量值行');
  for (const r of aoiM) assert.strictEqual(r[5], '280', '只应有穴位 280 的测量值');
  /* 同板穴位 7 的判定行也不该出 */
  const aoiR = d.rows.filter(r => r[6] === 'SMT-AOIRear');
  for (const r of aoiR) assert.strictEqual(r[5], '280', 'AOI 判定行也只留目标穴位');
});

/* 10. exportFull 的 SPI 用板号基码 + 穴位认目标 */
t('exportFull 的 SPI 行按「板号基码+穴位」认目标（拿 SN 比会全掉）', () => {
  const d = T.exportFull(mkRaw(), []);
  const spiM = d.rows.filter(r => r[6] === 'SMT-SPI测量');
  assert.ok(spiM.length > 0, 'SPI 测量值不该是 0 行');
  for (const r of spiM) assert.strictEqual(String(r[5]), '280', 'SPI 只留目标穴位');
  const vols = spiM.filter(r => r[17] === 'Volume%');
  assert.strictEqual(vols.length, 1);
  assert.strictEqual(vols[0][18], '109.87');
  assert.strictEqual(vols[0][19], '40');
  assert.strictEqual(vols[0][20], '160');
});

/* 11. 全链路表头与行数一致，且带口径说明 */
t('exportFull 表头 24 列、每行同长度、并给出 reason 说明边界', () => {
  const d = T.exportFull(mkRaw(), []);
  assert.strictEqual(d.head.length, 24, '表头应为 24 列');
  for (const r of d.rows) assert.strictEqual(r.length, 24, '每行都必须是 24 列');
  assert.ok(/后段测试/.test(d.reason), 'reason 要交代 BE 没有实测值这件事');
  assert.ok(/对照 pcs 只出过站/.test(d.reason), 'reason 要交代对照 pcs 的范围');
});

/* 12. 空数据不炸，且给原因 */
t('没有任何记录时 exportFull 返回 empty + 原因，不抛异常', () => {
  const raw = mkRaw();
  raw.rows = []; raw.smt = { stations: [], aoi: [], spi: [] }; raw.be = { stations: [], defects: [] };
  raw.chAoi = []; raw.chSpi = []; raw.targetPanels = []; raw.neighPcs = [];
  const d = T.exportFull(raw, []);
  assert.strictEqual(d.empty, true);
  assert.ok(d.reason && d.reason.length > 10, '必须给原因');
});

/* 13. server 路由接口 */
t('server 接 neighborPcs、kind=full，并夹住档位上限', () => {
  assert.ok(/neighborPcs/.test(SRV), 'server 没接 neighborPcs');
  assert.ok(/kind === 'full'/.test(SRV), 'server 没有 full 分支');
  assert.ok(/T\.exportFull\(hit\.raw, hit\.report\.compare\)/.test(SRV), 'full 分支没调 exportFull');
  assert.ok(/Math\.min\(500, npcs\)/.test(SRV), 'pcs 档位要夹到 500');
  assert.ok(/SN追溯_全链路_/.test(SRV), '导出文件名要能认出来');
});

/* 14. 导出入口都还在（别为了加 full 把老的删了） */
t('老的三种导出仍然存在', () => {
  assert.ok(/kind === 'detail'/.test(SRV));
  assert.ok(/kind === 'summary'/.test(SRV));
  assert.ok(/SN追溯_测试值对照_/.test(SRV));
  assert.ok(typeof T.exportDetail === 'function' && typeof T.exportSummary === 'function'
    && typeof T.exportCompare === 'function' && typeof T.exportStations === 'function');
});

/* 15. 上限常量还在，别被误删 */
t('既有上限常量仍在（MAX_AOI_ROWS / MAX_SPI_PANELS / MAX_PANELS）', () => {
  assert.ok(/const MAX_AOI_ROWS = 400000;/.test(SRC));
  assert.ok(/const MAX_PANELS = 420;/.test(SRC));
  assert.ok(/const NEIGHBOR_N = 200;/.test(SRC), '老口径常量要留着给对拍用');
});

/* 16. pcs 模式必须报出来，前端才知道用什么口径渲染 */
t('report 带 mode= pcs 与新 panels 字段，前端据此渲染', () => {
  assert.ok(/mode: pcsMode \? 'pcs' : 'panel',/.test(SRC), 'report.mode 缺失');
  assert.ok(/neighborPcs: nb\.before\.length \+ nb\.after\.length/.test(SRC), 'report.panels.neighborPcs 缺失');
  assert.ok(/neighborPcsBefore: nb\.before\.length/.test(SRC));
  assert.ok(/neighborPcsAfter: nb\.after\.length/.test(SRC));
});

console.log('');
console.log(`OK 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
