# EzFormat QA/QC — single pass, exits non-zero on any failure
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipSlowTests
)

$ErrorActionPreference = "Stop"
$failed = @()
$passed = @()
$reportPath = Join-Path $RepoRoot "docs\qa-last-run.json"
$logPath = Join-Path $RepoRoot "docs\qa-log.md"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Step($name, [scriptblock]$Action) {
    Write-Host "`n== $name ==" -ForegroundColor Cyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $null = & $Action
        $sw.Stop()
        Write-Host "OK $name ($([math]::Round($sw.Elapsed.TotalSeconds, 1))s)" -ForegroundColor Green
        $script:passed += $name
        return @{ name = $name; status = "ok"; seconds = $sw.Elapsed.TotalSeconds }
    } catch {
        $sw.Stop()
        Write-Host "FAIL $name : $_" -ForegroundColor Red
        $script:failed += $name
        return @{ name = $name; status = "fail"; error = $_.ToString(); seconds = $sw.Elapsed.TotalSeconds }
    }
}

Push-Location $RepoRoot
$steps = @()

[void]($steps += Step "Prerequisites" {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node not found" }
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "python not found" }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found" }
})

[void]($steps += Step "Fixtures templates" {
    $tpl = Join-Path $RepoRoot "converter\fixtures\templates"
    $required = @(
        "bsn_sales.xls", "bsn_purchase.xls", "sales_goods.xls",
        "sales_service.xls", "purchase_goods.xls", "purchase_service.xls"
    )
    foreach ($f in $required) {
        if (-not (Test-Path (Join-Path $tpl $f))) {
            & (Join-Path $RepoRoot "scripts\setup-fixtures.ps1")
            break
        }
    }
    foreach ($f in $required) {
        if (-not (Test-Path (Join-Path $tpl $f))) {
            throw "Missing template: $f (run npm run setup:fixtures)"
        }
    }
})

[void]($steps += Step "Backend syntax" {
    $files = @(
        "backend\server.js",
        "backend\config\db.js",
        "backend\middleware\requireDb.js",
        "backend\middleware\auth.js",
        "backend\controllers\authController.js",
        "backend\controllers\convertController.js",
        "backend\controllers\studentSessionController.js",
        "backend\models\StudentActivity.js",
        "backend\routes\student.js",
        "backend\routes\internal.js",
        "backend\seed.js"
    )
    foreach ($rel in $files) {
        $path = Join-Path $RepoRoot $rel
        if (-not (Test-Path $path)) { throw "Missing $rel" }
        node --check $path 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Syntax error in $rel" }
    }
})

[void]($steps += Step "Backend student tests" {
    node --test backend/tests/studentSessions.test.js backend/tests/studentQuestions.test.js backend/tests/studentActivities.test.js
    if ($LASTEXITCODE -ne 0) { throw "Backend student tests failed" }
})

[void]($steps += Step "Frontend tests" {
    Push-Location (Join-Path $RepoRoot "frontend")
    npm test --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed" }
    Pop-Location
})

[void]($steps += Step "Frontend build" {
    Push-Location (Join-Path $RepoRoot "frontend")
    npm run build --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "vite build failed" }
    Pop-Location
})

[void]($steps += Step "Converter API smoke" {
    Push-Location (Join-Path $RepoRoot "converter")
    python -m pytest tests/test_api.py::test_healthz tests/test_api.py::test_conversion_types_endpoint tests/test_api.py::test_preview_endpoint_returns_json_rows tests/test_api.py::test_export_rows_endpoint_rejects_legacy_rows_by_default tests/test_api.py::test_export_rows_endpoint_returns_xls_when_explicitly_enabled -q --tb=line
    if ($LASTEXITCODE -ne 0) { throw "API smoke tests failed" }
    Pop-Location
})

[void]($steps += Step "Converter student integration" {
    Push-Location (Join-Path $RepoRoot "converter")
    python -m pytest tests/test_student_accounting_map.py tests/test_student_reconciliation.py tests/test_student_anonymization.py tests/test_student_reports.py tests/test_student_api.py -q --tb=line
    if ($LASTEXITCODE -ne 0) { throw "Student integration tests failed" }
    Pop-Location
})

if ($SkipSlowTests) {
    [void]($steps += Step "MISA import repair Task 9 gate" {
        & (Join-Path $RepoRoot "scripts\qa-misa-import-repair.ps1") -RepoRoot $RepoRoot -SkipSlowTests
        if ($LASTEXITCODE -ne 0) { throw "Task 9 focused QA failed" }
    })
}

if (-not $SkipSlowTests) {
    [void]($steps += Step "Converter full tests" {
        Push-Location (Join-Path $RepoRoot "converter")
        python -m pytest -q --tb=no
        if ($LASTEXITCODE -ne 0) { throw "Full pytest failed" }
        Pop-Location
    })
}

Pop-Location

$report = @{
    timestamp = $stamp
    ok = ($failed.Count -eq 0)
    passed = $passed
    failed = $failed
    steps = $steps
}

$report | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8

$logEntry = @"

## $stamp
- **Result:** $(if ($report.ok) { 'PASS' } else { 'FAIL' })
- Passed: $($passed -join ', ')
- Failed: $(if ($failed.Count) { $failed -join ', ' } else { 'none' })

"@

$logDir = Split-Path $logPath -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
Add-Content -Path $logPath -Value $logEntry

if ($failed.Count) {
    $failDoc = Join-Path $RepoRoot "docs\qa-failure.md"
    @"
# QA failure — $stamp

Failed steps: $($failed -join ', ')

## Agent actions
1. Read ``docs/qa-last-run.json`` for step errors.
2. Fix code, then run: ``npm run qa``
3. Repeat until PASS.

## Quick commands
``````powershell
npm run qa
npm run qa:fast
``````
"@ | Set-Content -Path $failDoc -Encoding UTF8
    Write-Host "`nQA/QC FAILED: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "Report: docs/qa-last-run.json" -ForegroundColor Yellow
    exit 1
}

if (Test-Path (Join-Path $RepoRoot "docs\qa-failure.md")) {
    Remove-Item (Join-Path $RepoRoot "docs\qa-failure.md") -Force -ErrorAction SilentlyContinue
}

Write-Host "`nQA/QC PASSED ($($passed.Count) steps)" -ForegroundColor Green
Write-Host "Report: docs/qa-last-run.json" -ForegroundColor Gray
exit 0
