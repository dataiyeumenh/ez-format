# Super extreme backend stress — matrix + 2000 rows
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
Push-Location (Join-Path $RepoRoot "converter")
python -m pytest tests/test_stress_999.py -v --tb=short
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "`nStress 999 PASSED — reports in converter/.artifacts/stress-999/" -ForegroundColor Green
Pop-Location
