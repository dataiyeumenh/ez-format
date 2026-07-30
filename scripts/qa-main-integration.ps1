param(
    [ValidateSet("Release", "LocalIncomplete")]
    [string]$Mode = "Release"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$KnownDiffNoise = @()
$StatusScript = Join-Path $PSScriptRoot "qa-main-integration-status.ps1"

& $StatusScript -Mode $Mode
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if ($Mode -eq "Release") {
    $env:REQUIRE_REPLICA_TESTS = "1"
} else {
    # Local incomplete mode may document real-Mongo skips instead of certifying them.
    $env:REQUIRE_REPLICA_TESTS = ""
}

function Invoke-QaStep {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [scriptblock]$Action
    )

    Write-Host "`n== $Name ==" -ForegroundColor Cyan
    Push-Location $WorkingDirectory
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) {
            throw "$Name failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Invoke-CleanScan {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    Write-Host "`n== $Name ==" -ForegroundColor Cyan
    $matches = @(& $Action 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0 -and $matches.Count -gt 0) {
        $matches | ForEach-Object { Write-Output $_ }
        throw "$Name found forbidden matches"
    }
    if ($exitCode -notin @(0, 1)) {
        throw "$Name failed with exit code $exitCode"
    }
    Write-Output "[QA] ${Name}: clean"
}

Write-Output "[QA] Main integration gate mode: $Mode"
Write-Output "[QA] Worktree: $Root"

if ([string]::IsNullOrWhiteSpace($env:PAYMENT_REPLICA_SET_TEST_URI)) {
    Write-Output "[QA] SKIPPED replica Mongo/payment tests: PAYMENT_REPLICA_SET_TEST_URI is not set."
}
if ($env:QA_EXPECT_LIVE -ne "true") {
    Write-Output "[QA] SKIPPED live gateway URLs and live browser journeys: QA_EXPECT_LIVE=true is not set."
}

Invoke-QaStep "Main contracts" $Root {
    npm run qa:main-contracts
}

Invoke-QaStep "Full backend node tests" (Join-Path $Root "backend") {
    node --test
}

Invoke-QaStep "Full converter pytest" (Join-Path $Root "converter") {
    python -m pytest -q --tb=short
}

Invoke-QaStep "Frontend test" (Join-Path $Root "frontend") {
    npm test
}

Invoke-QaStep "Frontend lint" (Join-Path $Root "frontend") {
    npm run lint
}

Invoke-QaStep "Frontend build" (Join-Path $Root "frontend") {
    npm run build
}

Invoke-QaStep "Playwright converter gateway UI" (Join-Path $Root "frontend") {
    npx playwright test tests/converter-gateway.integration.spec.mjs --workers=1 --reporter=line
}

Invoke-QaStep "Playwright converter gateway API" (Join-Path $Root "frontend") {
    npx playwright test tests/converter-gateway.api.integration.spec.mjs --workers=1 --reporter=line
}

Invoke-QaStep "Playwright MISA import repair" (Join-Path $Root "frontend") {
    npx playwright test tests/misa-import-repair.integration.spec.mjs --workers=1 --reporter=line
}

Invoke-QaStep "Workspace QA fast" $Root {
    npm run qa:fast
}

Invoke-CleanScan "Conflict marker scan" {
    rg -n "^(<<<<<<<|=======|>>>>>>>)" `
        --glob '!node_modules/**' `
        --glob '!.git/**' `
        --glob '!.artifacts/**' `
        --glob '!frontend/dist/**' .
}

Invoke-CleanScan "Frontend production URL scan" {
    rg -n -i "localhost|127\.0\.0\.1|:8000|:8100|/api/v1|fastapi" `
        (Join-Path $Root "frontend/src") `
        --glob '!**/*.test.*'
}

Invoke-CleanScan "Forbidden object-storage provider scan" {
    rg -n -i "s3://|r2://|minio://|aws_access_key_id|aws_secret_access_key|aws_s3_bucket|(^|[^A-Za-z])R2_" `
        (Join-Path $Root "backend") `
        (Join-Path $Root "converter/app") `
        (Join-Path $Root "frontend/src") `
        (Join-Path $Root "scripts") `
        --glob '*.js' --glob '*.jsx' --glob '*.mjs' --glob '*.py' --glob '*.ps1' `
        --glob '!qa-main-integration.ps1'
}

Write-Host "`n== Git diff check ==" -ForegroundColor Cyan
$diffCheck = @(& git -C $Root diff --check 2>&1)
$diffExit = $LASTEXITCODE
if ($diffExit -eq 0) {
    Write-Output "[QA] git diff --check: clean"
} else {
    $unexpected = @(
        $diffCheck | Where-Object {
            $_ -notmatch '^\+' -and
            $_ -match '^[^:]+:\d+:\s' -and
            $_ -notmatch '^docs/qa-last-run\.json:' -and
            $_ -notmatch '^docs/qa-log\.md:'
        }
    )
    if ($unexpected.Count -gt 0) {
        $unexpected | ForEach-Object { Write-Output $_ }
        throw "git diff --check found unexpected whitespace errors"
    }
    $KnownDiffNoise = @("docs/qa-last-run.json", "docs/qa-log.md")
    Write-Output "[QA] git diff --check: KNOWN pre-existing generated QA whitespace only ($($KnownDiffNoise -join ', ')); preserved and not treated as Task 11 code failure."
}

Write-Output "`n[QA] Main integration code matrix complete."
if ($KnownDiffNoise.Count -gt 0) {
    Write-Output "[QA] Remaining local hygiene note: $($KnownDiffNoise -join ', ') contain preserved generated diff noise."
}
