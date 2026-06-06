<#
.SYNOPSIS
    Khởi động Python Converter + ngrok tunnel để expose AI ra internet.

.DESCRIPTION
    Script này sẽ:
      1. Kiểm tra ngrok đã cài chưa
      2. Copy converter/.env.example → converter/.env nếu chưa có
      3. Khởi động uvicorn (Converter API) trên port 8000
      4. Mở ngrok tunnel đến port 8000
      5. In ra public URL để cấu hình trên Vercel

.EXAMPLE
    pwsh -File scripts/start-ngrok-ai.ps1
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$ConverterDir = Join-Path $Root "converter"
$EnvFile = Join-Path $ConverterDir ".env"
$EnvExample = Join-Path $ConverterDir ".env.example"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  EzFormat — Converter + ngrok AI tunnel" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""

# ── 1. Kiểm tra ngrok ────────────────────────────────────────────────────────
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] ngrok chưa được cài." -ForegroundColor Red
    Write-Host ""
    Write-Host "Cài ngrok tại: https://ngrok.com/download" -ForegroundColor Yellow
    Write-Host "Sau đó chạy:   ngrok config add-authtoken <YOUR_TOKEN>" -ForegroundColor Yellow
    Write-Host "(Đăng ký miễn phí tại https://dashboard.ngrok.com)" -ForegroundColor Yellow
    exit 1
}

# ── 2. Tạo converter/.env nếu chưa có ───────────────────────────────────────
if (-not (Test-Path $EnvFile)) {
    Write-Host "[INFO] Chưa có converter/.env — copy từ .env.example" -ForegroundColor Yellow
    Copy-Item $EnvExample $EnvFile
    Write-Host "[INFO] Đã tạo converter/.env. Kiểm tra lại AI_MODEL nếu cần." -ForegroundColor Green
}

# ── 3. Khởi động uvicorn ─────────────────────────────────────────────────────
Write-Host "[1/3] Khởi động Python Converter (port 8000)..." -ForegroundColor Cyan

# Load .env để uvicorn nhận được biến môi trường
$EnvVars = @{}
Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#]' -and $_ -match '=' } | ForEach-Object {
    $parts = $_ -split '=', 2
    $key = $parts[0].Trim()
    $val = $parts[1].Trim().Trim('"').Trim("'")
    $EnvVars[$key] = $val
    [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
}

$uvicornJob = Start-Job -ScriptBlock {
    param($dir, $envVars)
    Set-Location $dir
    foreach ($kv in $envVars.GetEnumerator()) {
        [System.Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }
    & python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 2>&1
} -ArgumentList $ConverterDir, $EnvVars

Write-Host "[INFO] Đợi Converter khởi động..." -ForegroundColor Gray
Start-Sleep -Seconds 4

# Kiểm tra converter có chạy không
try {
    $health = Invoke-RestMethod "http://127.0.0.1:8000/healthz" -TimeoutSec 5
    Write-Host "[OK]  Converter chạy thành công. AI status: $($health.ai_status)" -ForegroundColor Green
} catch {
    Write-Host "[WARN] Converter chưa phản hồi (có thể đang khởi động chậm)." -ForegroundColor Yellow
}

# ── 4. Mở ngrok tunnel ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "[2/3] Mở ngrok tunnel đến port 8000..." -ForegroundColor Cyan

$ngrokJob = Start-Job -ScriptBlock {
    & ngrok http 8000 --log=stdout 2>&1
}

Write-Host "[INFO] Đợi ngrok kết nối..." -ForegroundColor Gray
Start-Sleep -Seconds 5

# ── 5. Lấy public URL từ ngrok API ──────────────────────────────────────────
Write-Host ""
Write-Host "[3/3] Lấy public URL..." -ForegroundColor Cyan

$ngrokUrl = $null
for ($i = 0; $i -lt 10; $i++) {
    try {
        $tunnels = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
        $https = $tunnels.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1
        if ($https) {
            $ngrokUrl = $https.public_url
            break
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $ngrokUrl) {
    Write-Host "[ERROR] Không lấy được URL từ ngrok. Kiểm tra ngrok dashboard tại http://127.0.0.1:4040" -ForegroundColor Red
} else {
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
    Write-Host "  ✅  PUBLIC URL:" -ForegroundColor Green
    Write-Host "      $ngrokUrl" -ForegroundColor White
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Làm theo các bước sau để Vercel nhận được URL này:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1. Vào Vercel Dashboard → Project Settings → Environment Variables"
    Write-Host "  2. Thêm biến:"
    Write-Host "       VITE_PYTHON_API_URL = $ngrokUrl" -ForegroundColor Cyan
    Write-Host "  3. Redeploy frontend trên Vercel"
    Write-Host ""
    Write-Host "  [LƯU Ý] URL ngrok thay đổi mỗi lần khởi động (gói miễn phí)." -ForegroundColor Yellow
    Write-Host "  Dùng Static Domain (miễn phí 1 domain) để URL cố định:" -ForegroundColor Yellow
    Write-Host "  → https://dashboard.ngrok.com/domains" -ForegroundColor Gray
    Write-Host "  → Sau đó chạy: ngrok http 8000 --domain=your-name.ngrok-free.app" -ForegroundColor Gray
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "  Nhấn Ctrl+C để dừng tất cả dịch vụ" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
}

# Giữ script chạy, stream output từ jobs
try {
    while ($true) {
        Receive-Job $uvicornJob | Write-Host -ForegroundColor Gray
        Receive-Job $ngrokJob  | Write-Host -ForegroundColor DarkGray
        Start-Sleep -Seconds 2
    }
} finally {
    Write-Host ""
    Write-Host "[INFO] Đang dừng Converter và ngrok..." -ForegroundColor Yellow
    Stop-Job $uvicornJob, $ngrokJob -ErrorAction SilentlyContinue
    Remove-Job $uvicornJob, $ngrokJob -ErrorAction SilentlyContinue
    Write-Host "[INFO] Đã dừng." -ForegroundColor Green
}
