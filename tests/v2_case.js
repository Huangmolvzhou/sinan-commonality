/* 真实库端到端冒烟：LINE-A / COMP-A / 后段偏位 / 10-09~10-10
   用法：NODE_PATH=... node tests/v2_case.js
*/
const { collect } = require('../lib/v2/collect');
const E = require('../lib/v2/engine');

(async () => {
  const t0 = process.argv[2] || '2026-10-09 00:00:00';
  const t1 = process.argv[3] || '2026-10-11 00:00:00';
  const opt = {
    side: 'rear', t0, t1,
    machine: 'LINE-A', position: 'COMP-A',
    issues: ['偏位/Skewing', '偏位', '位移'],
    baseDays: 7
  };
  const t = Date.now();
  const { ctx, stats, meta } = await collect(opt);
  const total = Date.now() - t;
  console.log('=== 取数统计 ===');
  for (const s of stats) console.log(` ${s.name}: ${s.ms}ms${s.rows != null ? ' / ' + s.rows + ' 行' : ''}${s.err ? ' ERR ' + s.err : ''}`);
  console.log(' 合计', total + 'ms', JSON.stringify(meta));

  const res = E.analyze(ctx, {});
  console.log('\n=== 结论 ===');
  console.log(res.level.toUpperCase(), '|', res.headline);
  console.log('覆盖：不良', res.counts.ng, '条 / 板', res.counts.boards, '块 / 贴装机会', res.counts.placements, '次 / 追溯覆盖率', (res.coverage * 100).toFixed(1) + '%');

  console.log('\n=== 维度分布（每维取前 4）===');
  for (const d of res.dims) {
    if (d.unavailable) { console.log(`- ${d.label}: 不可用（${d.unavailable}）`); continue; }
    const top = d.items.slice(0, 4).map(i => `${i.value}: ${i.ng}/${i.exp} ${i.lift ? E.n1(i.lift) : '-'}`).join(' | ');
    console.log(`- ${d.label} [${d.kind}] 取值${d.items.length} 有不良的${d.spread} → ${top}`);
  }

  if (res.ranked.length) {
    console.log('\n=== 排行榜 ===');
    for (const r of res.ranked.slice(0, 8)) {
      console.log(` ${r.label} = ${r.item.value} : lift ${E.n1(r.item.lift)} 不良${r.item.ng} 暴露${r.item.exp} 占比${E.pct(r.item.share)}`);
    }
  }
  if (res.confoundNotes.length) console.log('\n混杂提示：\n - ' + res.confoundNotes.join('\n - '));
  if (res.spreadNotes.length) console.log('\n分散证据：\n - ' + res.spreadNotes.join('\n - '));
  console.log('\n建议：'); for (const s of res.suggestions) console.log(` - [${s.dim}] ${s.act}`);
  console.log('\n趋势：'); console.log(res.trend.rows.map(r => `${r.d} ${r.ng}条/${r.inspected}行`).join('  '));
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
