param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$ReleaseId = (Get-Date -Format "yyyyMMdd-HHmmss"),
    [string]$FrontendUrl,
    [string]$ConverterUrl,
    [string]$GatewayUrl,
    [string]$LiveContractFile,
    [string]$ChargeAuditBeforeFile,
    [string]$ChargeAuditAfterFile,
    [string]$IntegrationFixture,
    [switch]$RequireLive,
    [switch]$AllowLocalHttp,
    [switch]$AllowIncompleteDiagnostics
)

$ErrorActionPreference = "Stop"
$artifactRoot = Join-Path $RepoRoot ".artifacts\qa\converter-gateway\$ReleaseId"
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

$failed = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[string]]::new()
$results = [System.Collections.Generic.List[object]]::new()
$liveContract = $null
$normalizedFrontendUrl = $null
$normalizedConverterUrl = $null
$normalizedGatewayUrl = $null

function Write-EvidenceFile {
    param([string]$Name, [object]$Value)

    $path = Join-Path $artifactRoot $Name
    if ($Value -is [string] -or $Value -is [array]) {
        $Value | Set-Content -LiteralPath $path -Encoding utf8
    } else {
        $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $path -Encoding utf8
    }
    return $path
}

function Add-GateResult {
    param(
        [string]$Name,
        [ValidateSet("pass", "fail", "skip")][string]$Status,
        [string]$Detail = "",
        [string]$Log = $null,
        [double]$Seconds = 0
    )

    if ($Status -eq "fail") { $failed.Add($Name) }
    if ($Status -eq "skip") { $skipped.Add($Name) }
    $results.Add([ordered]@{
        name = $Name
        status = $Status
        seconds = [math]::Round($Seconds, 3)
        detail = $Detail
        log = $Log
    })
    $colour = @{ pass = "Green"; fail = "Red"; skip = "Yellow" }[$Status]
    Write-Host "$($Status.ToUpperInvariant()) $Name $Detail" -ForegroundColor $colour
}

function Invoke-GateStep {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string]$Executable,
        [string[]]$Arguments
    )

    $logPath = Join-Path $artifactRoot ((($Name -replace "[^a-zA-Z0-9._-]", "-").ToLowerInvariant()) + ".log")
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments 2>&1 | Tee-Object -FilePath $logPath
        if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
        Add-GateResult -Name $Name -Status pass -Log $logPath -Seconds $watch.Elapsed.TotalSeconds
    } catch {
        $_ | Out-String | Add-Content -LiteralPath $logPath -Encoding utf8
        Add-GateResult -Name $Name -Status fail -Detail $_.Exception.Message -Log $logPath -Seconds $watch.Elapsed.TotalSeconds
    } finally {
        Pop-Location
        $watch.Stop()
    }
}

function Add-MissingLivePrerequisite {
    param([string]$Name, [string]$Detail)

    if ($RequireLive) {
        Add-GateResult -Name $Name -Status fail -Detail $Detail
    } else {
        Add-GateResult -Name $Name -Status skip -Detail $Detail
    }
}

function Restore-Environment {
    param([hashtable]$Snapshot)

    foreach ($name in $Snapshot.Keys) {
        if ($null -eq $Snapshot[$name]) {
            Remove-Item -Path "env:$name" -ErrorAction SilentlyContinue
        } else {
            Set-Item -Path "env:$name" -Value $Snapshot[$name]
        }
    }
}

function Assert-AllowedOrigin {
    param([string]$Value, [string]$Label)

    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Label origin is required" }
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
        throw "$Label must be an absolute origin"
    }
    if ($uri.AbsolutePath -ne "/" -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
        throw "$Label must contain only scheme, host, and optional port"
    }
    $loopbackHosts = @("localhost", "127.0.0.1", "::1")
    if ($uri.Scheme -ne "https") {
        if (-not ($AllowLocalHttp -and $uri.Scheme -eq "http" -and $loopbackHosts -contains $uri.Host)) {
            throw "$Label must use HTTPS; HTTP is allowed only for explicit localhost development"
        }
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
}

