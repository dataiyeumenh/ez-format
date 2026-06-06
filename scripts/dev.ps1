param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [int]$GatewayPort = 8010,
    [int]$ConverterPort = 8000,
    [int]$BackendPort = 5000,
    [string]$Model = "qwen2.5:7b",
    [string]$OllamaBaseUrl = "http://127.0.0.1:11434",
    [string]$MisaTemplateDir = ""
)

$ErrorActionPreference = "Stop"

$resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$artifactDir  = Join-Path $resolvedRepo ".artifacts\local-ai"
$tokenPath    = Join-Path $artifactDir "AI_GATEWAY_TOKEN.txt"
$misaDir      = if ($MisaTemplateDir) { $MisaTemplateDir } else { Join-Path $resolvedRepo "converter\fixtures\templates" }

function Test-HttpOk([string]$Uri, [int]$TimeoutSec = 3) {
    try {
        $r = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
        return $r.StatusCode -ge 200 -and $r.StatusCode -lt 500
        } catch { return $false }
}

function Wait-HttpOk([string]$Uri, [int]$TimeoutSeconds = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk -Uri $Uri -TimeoutSec 2) { return $true }
        Start-Sleep -Milliseconds 750
    }
    return $false
}

Write-Host ""
Write-Host "=== EzFormat Dev (AI + Backend + Frontend) ===" -ForegroundColor Cyan
Write-Host ""

# --- 1. Ollama ---
$ollamaTagsUrl = "$($OllamaBaseUrl.TrimEnd('/'))/api/tags"
if (Test-HttpOk -Uri $ollamaTagsUrl) {
    Write-Host "[ollama] Already running" -ForegroundColor Green
} else {
    $ollamaCmd = Get-Command "ollama" -ErrorAction SilentlyContinue
    if ($ollamaCmd) {
        Write-Host "[ollama] Starting..." -ForegroundColor Yellow
        Start-Process -FilePath $ollamaCmd.Source -ArgumentList @("serve") -WindowStyle Hidden
        if (-not (Wait-HttpOk -Uri $ollamaTagsUrl -TimeoutSeconds 30)) {
            Write-Host "[ollama] Warning: could not connect. Continuing without AI." -ForegroundColor Red
        } else {
            Write-Host "[ollama] Ready" -ForegroundColor Green
        }
    } else {
        Write-Host "[ollama] Not found - converter will run WITHOUT AI" -ForegroundColor Red
    }
}

$ollamaOnline = Test-HttpOk -Uri $ollamaTagsUrl

# --- 2. AI Gateway ---
if ($ollamaOnline) {
    $gatewayScript = Join-Path $resolvedRepo "scripts\start-local-ai-gateway.ps1"
    Write-Host "[gateway] Starting AI Gateway on port $GatewayPort..." -ForegroundColor Yellow
    & $gatewayScript -RepoRoot $resolvedRepo -Port $GatewayPort -Model $Model -OllamaBaseUrl $OllamaBaseUrl -TokenPath $tokenPath -Restart
    Write-Host "[gateway] Ready" -ForegroundColor Green
} else {
    Write-Host "[gateway] Skipped (Ollama offline)" -ForegroundColor DarkGray
}

# --- 3. Resolve AI env vars for converter ---
if ($ollamaOnline -and (Test-Path -LiteralPath $tokenPath)) {
    $aiToken = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $env:AI_PROVIDER      = "remote_http"
    $env:AI_BASE_URL      = "http://127.0.0.1:$GatewayPort/v1/misa/suggest-mapping"
    $env:AI_TOKEN         = $aiToken
    $env:AI_TIMEOUT_SECONDS = "120"
    $env:AI_REQUIRED      = "false"
    Write-Host "[converter] AI enabled (gateway at port $GatewayPort)" -ForegroundColor Green
} else {
    $env:AI_PROVIDER = "disabled"
    Write-Host "[converter] AI disabled" -ForegroundColor DarkGray
}
$env:MISA_TEMPLATE_DIR = $misaDir

# --- 4. Start all services via concurrently ---
Write-Host ""
Write-Host "Starting services with concurrently..." -ForegroundColor Cyan
Write-Host "  backend   -> http://localhost:$BackendPort" -ForegroundColor Blue
Write-Host "  converter -> http://localhost:$ConverterPort" -ForegroundColor Green
Write-Host ""
Write-Host "Note: Frontend must be started separately with 'npm --prefix frontend run dev'" -ForegroundColor Yellow
Write-Host ""

Set-Location $resolvedRepo

& npx concurrently `
    "--kill-others-on-fail" `
    "--names" "backend,converter" `
    "--prefix-colors" "blue.bold,green.bold" `
    "npm --prefix backend run dev:only" `
    "npm --prefix converter run dev"
