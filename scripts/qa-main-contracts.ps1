$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$backendTests = @(
    "tests/authContracts.test.js",
    "tests/adminContracts.test.js",
    "tests/plans.test.js",
    "tests/paymentPlans.test.js",
    "tests/paymentStatusSync.test.js",
    "tests/paymentSettlementReadiness.test.js",
    "tests/serverStartupReadiness.test.js",
    "tests/dailyFileCredit.test.js",
    "tests/coupons.test.js"
)

Push-Location (Join-Path $Root "backend")
try {
    node --test @backendTests
    if ($LASTEXITCODE -ne 0) { throw "Main backend contract tests failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Push-Location (Join-Path $Root "frontend")
try {
    npm exec -- vitest run "src/pages/PaymentPage.contract.test.mjs"
    if ($LASTEXITCODE -ne 0) { throw "Main frontend contract tests failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
