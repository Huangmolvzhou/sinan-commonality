/* v6.1 Task 3：不良明细的「稳定哈希抽样」
   为什么要这一层（改之前先读规格书第 6 节）：
     v6.0 的 ngQuery 是 `ORDER BY r.CreateTime DESC` 再在 Node 里 slice(0,300)
     ——长窗口下等于「只看最后发生的那批不良」，而且数据库还是把明细全量回传。
   现在的做法：
     1) 抽样下沉到 SQL 侧：TOP 301 + ORDER BY HASHBYTES('MD5', CONVERT(varchar(80), r.ID))
        · 多取 1 条，用来判断「到底有没有被截断」，不用额外再跑一次 COUNT；
        · MD5 排序 = 与时间无关的稳定顺序，同一份数据永远抽到同一批；
        · 不用 NEWID()：那是随机，同一个问题两次分析结果会变，报告没法复核。
     2) 口径元数据统一由 buildMeta() 产出，页面/报告/导出共用同一份数字。
     3) 只有真被截断（拿到 301 条）才去跑 COUNT 拿总体，没截断就不查，省一次全表聚合。
   ⚠ 硬约束：不许改口径而不改文案——凡是提到抽样的地方都必须说清
     「总体 N 条 / 实际分析 M 条 / 占比 P%」，不许再出现「最近 300 条」这种时间偏置说法。 */
'use strict';
const crypto = require('crypto');

/* v6.7：300 → 1000。
   为什么原来卡 300：贴装明细（placeQuery）是「分批串行」，一批 800 板。
     实测 1000 条不良 → 795 块板 → 串行 77,109ms，浏览器等不住。
   v6.7 把 placeQuery 改成「小批 + 并发」（PLACE_CHUNK=30 / PLACE_CONC=6）：
     795 板 77,109ms → 3,438ms；278 板 15,047ms → 1,114ms。
   实测口径（PRODUCT-A-004 / COMP-B / 2026-10-19~25，总体 1,183 条）：
     N=300  28,067ms → 改后约 1.1 万 ms
     N=1000 97,422ms → 改后约 1.4 万 ms
   所以 1000 不是拍脑袋，是实测跑得动。 */
const MAX_ANALYZED = 1000;     // 单次分析最多吃多少条不良（v6.7 起 300 → 1000）
const FETCH_LIMIT = MAX_ANALYZED + 1;   // 多取 1 条用于判截断

/** SQL 侧的取数限制片段 */
function fetchLimitSql() { return 'TOP ' + FETCH_LIMIT; }

/** SQL 侧稳定排序表达式：对主键 ID 做 MD5，与时间完全无关 */
function orderBySql(alias) {
  const a = alias || 'r';
  return "ORDER BY HASHBYTES('MD5', CONVERT(varchar(80), " + a + '.ID))';
}
/* 注意：SQL 里 CONVERT(varchar(80), ID) 与下面 jsHash 的 String(id) 必须是同一段字节，
   否则「SQL 抽到的 300 条」和「Node 期望的顺序」会不一致。ID 是数值主键，两者等价。 */

function jsHash(id) {
  return crypto.createHash('md5').update(String(id)).digest('hex');
}

/** Node 侧同序参考实现：测试用，也可在离线分析里复用 */
function stableOrder(ids) {
  return (ids || []).slice().sort((x, y) => {
    const a = jsHash(x), b = jsHash(y);
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

/**
 * 抽样口径元数据（页面、报告、导出三处共用）
 * @param {number} population 该条件下不良总条数
 * @param {number} analyzed   实际进入分析的条数
 */
function buildMeta(population, analyzed) {
  const pop = Math.max(0, Number(population) || 0);
  const ana = Math.max(0, Math.min(Number(analyzed) || 0, pop || Number(analyzed) || 0));
  const truncated = pop > ana;
  const ratio = pop > 0 ? Number((ana / pop).toFixed(4)) : 0;
  return {
    population: pop,
    analyzed: ana,
    ratio,
    truncated,
    method: truncated ? 'stable_hash_id' : 'full',
    maxAnalyzed: MAX_ANALYZED,
    note: truncated
      ? '按主键哈希稳定抽取 ' + ana + ' 条进入分析（总体 ' + pop + ' 条）'
      : '全部 ' + ana + ' 条都进入了分析'
  };
}

/** 人话文案：总体 / 分析 / 占比，一句话说完 */
function describe(m) {
  if (!m) return '';
  if (!m.truncated) return '本次不良 ' + m.population + ' 条，全部纳入分析（覆盖 100%）。';
  const pct = (m.ratio * 100).toFixed(1);
  return '本次不良共 ' + m.population + ' 条，按稳定哈希抽取 ' + m.analyzed + ' 条分析（占 '
    + pct + '%）。抽样与发生时间无关，同一问题重跑会抽到同一批。'
    + '倍数与显著性的分母仍是全量口径，抽样只影响「看到哪些明细」，不影响「多少块板中招」。';
}

module.exports = {
  MAX_ANALYZED, FETCH_LIMIT,
  fetchLimitSql, orderBySql, jsHash, stableOrder, buildMeta, describe
};
