@echo off
rem MusicDedup dev 启动器
rem 删除全局 ELECTRON_RUN_AS_NODE（本机存在该变量，Electron 判断"存在即进纯 Node 模式"，
rem 空字符串也算），否则 electron.exe 会退化为纯 Node。仅供 Start Menu 快捷方式/
rem 任务栏固定后启动使用；npm start 走 scripts/run-electron.mjs 已自带同样处理。
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0..\electron\main.js"