function Assert-AllowedKeys {
    param([object]$Value, [string[]]$Allowed, [string]$Label)

    if ($null -eq $Value -or $Value -isnot [psobject]) { throw "$Label must be an object" }
    foreach ($property in $Value.PSObject.Properties) {
        if ($Allowed -notcontains $property.Name) {
            throw "$Label contains forbidden field '$($property.Name)'"
        }
    }
}

function Assert-RequiredText {
    param([object]$Value, [string]$Label)

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { throw "$Label is required" }
    return $text.Trim()
}

function Assert-RunResource {
    param([object]$Resource, [string]$Label, [switch]$RequireProfile)

    Assert-AllowedKeys $Resource @(
        "run_id", "upload_id", "target_template_id", "operation_session_id",
        "profile_id", "profile_version", "profile_state_hash", "session_revision", "state_hash"
    ) $Label
    foreach ($field in @("run_id", "upload_id", "target_template_id", "operation_session_id")) {
        Assert-RequiredText $Resource.$field "$Label.$field" | Out-Null
    }
    if ($RequireProfile) {
        foreach ($field in @("profile_id", "session_revision", "state_hash")) {
            Assert-RequiredText $Resource.$field "$Label.$field" | Out-Null
        }
    }
}

function Assert-LiveContractSchema {
    param([object]$Contract)

    Assert-AllowedKeys $Contract @("schema_version", "release_id", "credentials", "resources") "contract"
    if ([int]$Contract.schema_version -ne 2) { throw "contract.schema_version must be 2" }
    if ((Assert-RequiredText $Contract.release_id "contract.release_id") -ne $ReleaseId) {
        throw "contract.release_id does not match -ReleaseId"
    }
    Assert-AllowedKeys $Contract.credentials @(
        "owner_jwt", "foreign_jwt", "owner_email", "owner_password"
    ) "contract.credentials"
    foreach ($field in @("owner_jwt", "foreign_jwt", "owner_email", "owner_password")) {
        Assert-RequiredText $Contract.credentials.$field "contract.credentials.$field" | Out-Null
    }
    Assert-AllowedKeys $Contract.resources @("owner", "foreign", "wrong_workspace", "duplicate_export") "contract.resources"
    Assert-RunResource $Contract.resources.owner "contract.resources.owner" -RequireProfile
    Assert-RunResource $Contract.resources.foreign "contract.resources.foreign"
    Assert-RunResource $Contract.resources.wrong_workspace "contract.resources.wrong_workspace"
    Assert-AllowedKeys $Contract.resources.duplicate_export @("idempotency_key") "contract.resources.duplicate_export"
    Assert-RequiredText $Contract.resources.duplicate_export.idempotency_key "contract.resources.duplicate_export.idempotency_key" | Out-Null
}

function Join-HttpUrl {
    param([string]$Origin, [string]$Path)
    return "{0}/{1}" -f $Origin.TrimEnd("/"), $Path.TrimStart("/")
}

function Get-ResponseBytes {
    param([object]$Response)

    if ($Response.Content -is [byte[]]) { return [byte[]]$Response.Content }
    if ($Response.RawContentStream) {
        $stream = $Response.RawContentStream
        $position = $stream.Position
        $stream.Position = 0
        $memory = [IO.MemoryStream]::new()
        $stream.CopyTo($memory)
        $stream.Position = $position
        return $memory.ToArray()
    }
    return [Text.Encoding]::UTF8.GetBytes([string]$Response.Content)
}

