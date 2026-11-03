@echo off
chcp 65001 >nul
set "BASE=%~dp0"
if not exist "%BASE%tools\lock.py" set "BASE=%~dp0..\"
echo [1/3] 清残留锁
python "%BASE%tools\lock.py" clear
echo.
echo [2/3] 全局状态
python "%BASE%tools\pause.py" status
echo.
echo [3/3] 工位状态
python "%BASE%tools\status.py"
echo.
echo 下一步：逐个窗口发「上班」指令，顺序 01 -^> 02 -^> 04/05 -^> 03/06/08 -^> 07
pause
