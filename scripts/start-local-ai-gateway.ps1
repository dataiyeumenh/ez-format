param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$HostName = "0.0.0.0",
    [int]$Port = 8010,
    [string]$Model = "qwen2.5:7b",
    [string]$OllamaBaseUrl = "http://127.0.0.1:11434",
    [string]$TokenPath = "",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

if (-not $TokenPath) {
    $TokenPath = Join-Path $RepoRoot ".artifacts\local-ai\AI_GATEWAY_TOKEN.txt"
}

$artifactDir = Split-Path -Parent $TokenPath
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

if (-not (Test-Path -LiteralPath $TokenPath)) {
    $bytes = New-Object byte[] 36
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    Set-Content -LiteralPath $TokenPath -Value $token -NoNewline
}

$listener = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING" | Select-Object -First 1
if ($listener) {
    $pidText = ($listener.ToString().Trim() -split "\s+")[-1]
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidText" -ErrorAction SilentlyContinue
    $isGateway = $process -and $process.CommandLine -like "*uvicorn*app.ai_gateway*"
    if (-not $Restart -or -not $isGateway) {
        throw "Port $Port is already in use by PID $pidText. Use -Restart only for an existing AI Gateway process."
    }
    Stop-Process -Id ([int]$pidText) -Force
    Start-Sleep -Seconds 1
}

$env:OLLAMA_BASE_URL = $OllamaBaseUrl
$env:OLLAMA_MODEL = $Model
$env:AI_GATEWAY_TOKEN = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
$env:AI_TIMEOUT_SECONDS = "120"

$converterDir = Join-Path $RepoRoot "converter"
$outLog = Join-Path $artifactDir "ai-gateway.out.log"
$errLog = Join-Path $artifactDir "ai-gateway.err.log"

$process = Start-Process `
    -FilePath "python" `
    -ArgumentList @("-m", "uvicorn", "app.ai_gateway:app", "--host", $HostName, "--port", "$Port") `
    -WorkingDirectory $converterDir `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Seconds 2
$health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/docs" -UseBasicParsing -TimeoutSec 5

Write-Host "AI Gateway started"
Write-Host "PID: $($process.Id)"
Write-Host "URL: http://127.0.0.1:$Port/v1/misa/suggest-mapping"
Write-Host "Token file: $TokenPath"
Write-Host "Docs HTTP: $($health.StatusCode)"
Write-Host "Logs: $outLog ; $errLog"
