param(
    [ValidateSet("Release", "LocalIncomplete")]
    [string]$Mode = "Release"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
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
    if ($Value -notmatch "(?i)^mongodb(?:\+srv)?://") { return $false }
    $withoutQuery = ($Value -split "[?#]", 2)[0]
    $schemeEnd = $withoutQuery.IndexOf("://") + 3
    $pathStart = $withoutQuery.IndexOf("/", $schemeEnd)
    if ($pathStart -lt 0 -or $pathStart -eq ($withoutQuery.Length - 1)) { return $false }
    $authority = $withoutQuery.Substring($schemeEnd, $pathStart - $schemeEnd)
    $database = $withoutQuery.Substring($pathStart + 1)
    if ([string]::IsNullOrWhiteSpace($authority) -or $database.Contains("/")) { return $false }
    try { $database = [Uri]::UnescapeDataString($database) } catch { return $false }
    if ($database.Contains("/") -or $database.Contains("\")) { return $false }
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

function Test-AllTemplateCertification {
    $converterRoot = Join-Path $Root "converter"
    Push-Location -LiteralPath $converterRoot
    try {
        $output = @(& python -m app.misa_templates verify --require-export-safe 2>$null)
        if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { return $false }
        $verified = ($output -join "`n") | ConvertFrom-Json
        $verifiedTemplateCount = @($verified.PSObject.Properties).Count
        return $verifiedTemplateCount -eq 7
    } catch {
        return $false
    } finally {
        Pop-Location
    }
}

function Resolve-RepoContainedFile {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    try {
        $rootPath = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
        $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { return $null }
        $relative = [IO.Path]::GetRelativePath($rootPath, $resolved)
        if (
            [IO.Path]::IsPathRooted($relative) -or
            $relative -eq ".." -or
            $relative.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")
        ) { return $null }
        $portable = $relative.Replace([IO.Path]::DirectorySeparatorChar, '/')
        if ($portable -match '^(?:\.git|\.artifacts|node_modules)/') { return $null }
        return [pscustomobject]@{
            path = $resolved
            repository_path = $portable
        }
    } catch {
        return $null
    }
}

function Get-ApprovedRawFixtureStatus {
    param([string]$FixtureValue, [string]$ManifestValue)

    if ([string]::IsNullOrWhiteSpace($FixtureValue)) {
        return [pscustomobject]@{ Ready = $false; Detail = "QA_RAW_FIXTURE is not set." }
    }
    if ([string]::IsNullOrWhiteSpace($ManifestValue)) {
        return [pscustomobject]@{
            Ready = $false
            Detail = "QA_SYNTHETIC_FIXTURE_MANIFEST is not set."
        }
    }
    $fixture = Resolve-RepoContainedFile $FixtureValue
    $manifestFile = Resolve-RepoContainedFile $ManifestValue
    if ($null -eq $fixture -or $null -eq $manifestFile) {
        return [pscustomobject]@{
            Ready = $false
            Detail = "QA raw fixture and synthetic manifest must be repository-contained files."
        }
    }
    if ([IO.Path]::GetExtension($fixture.path).ToLowerInvariant() -notin @(".xls", ".xlsx")) {
        return [pscustomobject]@{
            Ready = $false
            Detail = "QA_RAW_FIXTURE must be an approved synthetic Excel workbook."
        }
    }

    try {
        $manifest = [IO.File]::ReadAllText($manifestFile.path) | ConvertFrom-Json
        if ([int]$manifest.schema_version -ne 2 -or $null -eq $manifest.fixtures) {
            throw "manifest schema"
        }
        $entries = @($manifest.fixtures.PSObject.Properties | Where-Object {
            [string]$_.Value.path -ceq [string]$fixture.repository_path
        })
        if ($entries.Count -ne 1) { throw "manifest membership" }
        $entry = $entries[0].Value
        $generator = [string]$entry.generator
        $reviewer = [string]$entry.reviewer
        if (
            [string]$entry.source_kind -cne "deterministic_synthetic" -or
            [string]$entry.fixture_kind -cne "synthetic" -or
            [string]$entry.privacy_classification -cne "synthetic_no_customer_data" -or
            $entry.contains_customer_data -ne $false -or
            [string]$entry.approval_status -cne "approved" -or
            [string]$entry.synthetic_fixture_id -cnotmatch '^synthetic-[a-z0-9][a-z0-9._-]{7,127}$' -or
            [string]::IsNullOrWhiteSpace($generator) -or
            [string]::IsNullOrWhiteSpace($reviewer) -or
            [string]::Equals($generator.Trim(), $reviewer.Trim(), [StringComparison]::OrdinalIgnoreCase)
        ) { throw "manifest approval" }
        $approvedAt = [DateTimeOffset]::Parse([string]$entry.approved_at_utc)
        if ($approvedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) { throw "future approval" }
        $expectedHash = [string]$entry.sha256
        if ($expectedHash -cnotmatch '^[0-9a-f]{64}$') { throw "manifest hash" }
        $actualHash = (Get-FileHash -LiteralPath $fixture.path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -cne $expectedHash) { throw "fixture hash" }
    } catch {
        return [pscustomobject]@{
            Ready = $false
            Detail = "QA_RAW_FIXTURE is absent from the approved synthetic manifest or its SHA-256/approval is invalid."
        }
    }
    return [pscustomobject]@{
        Ready = $true
        Detail = "QA_RAW_FIXTURE is repository-contained and matches its approved synthetic manifest SHA-256."
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

$misaRepairUri = [string]$env:MISA_IMPORT_REPAIR_TEST_MONGO_URI
Add-EvidenceCheck "misa_import_repair_mongo" (Test-TestDatabaseUri $misaRepairUri) `
    $(if ([string]::IsNullOrWhiteSpace($misaRepairUri)) {
        "MISA_IMPORT_REPAIR_TEST_MONGO_URI is not set; real MongoDB repair evidence is absent."
    } elseif (-not (Test-TestDatabaseUri $misaRepairUri)) {
        "MISA_IMPORT_REPAIR_TEST_MONGO_URI must use a database ending in -test or _test."
    } else {
        "MISA_IMPORT_REPAIR_TEST_MONGO_URI is configured for real repair tests."
    })

$misaCertificationReady = Test-AllTemplateCertification
Add-EvidenceCheck "misa_certification" $misaCertificationReady `
    $(if ($misaCertificationReady) {
        "All seven MISA templates have valid export-safe certifications backed by controlled MISA receipts."
    } else {
        "All-template export-safe MISA certification evidence is missing or invalid."
    })

$liveNames = @(
    "QA_FRONTEND_URL",
    "QA_GATEWAY_URL",
    "QA_CONVERTER_URL",
    "QA_OWNER_EMAIL",
    "QA_OWNER_PASSWORD",
    "QA_OWNER_JWT",
    "QA_RELEASE_ID",
    "QA_RAW_FIXTURE",
    "QA_SYNTHETIC_FIXTURE_MANIFEST"
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
$rawFixtureStatus = Get-ApprovedRawFixtureStatus `
    ([string]$env:QA_RAW_FIXTURE) `
    ([string]$env:QA_SYNTHETIC_FIXTURE_MANIFEST)
$rawFixtureReady = [bool]$rawFixtureStatus.Ready
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
    [string]$rawFixtureStatus.Detail
} else {
    "Live gateway/browser inputs and approved synthetic fixture evidence are configured."
}
Add-EvidenceCheck "live_gateway" $liveReady $liveDetail

$orderedMissing = @($missing | Sort-Object -Unique)
$releaseEligible = $orderedMissing.Count -eq 0
$status = if ($Mode -eq "Release") {
    if ($releaseEligible) { "RELEASE_READY" } else { "RELEASE_BLOCKED" }
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
