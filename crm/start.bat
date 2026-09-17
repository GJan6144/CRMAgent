@echo off
chcp 65001 >nul
setlocal

:: 路径全部由脚本自身位置推导，仓库移动后仍可直接运行
set "CRM_DIR=%~dp0"
set "CRM_PORT=3100"

:: 释放端口
for /f "tokens=5" %%a in ('netstat -ano ^| find ":%CRM_PORT%" ^| find "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: 定位 npm：优先 PATH，其次 Node.js 默认安装目录
set "NPM=npm"
where npm >nul 2>&1 || set "NPM=%ProgramFiles%\nodejs\npm.cmd"

echo ====================================
echo   CRM Agent Frontend
echo ====================================
echo   Server: http://localhost:%CRM_PORT%
echo   API:    /api/agent/* -^> 127.0.0.1:8765
echo ====================================
echo.

cd /d "%CRM_DIR%"

if not exist "node_modules" (
    echo [!] 首次运行，正在安装依赖...
    call "%NPM%" install
)

call "%NPM%" run dev
pause
