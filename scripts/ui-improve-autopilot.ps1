# UI improvement autopilot — QA gate then UI checks; wake agent on fail
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [int]$MaxRounds = 2,
    [switch]$Watch,
    [int]$WatchIntervalMinutes = 180
)

$uiScript = Join-Path $RepoRoot "scripts\ui-improve.ps1"
$sentinel = "AGENT_LOOP_WAKE_ezformat-ui"
$prompt = @"
EzFormat UI improvement tick. Read docs/ui-failure.md if present.
Run: npm run ui:improve. If pass, make ONE small visual polish (HomePage, Navbar, or auth pages):
better mobile spacing, focus states, loading skeleton, or Vietnamese copy.
Use Tailwind + Prettier. Extensions: Tailwind IntelliSense, ESLint, Color Highlight.
Preview: npm run frontend (5173) or Live Server on frontend/dist after build.
"@

function Invoke-UiRound {
    Push-Location $RepoRoot
    try {
        & $uiScript
        if ($null -ne $LASTEXITCODE) { return [int]$LASTEXITCODE }
        return $(if ($?) { 0 } else { 1 })
    } finally {
        Pop-Location
    }
}

if ($Watch) {
    Write-Host "UI watch: every ${WatchIntervalMinutes}m"
    while ($true) {
        $code = Invoke-UiRound
        if ($code -ne 0) {
            $json = "{`"prompt`":`"$($prompt -replace '"','\"' -replace "`n",' ')`"}"
            Write-Output "$sentinel $json"
        } else {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] UI PASS" -ForegroundColor Green
        }
        Start-Sleep -Seconds ($WatchIntervalMinutes * 60)
    }
}

for ($r = 1; $r -le $MaxRounds; $r++) {
    Write-Host "`n--- UI round $r / $MaxRounds ---"
    if ((Invoke-UiRound) -eq 0) {
        Write-Host "UI autopilot passed" -ForegroundColor Green
        exit 0
    }
    if ($r -lt $MaxRounds) { Start-Sleep -Seconds 8 }
}

$json = "{`"prompt`":`"$($prompt -replace '"','\"' -replace "`n",' ')`"}"
Write-Output "$sentinel $json"
exit 1
