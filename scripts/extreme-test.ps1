# Extreme A→Z test: QA + full pytest + messy1000 + live HTTP smoke
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$failed = @()
$reportPath = Join-Path $RepoRoot "docs\extreme-test-report.json"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$results = [ordered]@{}

function Step($name, [scriptblock]$Action) {
    Write-Host "`n======== $name ========" -ForegroundColor Magenta
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $null = & $Action
        $sw.Stop()
        Write-Host "PASS $name ($([math]::Round($sw.Elapsed.TotalSeconds,1))s)" -ForegroundColor Green
        $script:results[$name] = @{ status = "pass"; seconds = $sw.Elapsed.TotalSeconds }
    } catch {
        $sw.Stop()
        Write-Host "FAIL $name : $_" -ForegroundColor Red
        $script:failed += $name
        $script:results[$name] = @{ status = "fail"; error = $_.ToString(); seconds = $sw.Elapsed.TotalSeconds }
    }
}

Push-Location $RepoRoot

Step "QA fast gate" {
    & (Join-Path $RepoRoot "scripts\qa-qc.ps1") -SkipSlowTests
    if ($LASTEXITCODE -ne 0) { throw "QA gate failed" }
}

Step "UI lint gate" {
    & (Join-Path $RepoRoot "scripts\ui-improve.ps1") -SkipQa
    if ($LASTEXITCODE -ne 0) { throw "UI gate failed" }
}

Step "E2E extreme pytest" {
    Push-Location (Join-Path $RepoRoot "converter")
    python -m pytest tests/test_e2e_extreme.py -v --tb=short
    if ($LASTEXITCODE -ne 0) { throw "E2E extreme failed" }
    Pop-Location
}

Step "Specialized 1000 (VAT cell, PDF, OCR, corrupt, multisheet)" {
    Push-Location (Join-Path $RepoRoot "converter")
    python -m pytest tests/test_specialized_1000.py -v --tb=short
    if ($LASTEXITCODE -ne 0) { throw "Specialized 1000 failed" }
    Pop-Location
}

Step "Stress 999 matrix (99.9% use cases)" {
    Push-Location (Join-Path $RepoRoot "converter")
    python -m pytest tests/test_stress_999.py -v --tb=short
    if ($LASTEXITCODE -ne 0) { throw "Stress 999 failed" }
    Pop-Location
}

Step "Messy 1000 records" {
    Push-Location (Join-Path $RepoRoot "converter")
    python -m pytest tests/test_messy_1000.py -v --tb=line
    if ($LASTEXITCODE -ne 0) { throw "Messy 1000 failed" }
    Pop-Location
}

Step "Full converter pytest (43+)" {
    Push-Location (Join-Path $RepoRoot "converter")
    python -m pytest -q --tb=no
    if ($LASTEXITCODE -ne 0) { throw "Full pytest failed" }
    Pop-Location
}

Step "Live HTTP converter" {
    $port = 8765
    $proc = Start-Process -FilePath "python" -ArgumentList @(
        "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", $port
    ) -WorkingDirectory (Join-Path $RepoRoot "converter") -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Seconds 3
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:${port}/healthz" -TimeoutSec 10
        if ($health.status -ne "ok") { throw "healthz bad" }

        $types = (Invoke-RestMethod -Uri "http://127.0.0.1:${port}/api/v1/conversion-types").items
        if ($types.Count -lt 6) { throw "expected 6 conversion types" }

        $sample = Join-Path $RepoRoot "converter\fixtures\samples\raw_sales_sample.xlsx"
        if (-not (Test-Path $sample)) { throw "missing sample file" }

        $form = @{
            conversion_type = "bsn_sales"
            file            = Get-Item $sample
        }
        $preview = Invoke-RestMethod -Uri "http://127.0.0.1:${port}/api/v1/conversions/preview" -Method Post -Form $form -TimeoutSec 120
        if (-not $preview.rows.Count) { throw "preview returned no rows" }

        $exportBody = @{
            conversion_type = "bsn_sales"
            rows            = $preview.rows
        } | ConvertTo-Json -Depth 20
        $export = Invoke-WebRequest -Uri "http://127.0.0.1:${port}/api/v1/conversions/export" -Method Post -Body $exportBody -ContentType "application/json" -TimeoutSec 120
        if ($export.StatusCode -ne 200) { throw "export HTTP $($export.StatusCode)" }
        if ($export.Headers["Content-Type"] -notmatch "excel") { throw "export not excel" }
        Write-Host "Live: preview $($preview.rows.Count) rows, export $($export.RawContentLength) bytes"
    } finally {
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

Pop-Location

$summary = @{
    timestamp = $stamp
    ok        = ($failed.Count -eq 0)
    failed    = $failed
    steps     = $results
}
$summary | ConvertTo-Json -Depth 6 | Set-Content $reportPath -Encoding UTF8

if ($failed.Count) {
    Write-Host "`nEXTREME TEST FAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "`nEXTREME TEST ALL PASSED" -ForegroundColor Green
Write-Host "Report: docs/extreme-test-report.json"
exit 0
