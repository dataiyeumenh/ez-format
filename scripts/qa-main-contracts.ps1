param(
    [switch]$CheckReplicaSet
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$MissingPayOSConfigCount = @("PAYOS_CLIENT_ID", "PAYOS_API_KEY", "PAYOS_CHECKSUM_KEY") |
    ForEach-Object { -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) } |
    Where-Object { -not $_ } |
    Measure-Object |
    Select-Object -ExpandProperty Count
$ReplicaSetTestUri = [string]$env:PAYMENT_REPLICA_SET_TEST_URI
$ReplicaSetDatabase = (($ReplicaSetTestUri -split "\?")[0] -split "/")[-1]
$ReplicaSetSkipReason = if ([string]::IsNullOrWhiteSpace($ReplicaSetTestUri)) {
    "PAYMENT_REPLICA_SET_TEST_URI is not set."
} elseif ($ReplicaSetDatabase -notmatch "(?i)(?:^|[-_])test$") {
    "PAYMENT_REPLICA_SET_TEST_URI must use a database name ending in -test or _test."
} else {
    $null
}

if ([string]$env:REQUIRE_REPLICA_TESTS -eq "1" -and $ReplicaSetSkipReason) {
    throw "REQUIRE_REPLICA_TESTS=1: the real replica-set payment suite is required: $ReplicaSetSkipReason"
}

if ($MissingPayOSConfigCount -eq 0 -and $ReplicaSetSkipReason) {
    throw "PayOS is configured; the real replica-set payment suite is required: $ReplicaSetSkipReason"
}

if ($ReplicaSetSkipReason) {
    Write-Output "[QA] Replica-set payment suite: SKIPPED - $ReplicaSetSkipReason"
} else {
    Write-Output "[QA] Replica-set payment suite: EXECUTED - PAYMENT_REPLICA_SET_TEST_URI is configured."
}

if ($CheckReplicaSet) { exit 0 }

$backendTests = @(
    "tests/authContracts.test.js",
    "tests/adminContracts.test.js",
    "tests/plans.test.js",
    "tests/paymentPlans.test.js",
    "tests/paymentControllerZeroTotal.test.js",
    "tests/paymentWebhookTransition.test.js",
    "tests/paymentStatusSync.test.js",
    "tests/paymentReplicaSet.integration.test.js",
    "tests/releaseReplicaGate.test.js",
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
