@echo off
chcp 65001 >nul
set "BASE=%~dp0"
if not exist "%BASE%tools\lock.py" set "BASE=%~dp0..\"
python "%BASE%tools\status.py" %*
pause
