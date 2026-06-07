# Backend test gate — all requirements in one pass (exit 0 only when fully PASS)
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipFullPytest
)

$ErrorActionPreference = "Stop"
$failed = @()
$passed = @()
$steps = @()
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$reportPath = Join-Path $RepoRoot "docs\backend-test-last-run.json"
$converter = Join-Path $RepoRoot "converter"

function Step($name, [scriptblock]$Action) {
    Write-Host "`n== $name ==" -ForegroundColor Cyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
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

[void]($steps += Step "Prerequisites" {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "python not found" }
    python -m pip install -q -r (Join-Path $converter "requirements.txt") 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
})

[void]($steps += Step "Specialized 1000 (VAT/PDF/OCR/corrupt/multisheet)" {
    Push-Location $converter
    python -m pytest tests/test_specialized_1000.py -q --tb=line
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "specialized failed" }
    Pop-Location
})

[void]($steps += Step "Stress 999 matrix" {
    Push-Location $converter
    python -m pytest tests/test_stress_999.py -q --tb=line
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "stress failed" }
    Pop-Location
})

[void]($steps += Step "E2E extreme" {
    Push-Location $converter
    python -m pytest tests/test_e2e_extreme.py -q --tb=line
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "e2e failed" }
    Pop-Location
})

[void]($steps += Step "Messy 1000" {
    Push-Location $converter
    python -m pytest tests/test_messy_1000.py -q --tb=line
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "messy failed" }
    Pop-Location
})

if (-not $SkipFullPytest) {
    [void]($steps += Step "Full converter pytest" {
        Push-Location $converter
        python -m pytest -q --tb=no
        if ($LASTEXITCODE -ne 0) { Pop-Location; throw "full pytest failed" }
        Pop-Location
    })
}

Pop-Location

$report = @{
    timestamp = $stamp
    ok        = ($failed.Count -eq 0)
    passed    = $passed
    failed    = $failed
    steps     = $steps
    requirements = @(
        "specialized_1000",
        "stress_999",
        "e2e_extreme",
        "messy_1000",
        $(if (-not $SkipFullPytest) { "full_pytest" })
    )
}
$report | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8

$failDoc = Join-Path $RepoRoot "docs\backend-test-failure.md"
if ($failed.Count) {
    @"
# Backend test gate FAILED — $stamp

Failed: $($failed -join ', ')

## Yêu cầu (phải PASS hết)

- Specialized 1000: VAT cell, PDF, OCR mock, corrupt .xls, multi-sheet
- Stress 999: header matrix × 6 conversion types
- E2E extreme: validate → preview → export
- Messy 1000: 1000 rows shuffled columns
- Full pytest (86+ tests)

## Agent / dev

1. Đọc ``docs/backend-test-last-run.json``
2. Chạy lại từng bước lỗi trong ``converter/``:
   ``python -m pytest tests/<file> -v --tb=short``
3. Sửa code → ``npm run test:autopilot`` cho đến PASS

``````powershell
npm run test:gate
npm run test:autopilot
``````
"@ | Set-Content -Path $failDoc -Encoding UTF8
    Write-Host "`nBACKEND TEST GATE FAILED: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "Report: docs/backend-test-last-run.json" -ForegroundColor Yellow
    exit 1
}

if (Test-Path $failDoc) { Remove-Item $failDoc -Force -ErrorAction SilentlyContinue }
Write-Host "`nBACKEND TEST GATE PASSED ($($passed.Count) steps)" -ForegroundColor Green
Write-Host "Report: docs/backend-test-last-run.json" -ForegroundColor Gray
exit 0
