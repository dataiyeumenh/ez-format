param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
Push-Location (Join-Path $RepoRoot "converter")
python -m pip install -q pdfplumber fpdf2 2>$null
python -m pytest tests/test_specialized_1000.py -v --tb=short
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "`nSpecialized 1000 PASSED" -ForegroundColor Green
Pop-Location
