$ErrorActionPreference = "Stop"
$env:REQUIRE_REPLICA_TESTS = "1"

& (Join-Path $PSScriptRoot "qa-main-integration.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
