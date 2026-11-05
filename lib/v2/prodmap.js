/* 产品码归一化 —— 前段（SMT）和后段（BE）两个库对同一个产品的写法不一样：
   SMT：PRODUCT-A-001   BE：PRODUCT-B-001
   归一化后可以互相查到，从而给后段产品下拉补上「LINE-A」这类机型名（实测 39/39 命中）。
*/
const { q } = require('../conn');

function key(s) {
  let k = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^CP[A-Z]/.test(k)) k = 'C' + k.slice(2);   // CPX000 -> CX000
  k = k.replace(/C$/, '');                        // 尾部工艺码 C
  k = k.replace(/(7[0-9])$/, '');                 // 尾部 77 / 78 / 76
  return k;
}

const TTL = 30 * 60 * 1000;
let cache = null, cacheAt = 0;

/* 建「归一键 → {code, name}」索引；失败不抛，返回空 */
async function build() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  try {
    const rows = await q(`SELECT ProductCode AS code, MAX(ProductName) AS name
                          FROM dbo.MdcdatProduct WITH(NOLOCK)
                          WHERE ProductCode IS NOT NULL GROUP BY ProductCode OPTION (MAXDOP 4)`);
    const m = new Map();
    (rows || []).forEach(r => {
      const k = key(r.code);
      if (k && !m.has(k)) m.set(k, { code: String(r.code), name: String(r.name || '') });
    });
    cache = m; cacheAt = Date.now();
    return m;
  } catch (e) {
    cache = new Map(); cacheAt = Date.now();
    return cache;
  }
}

/* 给后段产品码补 name（机型名）。返回新的数组，不改原对象 */
async function attachNames(rows) {
  const m = await build();
  return (rows || []).map(r => {
    const hit = m.get(key(r.code));
    const name = hit && hit.name ? hit.name : '';
    return Object.assign({}, r, { name: name || (r.name && r.name !== r.code ? r.name : '') , smtCode: hit ? hit.code : '' });
  });
}

module.exports = { key, build, attachNames };
