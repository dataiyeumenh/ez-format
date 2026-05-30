# Deprecated wrapper — use scripts/qa-qc.ps1 via `npm run qa`
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)
& (Join-Path $RepoRoot "scripts\qa-qc.ps1") @PSBoundParameters
exit $LASTEXITCODE