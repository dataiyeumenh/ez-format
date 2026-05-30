# QA autopilot: run QA/QC, retry, wake agent on persistent failure
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [int]$MaxRounds = 3,
    [int]$RetryDelaySeconds = 10,
    [switch]$Watch,
    [int]$WatchIntervalMinutes = 60,
    [switch]$Fast
)

$qaScript = Join-Path $RepoRoot "scripts\qa-qc.ps1"
$sentinel = "AGENT_LOOP_WAKE_ezformat-qa"
$prompt = "EzFormat QA failed. Read docs/qa-failure.md and docs/qa-last-run.json, fix all failures, then run npm run qa until PASS."
$failDoc = Join-Path $RepoRoot "docs\qa-failure.md"
$reportJson = Join-Path $RepoRoot "docs\qa-last-run.json"

function Write-AutopilotFailureDoc {
    param([int]$Rounds)
    $mode = if ($Fast) { "fast (SkipSlowTests)" } else { "full" }
    $reportSnippet = ""
    if (Test-Path $reportJson) {
        try {
            $r = Get-Content $reportJson -Raw | ConvertFrom-Json
            $failedSteps = @($r.failed)
            if ($failedSteps.Count) {
                $reportSnippet = "Failed steps from last run: $($failedSteps -join ', ')."
            }
        } catch { }
    }
    @"
# QA autopilot failure

- **Rounds:** $Rounds (all failed)
- **Mode:** $mode
- $reportSnippet

## Agent actions

1. Read ``docs/qa-last-run.json`` for per-step errors.
2. Fix code, then run ``npm run qa`` (full) or ``npm run qa:fast``.
3. Verify autopilot: ``npm run qa:autopilot`` or ``npm run qa:autopilot:full``.

## Commands

``````powershell
npm run qa
npm run qa:fast
npm run qa:autopilot
npm run qa:autopilot:full
``````
"@ | Set-Content -Path $failDoc -Encoding UTF8
}

function Invoke-QaRound {
    Push-Location $RepoRoot
    try {
        if ($Fast) {
            & $qaScript -SkipSlowTests
        } else {
            & $qaScript
        }
        if ($null -ne $LASTEXITCODE) { return [int]$LASTEXITCODE }
        return $(if ($?) { 0 } else { 1 })
    } finally {
        Pop-Location
    }
}

if ($Watch) {
    Write-Host "QA watch mode: every ${WatchIntervalMinutes}m (Ctrl+C to stop)"
    while ($true) {
        $code = Invoke-QaRound
        if ($code -ne 0) {
            $json = "{`"prompt`":`"$($prompt -replace '"','\"')`"}"
            Write-Output "$sentinel $json"
        } else {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] QA PASS" -ForegroundColor Green
        }
        Start-Sleep -Seconds ($WatchIntervalMinutes * 60)
    }
}

$modeLabel = if ($Fast) { "fast" } else { "full" }
Write-Host "QA autopilot ($modeLabel): up to $MaxRounds round(s)"
for ($round = 1; $round -le $MaxRounds; $round++) {
    Write-Host "`n--- Round $round / $MaxRounds ---" -ForegroundColor Magenta
    $code = Invoke-QaRound
    if ($code -eq 0) {
        Write-Host "Autopilot: QA passed on round $round" -ForegroundColor Green
        exit 0
    }
    if ($round -lt $MaxRounds) {
        Write-Host "Retry in ${RetryDelaySeconds}s…" -ForegroundColor Yellow
        Start-Sleep -Seconds $RetryDelaySeconds
    }
}

Write-AutopilotFailureDoc -Rounds $MaxRounds
$json = "{`"prompt`":`"$($prompt -replace '"','\"')`"}"
Write-Output "$sentinel $json"
Write-Host "Autopilot: QA still failing after $MaxRounds rounds" -ForegroundColor Red
Write-Host "See docs/qa-failure.md and docs/qa-last-run.json" -ForegroundColor Yellow
exit 1
