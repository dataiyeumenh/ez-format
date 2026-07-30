param(
    [ValidateSet("Release", "LocalIncomplete")]
    [string]$Mode = "Release"
)

$ErrorActionPreference = "Stop"
$script:Checks = @()
$missing = [System.Collections.Generic.List[string]]::new()

function Add-EvidenceCheck {
    param(
        [string]$Name,
        [bool]$Ready,
        [string]$Detail
    )

    $script:Checks += [ordered]@{
        name = $Name
        status = if ($Ready) { "READY" } else { "MISSING" }
        detail = $Detail
    }
    if (-not $Ready) { [void]$missing.Add($Name) }
}

function Test-TestDatabaseUri {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $database = (($Value -split "\?")[0] -split "/")[-1]
    return $database -match "(?i)(?:^|[-_])test$"
}

function Test-HttpsUrl {
    param([string]$Value)

    try {
        $uri = [Uri]$Value
        return $uri.Scheme -eq "https" -and -not [string]::IsNullOrWhiteSpace($uri.Host)
    } catch {
        return $false
    }
}

$replicaUri = [string]$env:PAYMENT_REPLICA_SET_TEST_URI
Add-EvidenceCheck "replica_mongo" (Test-TestDatabaseUri $replicaUri) `
    $(if ([string]::IsNullOrWhiteSpace($replicaUri)) {
        "PAYMENT_REPLICA_SET_TEST_URI is not set."
    } elseif (-not (Test-TestDatabaseUri $replicaUri)) {
        "PAYMENT_REPLICA_SET_TEST_URI must use a database name ending in -test or _test."
    } else {
        "PAYMENT_REPLICA_SET_TEST_URI is configured for a test database."
    })

$gridFsUri = [string]$env:GRIDFS_INTEGRATION_TEST_URI
Add-EvidenceCheck "gridfs" (Test-TestDatabaseUri $gridFsUri) `
    $(if ([string]::IsNullOrWhiteSpace($gridFsUri)) {
        "GRIDFS_INTEGRATION_TEST_URI is not set; real MongoDB/GridFS round-trip evidence is absent."
    } elseif (-not (Test-TestDatabaseUri $gridFsUri)) {
        "GRIDFS_INTEGRATION_TEST_URI must use a database name ending in -test or _test."
    } else {
        "GRIDFS_INTEGRATION_TEST_URI is configured for the real GridFS integration test."
    })

$liveNames = @(
    "QA_FRONTEND_URL",
    "QA_GATEWAY_URL",
    "QA_CONVERTER_URL",
    "QA_OWNER_EMAIL",
    "QA_OWNER_PASSWORD",
    "QA_OWNER_JWT",
    "QA_RELEASE_ID",
    "QA_RAW_FIXTURE"
)
$liveMissing = @($liveNames | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
})
$liveUrlsValid = @("QA_FRONTEND_URL", "QA_GATEWAY_URL", "QA_CONVERTER_URL" | ForEach-Object {
    Test-HttpsUrl ([Environment]::GetEnvironmentVariable($_))
}) -notcontains $false
$gatewayOriginsDistinct = $false
try {
    $gatewayOriginsDistinct = ([Uri]$env:QA_FRONTEND_URL).GetLeftPart([UriPartial]::Authority) -ne
        ([Uri]$env:QA_GATEWAY_URL).GetLeftPart([UriPartial]::Authority) -and
        ([Uri]$env:QA_GATEWAY_URL).GetLeftPart([UriPartial]::Authority) -ne
        ([Uri]$env:QA_CONVERTER_URL).GetLeftPart([UriPartial]::Authority)
} catch {
    $gatewayOriginsDistinct = $false
}
$rawFixtureReady = -not [string]::IsNullOrWhiteSpace($env:QA_RAW_FIXTURE) -and
    (Test-Path -LiteralPath $env:QA_RAW_FIXTURE -PathType Leaf)
$liveReady = $env:QA_EXPECT_LIVE -eq "true" -and
    $liveMissing.Count -eq 0 -and
    $liveUrlsValid -and
    $gatewayOriginsDistinct -and
    $rawFixtureReady
$liveDetail = if ($env:QA_EXPECT_LIVE -ne "true") {
    "QA_EXPECT_LIVE=true is not set; live gateway/browser evidence is absent."
} elseif ($liveMissing.Count -gt 0) {
    "Missing live inputs: $($liveMissing -join ", ")."
} elseif (-not $liveUrlsValid -or -not $gatewayOriginsDistinct) {
    "Live frontend, gateway, and converter HTTPS origins are invalid or not distinct."
} elseif (-not $rawFixtureReady) {
    "QA_RAW_FIXTURE must point to an existing release fixture."
} else {
    "Live gateway/browser inputs are configured."
}
Add-EvidenceCheck "live_gateway" $liveReady $liveDetail

$orderedMissing = @($missing | Sort-Object -Unique)
$releaseEligible = $orderedMissing.Count -eq 0
$status = if ($Mode -eq "Release") {
    if ($releaseEligible) { "RELEASE_PREREQUISITES_PRESENT" } else { "RELEASE_BLOCKED" }
} else {
    "LOCAL_INCOMPLETE"
}
$payload = [ordered]@{
    mode = $Mode
    status = $status
    releaseEligible = ($Mode -eq "Release" -and $releaseEligible)
    missing = $orderedMissing
    checks = $script:Checks
}

Write-Output "[QA] Main integration evidence status: $status"
Write-Output ("QA_MAIN_INTEGRATION_STATUS_JSON=" + ($payload | ConvertTo-Json -Compress -Depth 6))
if ($Mode -eq "Release" -and -not $releaseEligible) { exit 2 }
exit 0
