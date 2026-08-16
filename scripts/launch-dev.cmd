@echo off
rem MusicDedup dev launcher (used by the Start Menu / taskbar shortcut)
rem Clears ELECTRON_RUN_AS_NODE: this machine has it set globally and Electron
rem treats its mere presence as "run as pure Node" (electron.exe becomes plain
rem Node, no GUI). npm start goes through scripts/run-electron.mjs which does
rem the same cleanup. NOTE: keep this file ASCII-only + CRLF - cmd.exe reads
rem batch files as GBK on Chinese Windows; UTF-8 Chinese comments corrupt line
rem parsing and break the launch (electron then opens the "default app" window).
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0..\electron\main.js"
