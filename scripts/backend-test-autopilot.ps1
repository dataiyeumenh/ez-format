# Backend test autopilot: run gate until PASS or wake agent to fix (requirements = full gate)
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [int]$MaxRounds = 5,
    [int]$RetryDelaySeconds = 15,
    [switch]$UntilPass,
    [switch]$SkipFullPytest
)

$gateScript = Join-Path $RepoRoot "scripts\backend-test-gate.ps1"
$sentinel = "AGENT_LOOP_WAKE_ezformat-backend-tests"
$prompt = @"
EzFormat backend tests failed. Read docs/backend-test-failure.md and docs/backend-test-last-run.json.
Fix all failures, then run: npm run test:autopilot
Do not stop until BACKEND TEST GATE PASSED (all specialized/stress/e2e/messy/pytest steps).
"@

function Invoke-Gate {
    Push-Location $RepoRoot
    try {
        $args = @{}
        if ($SkipFullPytest) { $args.SkipFullPytest = $true }
        & $gateScript @args
        if ($null -ne $LASTEXITCODE) { return [int]$LASTEXITCODE }
        return $(if ($?) { 0 } else { 1 })
    } finally {
        Pop-Location
    }
}

$max = if ($UntilPass) { 999 } else { $MaxRounds }
Write-Host "Backend test autopilot: up to $max round(s), UntilPass=$UntilPass" -ForegroundColor Magenta

for ($round = 1; $round -le $max; $round++) {
    Write-Host "`n--- Round $round ---" -ForegroundColor Magenta
    $code = Invoke-Gate
    if ($code -eq 0) {
        $passDoc = Join-Path $RepoRoot "docs\backend-test-pass.json"
        @{
            timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
            rounds    = $round
            status    = "PASS"
        } | ConvertTo-Json | Set-Content -Path $passDoc -Encoding UTF8
        Write-Host "Autopilot: backend tests PASSED on round $round" -ForegroundColor Green
        exit 0
    }
    if (-not $UntilPass -and $round -ge $MaxRounds) { break }
    if ($round -lt $max) {
        Write-Host "Retry in ${RetryDelaySeconds}s…" -ForegroundColor Yellow
        Start-Sleep -Seconds $RetryDelaySeconds
    }
}

$json = "{`"prompt`":`"$($prompt -replace '"','\"' -replace "`r`n"," ")`"}"
Write-Output "$sentinel $json"
Write-Host "Autopilot: backend tests still FAILING after $round round(s)" -ForegroundColor Red
Write-Host "Fix → npm run test:autopilot (hoặc npm run test:gate)" -ForegroundColor Yellow
exit 1
