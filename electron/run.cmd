@echo off
REM Launch the IWMI Hub Uploader (Electron).
REM Clears ELECTRON_RUN_AS_NODE, which some dev environments set globally and
REM which would otherwise force Electron to run as plain Node (no window).
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
call "%~dp0node_modules\.bin\electron.cmd" .
