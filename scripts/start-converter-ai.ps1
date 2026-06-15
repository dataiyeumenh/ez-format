param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$MisaTemplateDir = "E:\0. EXE2\Misa File",
    [string]$AiBaseUrl = "http://127.0.0.1:8010/v1/misa/suggest-mapping",
    [string]$TokenPath = "",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

if (-not $TokenPath) {
    $TokenPath = Join-Path $RepoRoot ".artifacts\local-ai\AI_GATEWAY_TOKEN.txt"
}
if (-not (Test-Path -LiteralPath $TokenPath)) {
    throw "AI token file not found: $TokenPath. Run scripts\start-local-ai-gateway.ps1 first."
}

$env:MISA_TEMPLATE_DIR = $MisaTemplateDir
$env:MAPPING_DB_PATH = Join-Path $RepoRoot "converter\data\mapping_profiles.sqlite"
$env:AI_PROVIDER = "remote_http"
$env:AI_BASE_URL = $AiBaseUrl
$env:AI_TOKEN = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
$env:AI_MAPPING_TIMEOUT_SECONDS = "15"
$env:AI_REQUIRED = "false"

Push-Location (Join-Path $RepoRoot "converter")
try {
    python -m uvicorn app.main:app --reload --host 127.0.0.1 --port $Port
} finally {
    Pop-Location
}
