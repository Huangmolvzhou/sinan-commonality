/* v6.4：时间段不良数量分布 + 「有没有突然上升」判定
   用户需求（原话）：
     「BE 段共性分析有一个时间段不良数量分布直方图，SMT 没有增加一下。方便看时间上是不是
      突然新增的，同时判定的时候也要增加一下，有无突然上升。」

   ★ 设计原则（为什么不能只给一张柱状图）
     柱状图只能让人「用眼睛猜」。PE 真正要回答的是三件事：
       ① 这一波是「慢慢爬上来」还是「某个时刻突然冒出来」
       ② 突然点在哪（哪一天 / 哪个时段），那之后去翻换线记录、换料记录
       ③ 这个判断靠不靠得住（样本太少就不许下结论，必须说「看不出来」）

   ★ 为什么用「三分段均值」而不是线性回归
     不良条数是离散计数、经常有 0 值、还常带尖峰。回归斜率对单个尖峰极度敏感，
     会把「某天突然 200 条」说成「整体上升趋势」。三分段对比抗噪、可解释，
     而且和一线看板子的方式一致（前面一段多少、后面一段多少）。

   ★ 硬约束
     - 样本不足（总条数 < MIN_NG 或有效桶数 < MIN_BUCKETS）时，必须返回 level='unknown'
       并明说「看不出来」，绝不硬给一个「有上升」的结论。
     - 所有文案不许出现「一定 / 必然 / 证明」，只能是「看起来 / 大概率」。
*/

'use strict';

const MIN_NG = 8;        /* 少于 8 条不良，谈时间分布没有意义 */
const MIN_BUCKETS = 4;   /* 至少 4 个时间桶才谈得上「趋势」 */
const RISE_FACTOR = 2;   /* 后段均值 ≥ 前段均值 2 倍才算「明显上升」 */
const SPIKE_FACTOR = 3;  /* 单桶 ≥ 全窗中位数 3 倍算「尖峰」 */

