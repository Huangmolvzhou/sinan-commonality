/* Task 1（v6.1）：纯日期 / 窗口 / 小时计算 —— 全部与时区无关
   ★ 铁律：本文件禁止使用 `new Date('YYYY-MM-DDT00:00:00')` 这种本地时间构造，
     再用 toISOString() 取日期。在 Asia/Shanghai(GMT+8) 下本地 00:00 等于 UTC 前一天 16:00，
     toISOString().slice(0,10) 会直接回退一天（v6.0 的实测 bug：10-09 减 7 天算出 10-01）。
   做法：只用 Date.UTC 做「日历天序号」的加减，再格式化回字符串；
        全程不出现本地时区、不出现 DST（上海无夏令时，固定 +8）。 */

const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
const DAY_MS = 86400000;

function failDate(v) {
  const e = new Error('日期格式不对：' + JSON.stringify(v) + '（必须是 YYYY-MM-DD 且是真实存在的日期）');
  e.code = 'BAD_DATE';
  throw e;
}

/** 严格解析 YYYY-MM-DD，非法直接抛错（不自动纠偏） */
function parseDateOnly(s) {
  if (typeof s !== 'string') failDate(s);
  const m = RE_DATE.exec(s.trim());
  if (!m) failDate(s);
  const y = +m[1], mo = +m[2], d = +m[3];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  /* 回读校验：2026-02-30 会被 Date 归一成 03-02，必须拦下 */
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) failDate(s);
  return { y, m: mo, d, ms };
}

function fmtDateOnly(ms) {
  const t = new Date(ms);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/** YYYY-MM-DD + days（可为负）→ YYYY-MM-DD */
function addDays(dateOnly, days) {
  const p = parseDateOnly(dateOnly);
  const n = Number(days);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    const e = new Error('天数必须是整数：' + JSON.stringify(days));
    e.code = 'BAD_DAYS';
    throw e;
  }
  return fmtDateOnly(p.ms + n * DAY_MS);
}

/** 两端都包含的日历天数；2026-10-04→2026-10-10 = 7；结束早于开始返回 0 */
function inclusiveDayCount(startDateOnly, endDateOnly) {
  const a = parseDateOnly(startDateOnly).ms;
  const b = parseDateOnly(endDateOnly).ms;
  if (b < a) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** 解析 'YYYY-MM-DD HH:MM:SS'（也接受 T 分隔、缺秒）→ UTC 毫秒；非法返回 null */
function parseTs(s) {
  if (typeof s !== 'string') return null;
  const m = RE_TS.exec(s.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isFinite(ms) ? ms : null;
}

/** SQL 时间窗实际覆盖小时数（含末尾那一秒，所以 00:00:00–23:59:59 = 24 小时） */
function coveredHours(startTimestamp, endTimestamp) {
  const a = parseTs(startTimestamp);
  const b = parseTs(endTimestamp);
  if (a === null || b === null || b < a) return 0;
  const h = (b - a + 1000) / 3600000;
  /* 归一到 0.001 小时：既消掉「末尾 1 秒」的浮点毛刺，又不影响 6h/24h 这类整点 */
  return Math.round(h * 1000) / 1000;
}

/** 覆盖小时数折算成「天」，用于日均口径；不做四位小数取整，保住 1/24 这类精度 */
function coveredDays(startTimestamp, endTimestamp) {
  const h = coveredHours(startTimestamp, endTimestamp);
  return h > 0 ? h / 24 : 0;
}

/** 上海时区的今天（导出文件名、报告日期用），不依赖运行机器 TZ */
function todayCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

/** YYYYMMDD */
function stampCN() {
  return todayCN().replace(/-/g, '');
}

/** 上海时区的「现在」时间戳字符串，用于报告页眉 */
function nowCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
}

/* ── v6.4：Date 对象 → MES 墙钟日期 / 小时 ──
   ★ 为什么需要这两个函数：MES 的 CreateTime 经 mssql 驱动返回的是 Date 对象，
     而代码里原来写 String(r.time).slice(0,10) —— 那会把 Date 转成
     "Mon Oct 19 2026 09:55:55 GMT+0800"，slice(0,10) 得到 "Mon Oct 19"，
     拿去和 "2026-10-19" 比对永远不相等。
     （v6.4 实测出的真 bug：慢性/突发图里「本窗」的深色柱因为这个问题一根都没画出来过。）

   ★★ 为什么必须用 UTC 分量取，而不是本地 getter —— 这是实测定的，别改：
     mssql 驱动默认 useUTC:true，它把 SQL Server 的 datetime（无时区）当成 UTC 塞进 Date。
     实测对同一条记录：SQL 侧 CONVERT 出来是 '2026-10-19 01:27:17'，
     JS 侧 Date.toISOString() = '2026-10-19T01:27:17.000Z' —— UTC 分量与 DB 存值完全一致。
     而 getHours() 在本机（GMT+8）会返回 9，整体偏 +8 小时。
     一开始我用了本地 getter，结果窗口结束日是 10-25、byDay 里却冒出 10-26，
     就是 10-25 20:00 被 +8 小时推到了次日。所以这里一律用 UTC 分量。 */
function mesDayOf(v) {
  const d = v instanceof Date ? v : null;
  if (!d || isNaN(d.getTime())) {
    /* 已经是 'YYYY-MM-DD…' 字符串就原样取前 10 位，别再造一个 Date 出来 */
    const s = String(v == null ? '' : v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

/** Date 对象 → MES 墙钟小时（0–23）；非法返回 -1。同样必须用 UTC 分量 */
function mesHourOf(v) {
  const d = v instanceof Date ? v : null;
  if (d && !isNaN(d.getTime())) return d.getUTCHours();
  const s = String(v == null ? '' : v);
  const m = /[ T](\d{2}):/.exec(s);
  return m ? Number(m[1]) : -1;
}

module.exports = {
  parseDateOnly, addDays, inclusiveDayCount,
  parseTs, coveredHours, coveredDays,
  todayCN, stampCN, nowCN,
  mesDayOf, mesHourOf
};
