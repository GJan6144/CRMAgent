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

:: 定位 node：优先 PATH，其次 Node.js 默认安装目录
set "NODE=node"
where node >nul 2>&1 || set "NODE=%ProgramFiles%\nodejs\node.exe"

echo ====================================
echo   CRM Agent Frontend
echo ====================================
echo   Server: http://localhost:%CRM_PORT%
echo   API:    /api/agent/* -^> 127.0.0.1:8765
echo ====================================
echo.

cd /d "%CRM_DIR%"

:: 首次运行：仅当 node_modules 缺失时才安装依赖
if not exist "node_modules" (
    echo [!] 未找到 node_modules，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [x] 依赖安装失败：请检查 Node.js / npm 环境
        pause
        exit /b 1
    )
)

:: 直接调用项目内的 next 入口，不经过 npm run
:: 避免 PATH 中损坏或错位的 npm shim 影响启动
"%NODE%" "%CRM_DIR%node_modules\next\dist\bin\next" dev -p %CRM_PORT%

pause