function Invoke-HttpGate {
    param(
        [string]$Name,
        [string]$Url,
        [ValidateSet("GET", "POST", "OPTIONS")][string]$Method,
        [int[]]$ExpectedStatus,
        [hashtable]$Headers = @{},
        [object]$Body = $null,
        [switch]$MustNotAllowCors
    )

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $request = @{
            Uri = $Url
            Method = $Method
            Headers = $Headers
            SkipHttpErrorCheck = $true
            TimeoutSec = 30
        }
        if ($null -ne $Body) {
            $request.ContentType = "application/json"
            $request.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 12 -Compress }
        }
        $response = Invoke-WebRequest @request
        $status = [int]$response.StatusCode
        $allowedOrigin = $response.Headers["Access-Control-Allow-Origin"]
        $bytes = Get-ResponseBytes $response
        $artifactId = [string]($response.Headers["X-Export-Artifact-Key"] ?? $response.Headers["X-Converter-Artifact-Id"])
        $safeHeaders = @{}
        foreach ($header in @("Content-Type", "Content-Length", "Access-Control-Allow-Origin", "X-Export-Artifact-Key")) {
            if ($response.Headers[$header]) { $safeHeaders[$header] = [string]$response.Headers[$header] }
        }
        $evidence = [ordered]@{
            name = $Name
            status = $status
            expected_status = $ExpectedStatus
            headers = $safeHeaders
            artifact_id = $artifactId
            body_sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        }
        Write-EvidenceFile "$($Name -replace '[^a-zA-Z0-9._-]', '-').json" $evidence | Out-Null
        if ($ExpectedStatus -notcontains $status) {
            throw "Expected HTTP $($ExpectedStatus -join '/') but received $status"
        }
        if ($MustNotAllowCors -and $allowedOrigin) {
            throw "Denied CORS request returned Access-Control-Allow-Origin"
        }
        Add-GateResult -Name $Name -Status pass -Detail "HTTP $status" -Seconds $watch.Elapsed.TotalSeconds
        return [pscustomobject]@{ Response = $response; Evidence = $evidence }
    } catch {
        Add-GateResult -Name $Name -Status fail -Detail $_.Exception.Message -Seconds $watch.Elapsed.TotalSeconds
        return $null
    } finally {
        $watch.Stop()
    }
}

function New-GatewayHeaders {
    param([string]$Jwt, [string]$ContextToken, [string]$IdempotencyKey)

    $headers = @{ Authorization = "Bearer $(Assert-RequiredText $Jwt 'JWT')" }
    if ($ContextToken) { $headers["X-Conversion-Context"] = $ContextToken }
    if ($IdempotencyKey) { $headers["Idempotency-Key"] = $IdempotencyKey }
    return $headers
}

function New-ExportBody {
    param([object]$Resource, [string]$ProfileId)

    $body = [ordered]@{
        upload_id = [string]$Resource.upload_id
        profile_id = $ProfileId
        run_id = [string]$Resource.run_id
        conversion_run_id = [string]$Resource.run_id
        target_template_id = [string]$Resource.target_template_id
        session_id = [string]$Resource.operation_session_id
        acknowledge_warnings = $true
    }
    if ($Resource.session_revision) { $body.revision = [int]$Resource.session_revision }
    if ($Resource.state_hash) { $body.state_hash = [string]$Resource.state_hash }
    if ($Resource.profile_version) { $body.profile_version = [int]$Resource.profile_version }
    if ($Resource.profile_state_hash) { $body.profile_state_hash = [string]$Resource.profile_state_hash }
    return $body
}

function Get-FreshRunContext {
    param([string]$Name, [string]$Jwt, [object]$Resource)

    $result = Invoke-HttpGate -Name $Name -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/runs/$($Resource.run_id)/context") `
        -Method POST -ExpectedStatus @(200) -Headers (New-GatewayHeaders $Jwt "" "") -Body @{
            upload_id = [string]$Resource.upload_id
            target_template_id = [string]$Resource.target_template_id
            operation_session_id = [string]$Resource.operation_session_id
        }
    if ($null -eq $result) { return $null }
    try {
        $payload = [Text.Encoding]::UTF8.GetString((Get-ResponseBytes $result.Response)) | ConvertFrom-Json
        return Assert-RequiredText $payload.contextToken "$Name.contextToken"
    } catch {
        Add-GateResult -Name "$Name-token" -Status fail -Detail $_.Exception.Message
        return $null
    }
}

function Invoke-DirectConverterChecks {
    Invoke-HttpGate -Name "direct-fastapi-analyze-no-service-token" `
        -Url (Join-HttpUrl $normalizedConverterUrl "/api/v1/uploads/analyze") -Method POST -ExpectedStatus @(401) | Out-Null
    Invoke-HttpGate -Name "direct-fastapi-export-no-service-token" `
        -Url (Join-HttpUrl $normalizedConverterUrl "/api/v1/conversions/export") -Method POST -ExpectedStatus @(401) `
        -Body @{ upload_id = "qa-gateway-missing-token" } | Out-Null
    Invoke-HttpGate -Name "direct-fastapi-cors-denied" `
        -Url (Join-HttpUrl $normalizedConverterUrl "/api/v1/uploads/analyze") -Method OPTIONS -ExpectedStatus @(400, 401, 405) `
        -Headers @{ Origin = "https://untrusted.example"; "Access-Control-Request-Method" = "POST" } -MustNotAllowCors | Out-Null
}

function Invoke-NodeJwtCheck {
    Invoke-HttpGate -Name "node-gateway-analyze-no-jwt" `
        -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/uploads/analyze") -Method POST -ExpectedStatus @(401) | Out-Null
}

