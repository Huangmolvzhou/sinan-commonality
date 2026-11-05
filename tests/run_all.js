#!/usr/bin/env node
/* 一次性跑完所有离线回归测试。
   ★ 排除 v2_case.js —— 它要连真实 MES 数据库，不是离线测试。
   用法：
     node tests/run_all.js          跑全部
     node tests/run_all.js engine   只跑名字含 engine 的
*/
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SKIP = new Set(['run_all.js', 'v2_case.js', '_src.js']);
const filter = (process.argv[2] || '').toLowerCase();

const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.js') && !SKIP.has(f))
  .filter(f => !filter || f.toLowerCase().includes(filter))
  .sort();

if (!files.length) {
  console.log('没有匹配的测试文件');
  process.exit(1);
}

let totalPass = 0, totalFail = 0, badSuites = [];
const t0 = Date.now();

for (const f of files) {
  const t = Date.now();
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(DIR, f)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
    });
  } catch (e) {
    code = e.status || 1;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const ms = Date.now() - t;
  const tail = out.trim().split('\n').filter(Boolean).pop() || '(无输出)';

  // 各套件结尾格式统一为「OK 通过 N / 失败 M」或「FAIL ...」
  const m = tail.match(/通过\s*(\d+)\s*\/\s*失败\s*(\d+)/);
  if (m) { totalPass += Number(m[1]); totalFail += Number(m[2]); }
  if (code !== 0 || (m && Number(m[2]) > 0)) badSuites.push(f);

  const mark = (code === 0 && (!m || Number(m[2]) === 0)) ? '✓' : '✗';
  console.log(`${mark} ${f.replace(/\.js$/, '').padEnd(26)} ${String(ms).padStart(6)}ms  ${tail}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('─'.repeat(78));
console.log(`合计：${files.length} 套 / 通过 ${totalPass} / 失败 ${totalFail} / 用时 ${secs}s`);
if (badSuites.length) {
  console.log('失败套件：' + badSuites.join(', '));
  process.exit(1);
}
console.log('全部通过');
