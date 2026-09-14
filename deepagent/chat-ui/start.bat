@echo off
chcp 65001 >nul
setlocal

:: 路径全部由脚本自身位置推导，仓库移动后仍可直接运行
set "CHAT_UI_DIR=%~dp0"
set "PROJECT_DIR=%~dp0.."
set "VENV_PYTHON=%PROJECT_DIR%\libs\deepagents\.venv\Scripts\python.exe"
set "CHAT_UI_PORT=8765"

:: Kill any existing process on port 8765
for /f "tokens=5" %%a in ('netstat -ano ^| find ":%CHAT_UI_PORT%" ^| find "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

set PYTHONIOENCODING=utf-8

echo ====================================
echo   Deep Agents Chat UI
echo ====================================
echo   Server: http://localhost:%CHAT_UI_PORT%
echo   Model:  deepseek-v4-flash
echo ====================================
echo.
echo Config loaded from: %CHAT_UI_DIR%.env (if exists)
echo.

"%VENV_PYTHON%" "%CHAT_UI_DIR%server.py"
pause
