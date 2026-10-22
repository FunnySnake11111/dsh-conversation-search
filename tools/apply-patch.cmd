@echo off
rem ============================================================
rem dsh-conversation-search 原生跳转补丁 一键应用
rem 用法：完全退出 DSH 后双击本文件（约 5 秒），再启动 DSH。
rem 本文件为 GBK + CRLF 编码，请勿改动编码或换行符。
rem ============================================================
cd /d "%~dp0"
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if %errorlevel%==0 goto running
echo [..] 正在应用补丁...
node .csearch-tmp\patch-app-asar.mjs
if %errorlevel%==0 goto done
echo [X] 补丁应用失败（见上方报错）。原文件未被改动。
pause
exit /b 1
:running
echo [X] DSH 正在运行，无法替换 app.asar。
echo     请先完全退出 DSH（含系统托盘图标），再重新双击本脚本。
pause
exit /b 1
:done
echo [OK] 补丁已应用。现在可以启动 DSH 了。
pause