function Invoke-OversizedUploadCheck {
    param([string]$OwnerJwt)

    $path = Join-Path $artifactRoot "oversized-upload.xlsx"
    $stream = [IO.File]::Open($path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.SetLength((20 * 1024 * 1024) + 1) } finally { $stream.Dispose() }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri (Join-HttpUrl $normalizedGatewayUrl "/api/converter/uploads/analyze") `
            -Method POST -Headers (New-GatewayHeaders $OwnerJwt "" "qa-$ReleaseId-oversize") `
            -Form @{ file = Get-Item -LiteralPath $path; target_template_id = "bsn_sales"; use_ai = "false" } `
            -SkipHttpErrorCheck -TimeoutSec 60
        $status = [int]$response.StatusCode
        Write-EvidenceFile "oversized-upload.json" ([ordered]@{
            status = $status
            expected_status = 413
            bytes = (Get-Item -LiteralPath $path).Length
        }) | Out-Null
        if ($status -ne 413) { throw "Expected HTTP 413 but received $status" }
        Add-GateResult -Name "oversized-upload-413" -Status pass -Detail "HTTP 413" -Seconds $watch.Elapsed.TotalSeconds
    } catch {
        Add-GateResult -Name "oversized-upload-413" -Status fail -Detail $_.Exception.Message -Seconds $watch.Elapsed.TotalSeconds
    } finally {
        $watch.Stop()
        [IO.File]::Delete($path)
    }
}

function Assert-AuditBinding {
    param([object]$Evidence, [string]$Label, [string]$RunId, [string]$IdempotencyKey)

    foreach ($field in @("release_id", "run_id", "idempotency_key", "measured_at", "charge_count", "artifact_count", "artifact_ids")) {
        if ($null -eq $Evidence.$field) { throw "$Label.$field is required" }
    }
    if ([string]$Evidence.release_id -ne $ReleaseId) { throw "$Label.release_id mismatch" }
    if ([string]$Evidence.run_id -ne $RunId) { throw "$Label.run_id mismatch" }
    if ([string]$Evidence.idempotency_key -ne $IdempotencyKey) { throw "$Label.idempotency_key mismatch" }
    if ($Evidence.artifact_ids -is [string] -or $Evidence.artifact_ids -isnot [array]) {
        throw "$Label.artifact_ids must be an array"
    }
    $measuredAt = [DateTimeOffset]::Parse([string]$Evidence.measured_at)
    return $measuredAt
}

function Read-JsonEvidence {
    param([string]$Path, [string]$Label)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label evidence file is required"
    }
    return [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path)) | ConvertFrom-Json
}

function Wait-FreshAfterAudit {
    param([DateTimeOffset]$NotBefore)

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    do {
        if (-not [string]::IsNullOrWhiteSpace($ChargeAuditAfterFile) -and (Test-Path -LiteralPath $ChargeAuditAfterFile -PathType Leaf)) {
            try {
                $candidate = Read-JsonEvidence $ChargeAuditAfterFile "after audit"
                $measuredAt = [DateTimeOffset]::Parse([string]$candidate.measured_at)
                $lastWrite = [DateTimeOffset](Get-Item -LiteralPath $ChargeAuditAfterFile).LastWriteTimeUtc
                if ($measuredAt -ge $NotBefore -and $lastWrite -ge $NotBefore.AddSeconds(-1)) { return $candidate }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "After audit was not generated after the duplicate export responses"
}

function Invoke-DuplicateExportCheck {
    param([string]$OwnerJwt, [string]$OwnerContext, [object]$Owner, [string]$IdempotencyKey)

    try {
        $before = Read-JsonEvidence $ChargeAuditBeforeFile "before audit"
        $beforeMeasuredAt = Assert-AuditBinding $before "before audit" ([string]$Owner.run_id) $IdempotencyKey
        if ([DateTimeOffset]::UtcNow - $beforeMeasuredAt -gt [TimeSpan]::FromMinutes(10)) {
            throw "Before audit is stale"
        }
        if ([int]$before.charge_count -ne 0 -or [int]$before.artifact_count -ne 0 -or @($before.artifact_ids).Count -ne 0) {
            throw "Before audit must show zero charges and zero artifacts for this synthetic run"
        }

        $headers = New-GatewayHeaders $OwnerJwt $OwnerContext $IdempotencyKey
        $body = New-ExportBody $Owner ([string]$Owner.profile_id)
        $first = Invoke-HttpGate -Name "duplicate-export-first" -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/conversions/export") `
            -Method POST -ExpectedStatus @(200) -Headers $headers -Body $body
        $second = Invoke-HttpGate -Name "duplicate-export-second" -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/conversions/export") `
            -Method POST -ExpectedStatus @(200) -Headers $headers -Body $body
        if ($null -eq $first -or $null -eq $second) { throw "One duplicate export request failed" }
        if ($first.Evidence.body_sha256 -ne $second.Evidence.body_sha256) {
            throw "Duplicate export returned different artifact bytes"
        }
        $artifactId = Assert-RequiredText $first.Evidence.artifact_id "first export artifact_id"
        if ($artifactId -ne (Assert-RequiredText $second.Evidence.artifact_id "second export artifact_id")) {
            throw "Duplicate export returned different artifact_id values"
        }

        $responsesFinishedAt = [DateTimeOffset]::UtcNow
        $after = Wait-FreshAfterAudit $responsesFinishedAt
        $afterMeasuredAt = Assert-AuditBinding $after "after audit" ([string]$Owner.run_id) $IdempotencyKey
        if ($afterMeasuredAt -lt $responsesFinishedAt) { throw "After audit predates duplicate export completion" }
        if ([int]$after.charge_count -ne 1 -or [int]$after.artifact_count -ne 1) {
            throw "After audit must show exactly one charge and one artifact"
        }
        if (@($after.artifact_ids) -notcontains $artifactId) {
            throw "After audit is not bound to response artifact_id"
        }
        Add-GateResult -Name "duplicate-export" -Status pass -Detail "release/run/idempotency/artifact and 0->1 charge audit verified"
    } catch {
        Add-GateResult -Name "duplicate-export" -Status fail -Detail $_.Exception.Message
    }
}

