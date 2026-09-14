@echo off
setlocal enabledelayedexpansion

set "PROJECT_DIR=C:\Users\Administrator\Documents\deepagent\deepagents"
set "WRAPPER_SCRIPT=%PROJECT_DIR%\launch_dcode.py"
set "VENV_PYTHON=%PROJECT_DIR%\libs\code\.venv\Scripts\python.exe"

:: 模型配置需通过环境变量设置
:: 启动前先运行:
::   set OPENAI_API_KEY=你的deepseek_api_key
::   set OPENAI_BASE_URL=https://api.deepseek.com/v1

if "%OPENAI_API_KEY%"=="" (
    echo [ERROR] 未设置 OPENAI_API_KEY
    echo 请在终端中先执行:
    echo   set OPENAI_API_KEY=你的deepseek_api_key
    pause
    exit /b 1
)
if "%OPENAI_BASE_URL%"=="" set "OPENAI_BASE_URL=https://api.deepseek.com/v1"

echo [Deep Agents Code] Starting...
echo [Model] deepseek-v4-flash
echo.
"%VENV_PYTHON%" "%WRAPPER_SCRIPT%" %*

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] dcode exit code: %ERRORLEVEL%
    pause
)
