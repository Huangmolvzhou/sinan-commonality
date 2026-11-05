/* ────────────────────────────────────────────────────────────────
   后段编码解析（v6.0 新增）

   后段的过站表 `TRS_Busi_StationTrace.SerialNo` 和不良表
   `T_Bllb_TestDefectInformation.ResCode` 里存的是一根**结构化编码**，
   不是随手起的名字。以前整根字符串被当成「工位」塞进一个维度，等于没拆，
   所以算出来的「工位集中」其实是「这台机这个工位」的混合体，看不出真问题。

   实测格式（2026-10 全量抽样，40 个样本里 252/400 命中，其余是 N54 那种
   不带 `-穴位轨道` 尾巴的变体）：

       ZDA1LAB2VSWR0004-01R
       └┬┘└──┬─┘└┬─┘└┬─┘└┬┘└┬┘
       ZD  机台  工序  工位 穴位 轨道
           LINE-B  VSWR 0004  01   R

   拆出来以后，VSWR 工序 30 天全量（248 万过站行 / 5,534 条不良）算得出：
     工位 0011 → 2.16×、0012 → 1.99×；机台 N46UAT1 → 9.43×；
     而穴位（01/02/03 各 33%，1.01×）和轨道（R/L 各半，1.07×）是均匀的 ——
     这正是「设备号 + 哪个 holder 集中」要说的话。
   ──────────────────────────────────────────────────────────────── */

/* 工序关键字按长度倒序排，避免 `BEND` 抢在 `BENDING` 前面、`AVI` 抢在 `AVIEB` 前面 */
const PROC_TOKENS = ['SENSITIVITY', 'PRESSURE', 'BENDING', 'LEAKAGE', 'PACKING', 'AVIEB', 'VSWR', 'BEND', 'AVI', 'ICT'];

const PROC_CN = {
  VSWR: '驻波 VSWR',
  AVI: '成品目视 AVI',
  AVIEB: '成品目视 AVI-EB',
  BEND: '弹性 Bending',
  BENDING: '弹性 Bending',
  ICT: 'ICT 电测',
  LEAKAGE: '气密 Leakage',
  PRESSURE: '保压 Pressure',
  SENSITIVITY: '灵敏度 Sensitivity',
  PACKING: '包装 Packing'
};

/* 编码前缀：实测有 ZD / SD / S / 无 四种写法 */
const PREFIX = /^(?:ZD|SD|S)(?=[A-Z]\d)/;

/**
 * 把 `ZDA1LAB2VSWR0004-01R` 拆成 { machine, proc, holder, seat, lane }。
 * 拆不出来返回 null（调用方负责计数、不要瞎猜）。
 */
function parse(raw) {
  const code = String(raw || '').toUpperCase().trim();
  if (!code) return null;

  const body = code.replace(PREFIX, '');

  /* 找工序关键字：从后往前找第一个能对上的（机台名里也可能出现字母，但不会出现工序词） */
  let hit = null;
  let hitAt = -1;
  for (const tk of PROC_TOKENS) {
    const i = body.indexOf(tk);
    if (i > 0 && (hitAt < 0 || i + tk.length > hitAt + hit.length)) {
      hit = tk;
      hitAt = i;
    }
  }
  if (!hit) return null;

  const machRaw = body.slice(0, hitAt);
  let tail = body.slice(hitAt + hit.length);

  /* 尾巴形如 `0004-01R` / `0004` / `00CE`（Packing 这种没有穴位） */
  let holder = '';
  let seat = '';
  let lane = '';
  const m = /^(\d+)(?:-(\d+))?([A-Z]+)?$/.exec(tail);
  if (m) {
    holder = m[1];
    seat = m[2] || '';
    lane = m[3] || '';
  } else {
    /* 拆不动就把尾巴原样当工位，宁可留信息也不要丢 */
    holder = tail;
  }

  /* 机台名归一：`ABCDEF1` → `ABC-DEF1`、`N46LAT2` → `N46-LAT2`、`ABCDEFG1` → `ABC-DEFG1`
     —— 和过站表 MachineType 列的写法对齐（实测一致） */
  const mm = /^([A-Z]{1,2}\d+)(.+)$/.exec(machRaw);
  const machine = mm ? mm[1] + '-' + mm[2] : machRaw;

  return { code, machine, proc: hit, holder, seat, lane };
}

/** 工序中文名，取不到就原样返回 */
function procCn(p) { return PROC_CN[p] || p || ''; }

/* 后段真正能算共性的维度（v6.0 定稿）。
   ★ 已删掉：工单 / 产品 / 工序 / 不良现象 / 板上点位 ——
     这几项是「查之前就知道的」，算出来必定 100%、零信息量；
     工单更是每个几十 K 板，占比永远接近平均，说了等于没说。
   ★ 载具 / 钢网：实测后段过站表 `FixtureCode` / `SteelCode` 在 VSWR 工序
     248 万行里 100% 为空，物理上没有，必须回 SMT 段看。
   ★ 生产小时不在这个文件里：它来自过站时间而不是编码，由 be_engine 的
     hourDim() 单独算（分母是切片时按小时数出来的，见 be_collect.hourShards）。 */
const DIMS = [
  { key: 'machine', label: '测试机台', from: 'parse', get: p => p.machine },
  { key: 'holder', label: '工位（holder）', from: 'parse', get: p => p.holder },
  { key: 'seat', label: '穴位', from: 'parse', get: p => p.seat, minLift: 1.3 },
  { key: 'lane', label: '轨道', from: 'parse', get: p => p.lane, minLift: 1.3 }
];

module.exports = { parse, procCn, DIMS, PROC_TOKENS, PROC_CN };
