#!/bin/bash
# 司南 SINAN · 首次配置数据库连接（mac 双击运行）
cd "$(dirname "$0")" || exit 1
NODE=""
for c in "$(command -v node)" /usr/local/bin/node /opt/homebrew/bin/node; do
  [ -n "$c" ] && [ -x "$c" ] && NODE="$c" && break
done
if [ -z "$NODE" ]; then
  echo "没找到 Node.js。先装一次：打开 https://nodejs.org 下载 LTS 版，一路下一步。"
  read -r -p "按回车关闭…" _
  exit 1
fi
NODE_PATH="$PWD/node_modules" "$NODE" lib/setup_config.js
echo ""
read -r -p "配置完成，按回车关闭这个窗口…" _
