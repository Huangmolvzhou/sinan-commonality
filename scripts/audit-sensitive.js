#!/usr/bin/env node
/* 敏感串自检：扫仓库里所有被 git 跟踪的文件，看有没有漏掉的内网地址 / 料号 / 个人信息。
   为什么要单独做成脚本：README 里写正则字面量会让 README 自己命中自己，
   做成脚本后 README 只说「跑它」，不再含敏感串。
   用法：node scripts/audit-sensitive.js        → 0 表示干净，非 0 表示有命中 */
const { execSync } = require('child_process');
const fs = require('fs');

const RULES = [
  ['内网 IPv4', /\b172\.16\.\d{1,3}\.\d{1,3}\b/],
  ['公司邮箱域名', /@amphenol/i],
  ['公司名', /安费诺|Amphenol/i],
  ['产线机台名', /\b[SN]\d-UAT\d\b|\bS\d-SIDEWALK/i],
  ['贴片机名', /\bNPM-\d/i],
  ['SMT 料号', /\bC-[A-Z]\d{3}-\d{2}-[0-9A-Z]{3}-\d{2}\b/],
  ['BE 料号', /\bCPJ\d{3}\b/],
  ['后段成品条码', /\bGTTH[A-Z0-9]{8,}\b/],
  ['面板码', /\bJ\d{3}A\d{2}MC\d{4,}\b/],
  ['点位名', /CL_ANT4/],
  ['手机号', /\b1[3-9]\d{9}\b/],
  ['个人邮箱', /Morgan\.Kang@/i],
  ['工位码', /\b[ZS]DS?\d{2}[A-Z0-9]{3,}AVI\d{4}/],
];

/* ★ 必须排除自己：规则表里写着这些敏感串的字面量。
   这是所有密钥扫描器的通用做法（gitleaks 的规则文件同样含模式本身）——
   扫别人之前先别扫自己。 */
const SELF = 'scripts/audit-sensitive.js';
const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n').map(s => s.trim()).filter(Boolean)
  .filter(f => f !== SELF);

let total = 0;
for (const [name, re] of RULES) {
  const hits = [];
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    if (!re.test(txt)) continue;
    txt.split('\n').forEach((ln, i) => {
      re.lastIndex = 0;
      if (re.test(ln)) hits.push(`${f}:${i + 1}  ${ln.trim().slice(0, 90)}`);
    });
  }
  if (hits.length) {
    total += hits.length;
    console.log(`\n✗ ${name}：${hits.length} 处`);
    hits.slice(0, 20).forEach(h => console.log('   ' + h));
    if (hits.length > 20) console.log(`   …还有 ${hits.length - 20} 处`);
  }
}

console.log('\n' + '─'.repeat(60));
if (total === 0) console.log(`✓ 干净：${files.length} 个跟踪文件，13 类敏感串全部 0 命中`);
else console.log(`✗ 共 ${total} 处命中，需要处理`);
process.exit(total === 0 ? 0 : 1);
