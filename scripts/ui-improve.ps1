# UI improvement pass — runs after QA gate, lint + format check
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipQa
)

$ErrorActionPreference = "Stop"
$failed = @()
$passed = @()
$reportPath = Join-Path $RepoRoot "docs\ui-last-run.json"
$logPath = Join-Path $RepoRoot "docs\ui-improvement-log.md"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Step($name, [scriptblock]$Action) {
    Write-Host "`n== $name ==" -ForegroundColor Cyan
    try {
        $null = & $Action
        Write-Host "OK $name" -ForegroundColor Green
        $script:passed += $name
        return @{ name = $name; status = "ok" }
    } catch {
        Write-Host "FAIL $name : $_" -ForegroundColor Red
        $script:failed += $name
        return @{ name = $name; status = "fail"; error = $_.ToString() }
    }
}

Push-Location $RepoRoot
$steps = @()

if (-not $SkipQa) {
    [void]($steps += Step "QA gate (fast)" {
        & (Join-Path $RepoRoot "scripts\qa-qc.ps1") -SkipSlowTests
        if ($LASTEXITCODE -ne 0) { throw "QA gate failed — fix before UI pass" }
    })
}

[void]($steps += Step "ESLint (frontend)" {
    Push-Location (Join-Path $RepoRoot "frontend")
    npm run lint -- --max-warnings 500
    if ($LASTEXITCODE -ne 0) { throw "eslint errors (not warnings)" }
    Pop-Location
})

[void]($steps += Step "Prettier check" {
    Push-Location (Join-Path $RepoRoot "frontend")
    npm run format:check
    if ($LASTEXITCODE -ne 0) { throw "prettier check failed (run npm run format)" }
    Pop-Location
})

[void]($steps += Step "Frontend build" {
    Push-Location (Join-Path $RepoRoot "frontend")
    npm run build --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
    Pop-Location
})

Pop-Location

$report = @{
    timestamp = $stamp
    ok      = ($failed.Count -eq 0)
    passed  = $passed
    failed  = $failed
    steps   = $steps
}

$report | ConvertTo-Json -Depth 5 | Set-Content -Path $reportPath -Encoding UTF8

$entry = @"

## $stamp
- **Result:** $(if ($report.ok) { 'PASS' } else { 'FAIL' })
- Passed: $($passed -join ', ')
- Failed: $(if ($failed.Count) { $failed -join ', ' } else { 'none' })

**Next UI task:** Pick one page (Home, Login, Pricing). Improve spacing, mobile, contrast, micro-animations. Use Tailwind IntelliSense + Prettier. Run ``npm run ui:improve`` after edits.

"@

if (-not (Test-Path (Split-Path $logPath -Parent))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $logPath -Parent) | Out-Null
}
Add-Content -Path $logPath -Value $entry

if ($failed.Count) {
    $failDoc = Join-Path $RepoRoot "docs\ui-failure.md"
    @"
# UI improve failure — $stamp

Failed: $($failed -join ', ')

1. Read ``docs/ui-last-run.json``
2. Run ``npm run format`` in frontend if Prettier failed
3. Fix ESLint warnings/errors
4. Run ``npm run ui:improve``
"@ | Set-Content -Path $failDoc -Encoding UTF8

    Write-Host "`nUI improve FAILED" -ForegroundColor Red
    exit 1
}

Remove-Item (Join-Path $RepoRoot "docs\ui-failure.md") -Force -ErrorAction SilentlyContinue
Write-Host "`nUI improve PASSED" -ForegroundColor Green
exit 0
