@echo off
rem 清除宿主环境可能注入的变量，确保以完整 Electron 模式启动
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
