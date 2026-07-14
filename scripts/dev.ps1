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
$contextSecretPath = Join-Path $artifactDir "CONVERSION_CONTEXT_SECRET.txt"
$converterServiceTokenPath = Join-Path $artifactDir "CONVERTER_SERVICE_TOKEN.txt"
$misaDir      = if ($MisaTemplateDir) { $MisaTemplateDir } else { Join-Path $resolvedRepo "converter\fixtures\templates" }

function Get-OrCreateSecret([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $existing = (Get-Content -LiteralPath $Path -Raw).Trim()
        if ($existing) { return $existing }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    $secret = ([BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
    Set-Content -LiteralPath $Path -Value $secret -NoNewline -Encoding utf8
    return $secret
}

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

function Get-ListeningProcesses([int]$Port) {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners) { return @() }
    foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
        Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    }
}

function Test-ManagedProcess($Process, [string[]]$Patterns) {
    if (-not $Process) { return $false }
    foreach ($pattern in $Patterns) {
        if ($Process.CommandLine -like $pattern) { return $true }
    }
    return $false
}

function Stop-ManagedPort([int]$Port, [string]$ServiceName, [string[]]$Patterns) {
    $processes = @(Get-ListeningProcesses -Port $Port)
    if (-not $processes) { return }

    foreach ($process in $processes) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)" -ErrorAction SilentlyContinue
        $isManaged = (Test-ManagedProcess -Process $process -Patterns $Patterns) -or
            (Test-ManagedProcess -Process $parent -Patterns $Patterns)

        if (-not $isManaged) {
            throw "Port $Port is used by a non-EzFormat process ($($process.ProcessId)): $($process.CommandLine)"
        }

        $idsToStop = @([int]$process.ProcessId)
        if (Test-ManagedProcess -Process $parent -Patterns $Patterns) {
            $idsToStop += [int]$parent.ProcessId
        }

        foreach ($id in ($idsToStop | Sort-Object -Unique)) {
            Write-Host "[$ServiceName] Stopping stale PID $id on port $Port" -ForegroundColor Yellow
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "=== EzFormat Dev (AI + Backend) ===" -ForegroundColor Cyan
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
    $env:AI_MAPPING_TIMEOUT_SECONDS = "15"
    $env:AI_REQUIRED      = "false"
    Write-Host "[converter] AI enabled (gateway at port $GatewayPort)" -ForegroundColor Green
} else {
    $env:AI_PROVIDER = "disabled"
    Write-Host "[converter] AI disabled" -ForegroundColor DarkGray
}
$env:MISA_TEMPLATE_DIR = $misaDir
$env:CONVERSION_CONTEXT_SECRET = Get-OrCreateSecret -Path $contextSecretPath
$env:CONVERTER_SERVICE_TOKEN = Get-OrCreateSecret -Path $converterServiceTokenPath
$env:CONVERTER_INTERNAL_URL = "http://127.0.0.1:$ConverterPort"
$env:NODE_INTERNAL_API_URL = "http://127.0.0.1:$BackendPort/api/internal"
$env:MASTER_DATA_WORKSPACES_ENABLED = "true"

# --- 4. Free stale local dev ports ---
Stop-ManagedPort `
    -Port $BackendPort `
    -ServiceName "backend" `
    -Patterns @("*node*server.js*", "*nodemon*server.js*")

Stop-ManagedPort `
    -Port $ConverterPort `
    -ServiceName "converter" `
    -Patterns @("*uvicorn*app.main:app*", "*node*server/server.js*", "*node*server\server.js*")

# --- 5. Start all services via concurrently ---
Write-Host ""
Write-Host "Starting services with concurrently..." -ForegroundColor Cyan
Write-Host "  backend   -> http://localhost:$BackendPort" -ForegroundColor Blue
Write-Host "  converter -> http://localhost:$ConverterPort" -ForegroundColor Green
Write-Host ""
Write-Host "Note: Frontend must be started separately with 'npm --prefix frontend run dev'" -ForegroundColor Yellow
Write-Host ""

Set-Location $resolvedRepo
$backendDevCommand = if (Test-Path -LiteralPath (Join-Path $resolvedRepo "backend\node_modules\.bin\nodemon.cmd")) {
    "npm --prefix backend run dev:only"
} else {
    Write-Host "[backend] nodemon not installed; using npm start" -ForegroundColor Yellow
    "npm --prefix backend start"
}

& npx concurrently `
    "--kill-others-on-fail" `
    "--names" "backend,converter" `
    "--prefix-colors" "blue.bold,green.bold" `
    $backendDevCommand `
    "npm --prefix converter run dev"
