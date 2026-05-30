# Full pipeline: QA then UI improvement (run after QA QC automation)
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

Push-Location $RepoRoot
Write-Host "=== Pipeline: QA ===" -ForegroundColor Magenta
& (Join-Path $RepoRoot "scripts\qa-qc.ps1") -SkipSlowTests
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }

Write-Host "`n=== Pipeline: UI ===" -ForegroundColor Magenta
& (Join-Path $RepoRoot "scripts\ui-improve.ps1") -SkipQa
$uiCode = $LASTEXITCODE
Pop-Location
exit $uiCode
