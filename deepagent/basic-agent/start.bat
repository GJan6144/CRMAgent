@echo off
chcp 65001 >nul
setlocal

set "PROJECT_DIR=%~dp0.."
set "VENV_PYTHON=%PROJECT_DIR%\libs\deepagents\.venv\Scripts\python.exe"
set "AGENT_DIR=%~dp0"
set "AGENT_PORT=8770"

:: 释放端口
for /f "tokens=5" %%a in ('netstat -ano ^| find ":%AGENT_PORT%" ^| find "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

set PYTHONIOENCODING=utf-8

echo ====================================
echo   Basic Agent Service
echo ====================================
echo   Server: http://localhost:%AGENT_PORT%
echo   Model:  deepseek-v4-flash
echo   Docs:   http://localhost:%AGENT_PORT%/docs
echo ====================================
echo.

"%VENV_PYTHON%" "%AGENT_DIR%agent_service.py" --serve --host 127.0.0.1 --port %AGENT_PORT%
pause
