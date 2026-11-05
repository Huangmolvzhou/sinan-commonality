/* ================================================================
   明细保留期探针 + 窗口体检
   —— MES 的两张 AOI 主表（TS_AOI_Rear / TS_AOI_Front）体积太大，
      运维只保留约 26 天明细；维修表（*_Repair）却留着好几年。
      于是「选一个两个月前的窗口」会出现：维修表有十几万条，
      但主表 JOIN 不上 → 机台/点位/现象三个下拉全空，
      界面上看起来像工具坏了。这里把主表的实际保留期问出来，
      让前端能明确告诉用户「这段数据已经被清理了」，而不是静默空白。
   ★ 只读；MIN/MAX 走索引约 50ms，结果缓存 10 分钟
   ================================================================ */
const CONN = require('../conn');
const q = CONN.q;

const TBL = {
  rear: { main: 'TS_AOI_Rear', repair: 'TS_AOI_Rear_Repair' },
  front: { main: 'TS_AOI_Front', repair: 'TS_AOI_Front_Repair' }
};
const TTL = 10 * 60e3;
const spanCache = {};    // side -> { at, val }
const winCache = {};     // side|t0|t1 -> { at, val }

function sideKey(side) {
  return side === 'front' ? 'front' : 'rear';
}

/* mssql 把 datetime 直接返回成 Date 对象，String(Date) 是 "Mon Sep 28 2026 …"，
   不能直接拿来比大小（字符串比较会得出完全错误的结论）→ 一律格式化成 YYYY-MM-DD */
function fd(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v).slice(0, 10);
}

/* 主表还剩哪一段（最早 / 最晚一条 CreateTime）
   ★ v6.0：原来是 SELECT MIN(CreateTime), MAX(CreateTime) FROM 主表 —— 没有 WHERE，
     要在 2 亿行的 TS_AOI_Rear 上把索引扫两头。改成 TOP 1 ... ORDER BY CreateTime
     各取一端，实测 253ms → 71ms，而且加了 NOLOCK 不会去等别人的锁。 */
async function probe(side) {
  const key = sideKey(side);
  const hit = spanCache[key];
  if (hit && Date.now() - hit.at < TTL) return hit.val;
  const T = `dbo.${TBL[key].main}`;
  /* ★ 这里不能 .catch(()=>[]) 把「连不上」吞成「表里 0 行」——
     吞掉之后 checkWindow 会以为主表是空的，前端弹「已经被 MES 清理」，
     而真实原因是网络/VPN 断了或账号没权限。让错误往上抛，由调用方分辨。 */
  const [lo, hi] = await Promise.all([
    q(`SELECT TOP 1 CreateTime t FROM ${T} WITH(NOLOCK) ORDER BY CreateTime ASC`),
    q(`SELECT TOP 1 CreateTime t FROM ${T} WITH(NOLOCK) ORDER BY CreateTime DESC`)
  ]);
  const min = fd((lo[0] || {}).t), max = fd((hi[0] || {}).t);
  const val = {
    side: key,
    table: TBL[key].main,
    min, max,
    days: min ? Math.floor((Date.now() - new Date(min + 'T00:00:00').getTime()) / 86400e3) : null
  };
  spanCache[key] = { at: Date.now(), val };
  return val;
}

async function probeAll() {
  /* 单边失败不影响另一边：前端只用它给日期框设 min，拿不到就不设 */
  const [rear, front] = await Promise.all([
    probe('rear').catch(e => ({ side: 'rear', min: null, max: null, err: String(e.message || e).slice(0, 200) })),
    probe('front').catch(e => ({ side: 'front', min: null, max: null, err: String(e.message || e).slice(0, 200) }))
  ]);
  return { rear, front };
}

/* 这个查询窗口落在保留期内吗？
   warn    = 开始时间早于主表最早一条 → 有数据已经被清理
   partial = 结束时间晚于主表最早一条 → 窗口有一部分还查得到
   repairN = 维修表在这个窗口里有多少条（主表查不到时的对照，证明「确实有不良，只是明细没了」） */
async function checkWindow(side, t0, t1) {
  const key = sideKey(side);

  /* ★ 还没配数据库时不能报「明细已被清理」——那会让第一次打开的人以为工具坏了。
     之前 probe() 的 .catch(()=>[]) 把「连不上」吞成了「表里 0 行」，
     于是前端弹出黄色告警「AOI 明细主表是空的」。
     现在先看配置：没配就明确说「还没配」，前端那边 warn=false 就不弹这个框，
     顶上那条「数据库还没配置」的提示已经足够。 */
  if (!CONN.isConfigured()) {
    return { ok: false, warn: false, configured: false, reason: 'db_not_configured',
             msg: '数据库还没配置，暂时读不到保留期。' };
  }

  let span;
  try { span = await probe(key); }
  catch (e) {
    /* 连不上 / 没权限 / VPN 没开 —— 都不是「数据被清理」，别把用户引到错误方向 */
    spanCache[key] = null;
    return { ok: false, warn: false, reason: 'db_unreachable', err: String(e.message || e).slice(0, 200),
             msg: '连不上 MES 数据库，暂时读不到保留期。先确认 VPN／网络，再看账号有没有只读权限。' };
  }
  if (!span.min) return { ok: true, side: key, min: null, max: null, warn: false, partial: false,
                          repairN: null, reason: 'empty_table',
                          msg: 'AOI 明细主表是空的，暂时查不到任何数据。' };

  const d0 = String(t0).slice(0, 10), d1 = String(t1).slice(0, 10);
  const warn = d0 < span.min;
  const partial = warn && d1 >= span.min;
  const out = { ok: true, side: key, table: span.table, min: span.min, max: span.max, days: span.days, warn, partial, repairN: null, msg: '' };
  if (!warn) return out;

  const ck = key + '|' + d0 + '|' + d1;
  const hit = winCache[ck];
  if (hit && Date.now() - hit.at < TTL) { out.repairN = hit.val; }
  else {
    try {
      const rows = await q(
        `SELECT COUNT(*) n FROM dbo.${TBL[key].repair} WITH(NOLOCK) WHERE CreateTime >= @t0 AND CreateTime < @t1`,
        { t0: d0, t1: d1 }
      );
      out.repairN = (rows[0] || {}).n || 0;
      winCache[ck] = { at: Date.now(), val: out.repairN };
    } catch (e) { out.repairN = null; }
  }

  const hasRepair = out.repairN != null && out.repairN > 0;
  out.msg = 'MES 的 AOI 明细主表只保留最近 ' + span.days + ' 天（' + span.min + ' 起），'
    + d0 + ' 的数据已经被清理掉了。'
    + (hasRepair ? '维修记录表里这段还有 ' + out.repairN.toLocaleString() + ' 条不良——不良确实发生过，但对应的机台/穴位/点位明细已经不在库里，工具无法再做共性分析。' : '')
    + (partial ? '这个窗口跨过了保留期边界，工具只能分析 ' + span.min + ' 之后的部分，结论会偏。建议把开始时间改到 ' + span.min + ' 之后。' : '');
  return out;
}

module.exports = { probe, probeAll, checkWindow };
