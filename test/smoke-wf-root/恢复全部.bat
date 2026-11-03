@echo off
chcp 65001 >nul
set "BASE=%~dp0"
if not exist "%BASE%tools\lock.py" set "BASE=%~dp0..\"
python "%BASE%tools\pause.py" off
echo.
echo 已恢复。记得逐个叫醒窗口：01 -^> 02 -^> 04/05 -^> 03/06/07
pause
