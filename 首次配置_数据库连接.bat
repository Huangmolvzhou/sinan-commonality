@echo off
chcp 65001 >nul 2>nul
title 司南 SINAN - 首次配置数据库连接
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 Node.js。
  echo   先装一次：打开 https://nodejs.org 下载 LTS 版，一路下一步，
  echo   装完把这个窗口关掉，再重新双击一次。
  echo.
  pause
  exit /b 1
)

node lib\setup_config.js
echo.
pause
