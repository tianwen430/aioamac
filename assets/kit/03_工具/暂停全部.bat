@echo off
chcp 65001 >nul
set "BASE=%~dp0"
if not exist "%BASE%tools\lock.py" set "BASE=%~dp0..\"
python "%BASE%tools\pause.py" on
echo.
echo 已暂停。恢复请双击 恢复全部.bat
pause