function median(arr) {
  const a = arr.filter(x => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(arr) {
  const a = arr.filter(x => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

function n1(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

/**
 * 把「按天」或「按小时」的计数序列切成三段，比较前 1/3 与后 1/3。
 * @param {Array<{label:string, ng:number}>} buckets 按时间先后排好序
 * @returns {object} 判定结果（永不抛异常）
 */
function detectRise(buckets, opts) {
  const o = opts || {};
  const rows = (buckets || []).filter(b => b && Number.isFinite(Number(b.ng)))
    .map(b => ({ label: String(b.label || ''), ng: Number(b.ng) || 0 }));
  const total = rows.reduce((s, b) => s + b.ng, 0);
  const unit = o.unit || 'bucket';

  /* ---- 样本不足：必须说「看不出来」，不能编 ---- */
  if (total < (o.minNg || MIN_NG)) {
    return {
      level: 'unknown', rising: false, ok: false,
      text: `窗口内只有 ${total} 条不良，样本太少，看不出时间上有没有突然上升（至少需要 ${o.minNg || MIN_NG} 条才谈得上分布）。`,
      total, nBuckets: rows.length
    };
  }
  if (rows.length < (o.minBuckets || MIN_BUCKETS)) {
    return {
      level: 'unknown', rising: false, ok: false,
      text: `窗口只有 ${rows.length} 个${unit}，不足以判断趋势（至少需要 ${o.minBuckets || MIN_BUCKETS} 个）。把时间范围拉长一点再看。`,
      total, nBuckets: rows.length
    };
  }

  const vals = rows.map(b => b.ng);
  const med = median(vals);
  const mx = Math.max.apply(null, vals);
  const peak = rows[vals.indexOf(mx)];
  const k = Math.max(1, Math.floor(rows.length / 3));
  const head = mean(vals.slice(0, k));
  const tail = mean(vals.slice(vals.length - k));
  const ratio = head > 0 ? tail / head : (tail > 0 ? 99 : 1);

  /* 尖峰：单桶达到中位的 SPIKE_FACTOR 倍，且绝对量不至于太小 */
  const spikeAt = med > 0 && mx >= med * SPIKE_FACTOR && mx >= (o.minNg || MIN_NG) ? peak : null;

  /* 上升起点：从「开头那一档」抬到 2 倍以上的第一个桶，且它之后一个桶也还在那一档以上。
     ★ 门槛基准必须用“前段水平”，不能用整窗中位数：
       整窗中位会被后半段的高值拉高，后半段再翻 2 倍就几乎不可能达到，
       明明在上升却报不出起点（v6.4 首跑实测：level=rise 但 onset=null）。
     ★ 前段水平取前 1/3 的中位数（不是均值）：均值怕前段里混一个尖峰。
     ★ 要求「之后也高」：一次性单点尖峰不算持续上升，起点判断要稳。 */
  let onset = null;
  const headMed = median(vals.slice(0, k));
  const baseLine = headMed > 0 ? headMed : (head > 0 ? head : med);
  if (baseLine > 0) {
    const hi = baseLine * RISE_FACTOR;
    for (let i = 0; i < rows.length - 1; i++) {
      if (vals[i] >= hi && vals[i + 1] >= hi) { onset = rows[i]; break; }
    }
  }
  /* 中位为 0（大部分桶没有不良）时，用「第一个非 0 桶」当起点，并说明是「从无到有」 */
  let fromZero = false;
  if (!onset && med === 0 && mx > 0) {
    onset = rows[vals.indexOf(mx)];
    fromZero = true;
  }

  let level, rising, text;
  if (ratio >= RISE_FACTOR) {
    level = 'rise'; rising = true;
    text = `后段（最近约 1/3 的${unit}）平均每天 ${n1(tail)} 条，是前段（${n1(head)} 条）的 ${n1(ratio)} 倍 —— `
      + `这条曲线是往上走的，属于「突然多了」，不是一直这样。`
      + (onset ? `上升大致从「${onset.label}」开始，去翻那前后的换线 / 换料 / 换载具记录。` : '');
  } else if (ratio >= 1.3) {
    level = 'slight'; rising = false;
    text = `后段平均 ${n1(tail)} 条 vs 前段 ${n1(head)} 条（${n1(ratio)} 倍），略有抬头但没到翻倍，`
      + `只能算「可能比之前多一点」，不足以当成突发。`;
  } else if (ratio <= 1 / RISE_FACTOR) {
    level = 'fall'; rising = false;
    text = `后段平均 ${n1(tail)} 条，比前段（${n1(head)} 条）还低 —— 这条曲线在往下走，说明是早先冒出来、后来压下去的。`;
  } else {
    level = 'flat'; rising = false;
    text = `前段 ${n1(head)} 条、后段 ${n1(tail)} 条，基本在一个水平上 —— 时间分布是平的，没有突然上升。`;
  }

  /* 尖峰单独说一句：即使整体不升，也要把「某一天特别多」点出来 */
  if (spikeAt && level !== 'rise') {
    text += ` 但「${spikeAt.label}」单${unit}有 ${spikeAt.ng} 条，是窗口内中位数（${n1(med)}）的 `
      + `${n1(med > 0 ? spikeAt.ng / med : 0)} 倍，属于孤立尖峰，值得单独看一眼那天。`;
  }

  return {
    level, rising, ok: true,
    total, nBuckets: rows.length,
    median: Number(med.toFixed(1)), peak: { label: peak.label, ng: peak.ng, idx: vals.indexOf(mx) },
    headMean: Number(head.toFixed(1)), tailMean: Number(tail.toFixed(1)),
    ratio: Number(ratio.toFixed(2)),
    onset: onset ? { label: onset.label, ng: onset.ng, fromZero } : null,
    spike: spikeAt ? { label: spikeAt.label, ng: spikeAt.ng, times: Number((med > 0 ? spikeAt.ng / med : 0).toFixed(1)) } : null,
    unit,
    text
  };
}

/** 按 24 小时做班次集中度：看是不是集中在某一班 */
function shiftFocus(byHour) {
  const h = (byHour || []).map(x => Number(x) || 0);
  const tot = h.reduce((a, b) => a + b, 0);
  if (!tot) return null;
  const meanH = tot / 24;
  let peakH = 0;
  for (let i = 1; i < 24; i++) if (h[i] > h[peakH]) peakH = i;
  /* 班次按 8 小时切：夜班 00-08、早班 08-16、中班 16-24 */
  const shift = [
    { key: 'night', label: '夜班 00–08', n: h.slice(0, 8).reduce((a, b) => a + b, 0) },
    { key: 'morning', label: '早班 08–16', n: h.slice(8, 16).reduce((a, b) => a + b, 0) },
    { key: 'evening', label: '中班 16–24', n: h.slice(16, 24).reduce((a, b) => a + b, 0) }
  ].sort((a, b) => b.n - a.n);
  return {
    total: tot, peakHour: h[peakH] > 0 ? peakH : null,
    peakRatio: meanH > 0 ? Number((h[peakH] / meanH).toFixed(2)) : null,
    topShift: shift[0],
    shiftShare: tot > 0 ? Number((shift[0].n / tot).toFixed(3)) : 0,
    shifts: shift
  };
}

module.exports = { detectRise, shiftFocus, median, mean, MIN_NG, MIN_BUCKETS, RISE_FACTOR, SPIKE_FACTOR };
