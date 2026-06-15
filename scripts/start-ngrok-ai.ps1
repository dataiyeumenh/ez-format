param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [int]$GatewayPort = 8010,
    [string]$Model = "qwen2.5:7b",
    [string]$OllamaBaseUrl = "http://127.0.0.1:11434",
    [string]$NgrokDomain = "",
    [string]$NgrokAuthtoken = "",
    [switch]$ExposeOllamaDirect
)

$ErrorActionPreference = "Stop"

function Test-HttpOk {
    param(
        [string]$Uri,
        [int]$TimeoutSec = 3
    )
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Wait-HttpOk {
    param(
        [string]$Uri,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk -Uri $Uri -TimeoutSec 2) {
            return $true
        }
        Start-Sleep -Milliseconds 750
    }
    return $false
}

function Resolve-NgrokExe {
    $command = Get-Command "ngrok" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $roots = @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"),
        $env:LOCALAPPDATA,
        $env:ProgramFiles
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    foreach ($root in $roots) {
        $candidate = Get-ChildItem -LiteralPath $root -Recurse -Filter "ngrok.exe" -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($candidate) {
            return $candidate.FullName
        }
    }

    throw "Không tìm thấy ngrok.exe. Cài bằng: winget install -e --id Ngrok.Ngrok"
}

function Stop-NgrokProcesses {
    Get-CimInstance Win32_Process |
        Where-Object { $_.Name -ieq "ngrok.exe" } |
        ForEach-Object {
            Write-Host "[ngrok] Stopping stale PID $($_.ProcessId)" -ForegroundColor Yellow
            Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
        }
}

function Get-NgrokPublicUrl {
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $response = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
            $https = $response.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1
            if ($https -and $https.public_url) {
                return [string]$https.public_url
            }
        } catch {
        }
        Start-Sleep -Seconds 1
    }
    return ""
}

$resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$artifactDir = Join-Path $resolvedRepo ".artifacts\ngrok-ai"
$localAiDir = Join-Path $resolvedRepo ".artifacts\local-ai"
$tokenPath = Join-Path $localAiDir "AI_GATEWAY_TOKEN.txt"
$ngrokOutLog = Join-Path $artifactDir "ngrok-ai.out.log"
$ngrokErrLog = Join-Path $artifactDir "ngrok-ai.err.log"
$envFile = Join-Path $artifactDir "vps-ai.env"
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  EzFormat — Local AI Gateway via ngrok" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""

$ngrokExe = Resolve-NgrokExe
Write-Host "[ngrok] $ngrokExe" -ForegroundColor Green
& $ngrokExe version

if ($NgrokAuthtoken) {
    Write-Host "[ngrok] Configuring authtoken" -ForegroundColor Yellow
    & $ngrokExe config add-authtoken $NgrokAuthtoken | Out-Host
}

$ollamaTagsUrl = "$($OllamaBaseUrl.TrimEnd('/'))/api/tags"
if (-not (Test-HttpOk -Uri $ollamaTagsUrl -TimeoutSec 3)) {
    throw "Ollama chưa sẵn sàng tại $ollamaTagsUrl. Bật Ollama hoặc chạy Desktop shortcut AI Local trước."
}
Write-Host "[ollama] Ready: $OllamaBaseUrl" -ForegroundColor Green

if ($ExposeOllamaDirect) {
    Write-Host "[WARN] Đang expose trực tiếp Ollama 11434. Endpoint này KHÔNG có auth mặc định." -ForegroundColor Red
    $targetPort = 11434
    $targetUrl = "http://127.0.0.1:11434"
} else {
    $gatewayScript = Join-Path $resolvedRepo "scripts\start-local-ai-gateway.ps1"
    Write-Host "[gateway] Starting local AI Gateway on port $GatewayPort..." -ForegroundColor Yellow
    & $gatewayScript `
        -RepoRoot $resolvedRepo `
        -Port $GatewayPort `
        -Model $Model `
        -OllamaBaseUrl $OllamaBaseUrl `
        -TokenPath $tokenPath `
        -Restart | Out-Host

    if (-not (Wait-HttpOk -Uri "http://127.0.0.1:$GatewayPort/docs" -TimeoutSeconds 30)) {
        throw "AI Gateway chưa sẵn sàng tại http://127.0.0.1:$GatewayPort/docs"
    }
    $targetPort = $GatewayPort
    $targetUrl = "http://127.0.0.1:$GatewayPort"
}

Stop-NgrokProcesses
Remove-Item -LiteralPath $ngrokOutLog, $ngrokErrLog -Force -ErrorAction SilentlyContinue

$ngrokArgs = @("http", "http://127.0.0.1:$targetPort", "--log=stdout")
if ($NgrokDomain) {
    $ngrokArgs += "--domain=$NgrokDomain"
}

Write-Host "[ngrok] Starting tunnel to $targetUrl..." -ForegroundColor Yellow
Start-Process `
    -FilePath $ngrokExe `
    -ArgumentList $ngrokArgs `
    -RedirectStandardOutput $ngrokOutLog `
    -RedirectStandardError $ngrokErrLog `
    -WindowStyle Hidden | Out-Null

$publicUrl = Get-NgrokPublicUrl
if (-not $publicUrl) {
    Write-Host "[ERROR] Không lấy được ngrok URL từ http://127.0.0.1:4040/api/tunnels" -ForegroundColor Red
    Write-Host "Xem log: $ngrokOutLog ; $ngrokErrLog" -ForegroundColor Yellow
    exit 1
}

if ($ExposeOllamaDirect) {
    $aiBaseUrl = "$publicUrl/api/generate"
    $envContent = @"
# WARNING: direct Ollama exposure has no Bearer auth by default.
OLLAMA_BASE_URL=$publicUrl
"@
} else {
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $aiBaseUrl = "$publicUrl/v1/misa/suggest-mapping"
    $envContent = @"
AI_PROVIDER=remote_http
AI_BASE_URL=$aiBaseUrl
AI_TOKEN=$token
AI_MAPPING_TIMEOUT_SECONDS=15
AI_REQUIRED=false
"@
}

$envContent | Set-Content -LiteralPath $envFile -Encoding UTF8

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  ✅ Ngrok AI tunnel ready" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "Public URL: $publicUrl" -ForegroundColor White
Write-Host "Target:     $targetUrl" -ForegroundColor White
if (-not $ExposeOllamaDirect) {
    Write-Host ""
    Write-Host "Cấu hình VPS/converter dùng:" -ForegroundColor Yellow
    Write-Host "AI_PROVIDER=remote_http"
    Write-Host "AI_BASE_URL=$aiBaseUrl"
    Write-Host "AI_TOKEN=<redacted from $tokenPath>"
    Write-Host "AI_MAPPING_TIMEOUT_SECONDS=15"
    Write-Host "AI_REQUIRED=false"
}
Write-Host ""
Write-Host "Đã ghi file env local: $envFile" -ForegroundColor Cyan
Write-Host "Ngrok dashboard: http://127.0.0.1:4040" -ForegroundColor Cyan
Write-Host "Logs: $ngrokOutLog ; $ngrokErrLog" -ForegroundColor Cyan
Write-Host "PC này phải bật và ngrok process phải sống thì VPS mới gọi được." -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
