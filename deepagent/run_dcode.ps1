# Deep Agents Code (dcode) launcher with DeepSeek v4 Flash
# Uses Python wrapper to properly register provider profile
$projectDir = "C:\Users\Administrator\Documents\deepagent\deepagents"
$venvPython = Join-Path $projectDir "libs\code\.venv\Scripts\python.exe"
$wrapperScript = Join-Path $projectDir "launch_dcode.py"

# 模型配置需通过环境变量设置
# 启动前先运行:
#   $env:OPENAI_API_KEY = "你的deepseek_api_key"
#   $env:OPENAI_BASE_URL = "https://api.deepseek.com/v1"
if (-not $env:OPENAI_API_KEY) {
    Write-Host "[ERROR] 未设置 OPENAI_API_KEY"
    Write-Host "请在终端中先执行:"
    Write-Host "  `$env:OPENAI_API_KEY = `"你的deepseek_api_key`""
    Read-Host "Press Enter to exit"
    exit 1
}
if (-not $env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL = "https://api.deepseek.com/v1" }

Write-Host "[Deep Agents Code] Starting..."
Write-Host "[Model] deepseek-v4-flash"
Write-Host ""

# Pass all user arguments to the Python wrapper
if ($args.Count -gt 0) {
    & $venvPython $wrapperScript $args
} else {
    & $venvPython $wrapperScript
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] dcode exit code: $LASTEXITCODE"
    Read-Host "Press Enter to exit"
}