function Invoke-ConfiguredLiveChecks {
    $credentials = $liveContract.credentials
    $resources = $liveContract.resources
    $ownerJwt = [string]$credentials.owner_jwt
    $foreignJwt = [string]$credentials.foreign_jwt
    $ownerContext = Get-FreshRunContext "owner-context-refresh" $ownerJwt $resources.owner
    $foreignContext = Get-FreshRunContext "foreign-context-refresh" $foreignJwt $resources.foreign
    $wrongWorkspaceContext = Get-FreshRunContext "wrong-workspace-context-refresh" $ownerJwt $resources.wrong_workspace
    if (-not $ownerContext -or -not $foreignContext -or -not $wrongWorkspaceContext) { return }

    $ownerBody = New-ExportBody $resources.owner ([string]$resources.owner.profile_id)
    Invoke-HttpGate -Name "wrong-workspace" -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/conversions/export") `
        -Method POST -ExpectedStatus @(409) -Headers (New-GatewayHeaders $ownerJwt $wrongWorkspaceContext "") -Body $ownerBody | Out-Null

    $foreignUploadBody = New-ExportBody $resources.owner ([string]$resources.owner.profile_id)
    $foreignUploadBody.upload_id = [string]$resources.foreign.upload_id
    Invoke-HttpGate -Name "foreign-upload" -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/conversions/export") `
        -Method POST -ExpectedStatus @(409) -Headers (New-GatewayHeaders $ownerJwt $ownerContext "") -Body $foreignUploadBody | Out-Null

    $foreignProfileBody = New-ExportBody $resources.owner ([string]$resources.foreign.profile_id)
    Invoke-HttpGate -Name "foreign-profile" -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/conversions/export") `
        -Method POST -ExpectedStatus @(400) -Headers (New-GatewayHeaders $ownerJwt $ownerContext "") -Body $foreignProfileBody | Out-Null

    Invoke-HttpGate -Name "foreign-run" -Url (Join-HttpUrl $normalizedGatewayUrl "/api/converter/conversions/export") `
        -Method POST -ExpectedStatus @(403) -Headers (New-GatewayHeaders $ownerJwt $foreignContext "") -Body $ownerBody | Out-Null

    Invoke-OversizedUploadCheck $ownerJwt
    Invoke-DuplicateExportCheck $ownerJwt $ownerContext $resources.owner ([string]$resources.duplicate_export.idempotency_key)
}

function Invoke-PlaywrightLiveApiSecurity {
    if ([string]::IsNullOrWhiteSpace($IntegrationFixture)) {
        $IntegrationFixture = Join-Path $RepoRoot "converter\fixtures\samples\raw_sales_sample.xlsx"
    }
    if (-not (Test-Path -LiteralPath $IntegrationFixture -PathType Leaf)) {
        Add-GateResult -Name "playwright-live-api-security" -Status fail -Detail "Integration fixture not found"
        return
    }
    $previous = @{
        QA_GATEWAY_URL = $env:QA_GATEWAY_URL
        QA_CONVERTER_URL = $env:QA_CONVERTER_URL
        QA_OWNER_JWT = $env:QA_OWNER_JWT
        QA_RELEASE_ID = $env:QA_RELEASE_ID
        QA_RAW_FIXTURE = $env:QA_RAW_FIXTURE
        QA_EXPECT_LIVE = $env:QA_EXPECT_LIVE
    }
    try {
        $env:QA_GATEWAY_URL = $normalizedGatewayUrl
        $env:QA_CONVERTER_URL = $normalizedConverterUrl
        $env:QA_OWNER_JWT = [string]$liveContract.credentials.owner_jwt
        $env:QA_RELEASE_ID = $ReleaseId
        $env:QA_RAW_FIXTURE = (Resolve-Path -LiteralPath $IntegrationFixture).Path
        $env:QA_EXPECT_LIVE = "true"
        Invoke-GateStep "playwright-live-api-security" (Join-Path $RepoRoot "frontend") "npm" @("run", "test:converter-gateway-api-integration")
    } finally {
        Restore-Environment $previous
    }
}

function Invoke-PlaywrightLiveUiJourney {
    if ([string]::IsNullOrWhiteSpace($IntegrationFixture)) {
        $IntegrationFixture = Join-Path $RepoRoot "converter\fixtures\samples\raw_sales_sample.xlsx"
    }
    if (-not (Test-Path -LiteralPath $IntegrationFixture -PathType Leaf)) {
        Add-GateResult -Name "playwright-live-ui-journey" -Status fail -Detail "Integration fixture not found"
        return
    }
    $previous = @{
        QA_FRONTEND_URL = $env:QA_FRONTEND_URL
        QA_GATEWAY_URL = $env:QA_GATEWAY_URL
        QA_OWNER_EMAIL = $env:QA_OWNER_EMAIL
        QA_OWNER_PASSWORD = $env:QA_OWNER_PASSWORD
        QA_RAW_FIXTURE = $env:QA_RAW_FIXTURE
        QA_EXPECT_LIVE = $env:QA_EXPECT_LIVE
    }
    try {
        $env:QA_FRONTEND_URL = $normalizedFrontendUrl
        $env:QA_GATEWAY_URL = $normalizedGatewayUrl
        $env:QA_OWNER_EMAIL = [string]$liveContract.credentials.owner_email
        $env:QA_OWNER_PASSWORD = [string]$liveContract.credentials.owner_password
        $env:QA_RAW_FIXTURE = (Resolve-Path -LiteralPath $IntegrationFixture).Path
        $env:QA_EXPECT_LIVE = "true"
        Invoke-GateStep "playwright-live-ui-journey" (Join-Path $RepoRoot "frontend") "npm" @("run", "test:converter-gateway-integration")
    } finally {
        Restore-Environment $previous
    }
}

Write-EvidenceFile "runtime.json" ([ordered]@{
    generated_at = [DateTimeOffset]::Now.ToString("o")
    release_id = $ReleaseId
    require_live = $RequireLive.IsPresent
    allow_local_http = $AllowLocalHttp.IsPresent
    node = (& node --version)
    python = (& python --version 2>&1)
}) | Out-Null

Invoke-GateStep "backend-gateway-contract" (Join-Path $RepoRoot "backend") "node" @(
    "--test",
    "tests/converterGateway.test.js",
    "tests/converterGatewayContract.test.js",
    "tests/conversionEntitlement.test.js",
    "tests/conversionRuns.test.js"
)
Invoke-GateStep "converter-internal-security" (Join-Path $RepoRoot "converter") "python" @(
    "-m", "pytest", "-q", "tests/test_internal_auth.py", "tests/test_upload_limits.py", "tests/test_misa_readiness_api.py"
)
Invoke-GateStep "frontend-gateway-journeys-supplemental" (Join-Path $RepoRoot "frontend") "npm" @("run", "test:converter-gateway-journey")

if (-not $RequireLive) {
    Add-MissingLivePrerequisite "release-live-mode" "-RequireLive was not supplied"
    Add-MissingLivePrerequisite "playwright-live-api-security" "Live gateway/converter contract was not supplied"
    Add-MissingLivePrerequisite "playwright-live-ui-journey" "Frontend URL and short-lived UI credentials were not supplied"
} else {
    try {
        $normalizedFrontendUrl = Assert-AllowedOrigin $FrontendUrl "FrontendUrl"
        $normalizedConverterUrl = Assert-AllowedOrigin $ConverterUrl "ConverterUrl"
        $normalizedGatewayUrl = Assert-AllowedOrigin $GatewayUrl "GatewayUrl"
        if ($normalizedConverterUrl -eq $normalizedGatewayUrl) {
            throw "ConverterUrl and GatewayUrl must be distinct origins"
        }
        if ($normalizedFrontendUrl -in @($normalizedConverterUrl, $normalizedGatewayUrl)) {
            throw "FrontendUrl must be distinct from ConverterUrl and GatewayUrl"
        }
        if ([string]::IsNullOrWhiteSpace($LiveContractFile) -or -not (Test-Path -LiteralPath $LiveContractFile -PathType Leaf)) {
            throw "-LiveContractFile is required"
        }
        $liveContract = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $LiveContractFile)) | ConvertFrom-Json
        Assert-LiveContractSchema $liveContract
        Add-GateResult -Name "live-contract" -Status pass -Detail "Fixed schema and trusted origins verified"
        Invoke-DirectConverterChecks
        Invoke-NodeJwtCheck
        Invoke-ConfiguredLiveChecks
        Invoke-PlaywrightLiveApiSecurity
        Invoke-PlaywrightLiveUiJourney
    } catch {
        Add-GateResult -Name "live-contract" -Status fail -Detail $_.Exception.Message
    }
}

$releaseEligible = $RequireLive -and $failed.Count -eq 0 -and $skipped.Count -eq 0
$summary = [ordered]@{
    release_id = $ReleaseId
    generated_at = [DateTimeOffset]::Now.ToString("o")
    status = if ($failed.Count -gt 0) { "fail" } elseif ($releaseEligible) { "pass" } else { "incomplete" }
    release_eligible = $releaseEligible
    failed = @($failed)
    skipped = @($skipped)
    results = @($results)
}
Write-EvidenceFile "summary.json" $summary | Out-Null

if ($failed.Count -gt 0) {
    Write-Host "`nCONVERTER GATEWAY GATE FAILED" -ForegroundColor Red
    Write-Host "Evidence: $artifactRoot" -ForegroundColor Yellow
    exit 1
}
if (-not $releaseEligible) {
    Write-Host "`nCONVERTER GATEWAY GATE INCOMPLETE; LIVE RELEASE PROOF MISSING" -ForegroundColor Yellow
    Write-Host "Evidence: $artifactRoot" -ForegroundColor Yellow
    if ($AllowIncompleteDiagnostics) { exit 0 }
    exit 2
}

Write-Host "`nCONVERTER GATEWAY RELEASE GATE PASSED" -ForegroundColor Green
Write-Host "Evidence: $artifactRoot" -ForegroundColor Gray
exit 0
