$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$verifier = Join-Path $repoRoot "scripts/verify-transplant-manifest.ps1"
$tempRoot = [IO.Path]::GetFullPath(
    (Join-Path ([IO.Path]::GetTempPath()) ("ez-format-transplant-" + [guid]::NewGuid()))
)
$systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $tempRoot.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe verifier fixture path: $tempRoot"
}

function Invoke-CanonicalVerifier {
    param([string]$FixtureRoot)

    $output = @(& pwsh -NoProfile -File $verifier -RepoRoot $FixtureRoot -CanonicalOnly 2>&1)
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = $output -join "`n"
    }
}

try {
    New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "backend/models") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "backend/routes") | Out-Null
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/server.js") -Value @'
app.use("/api/reconstructions", require("./routes/reconstructions"));
'@
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/routes/reconstructions.js") -Value @'
module.exports = router;
'@
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/models/ReconstructionProfile.js") -Value @'
module.exports = mongoose.model("ReconstructionProfile", schema);
'@
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/models/VoucherReconstructionRun.js") -Value @'
module.exports = mongoose.model("VoucherReconstructionRun", schema);
'@
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/models/ReconstructionDecision.js") -Value @'
module.exports = mongoose.model("ReconstructionDecision", schema);
'@

    $clean = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($clean.ExitCode -ne 0) {
        throw "Canonical verifier rejected clean fixture:`n$($clean.Output)"
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "backend/nested") | Out-Null
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/nested/server.js") -Value @'
app.use("/api/reconstructions", require("../routes/reconstructions"));
'@
    $nestedDuplicateRoute = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($nestedDuplicateRoute.ExitCode -eq 0 -or $nestedDuplicateRoute.Output -notmatch "Duplicate reconstruction route mount") {
        throw "Canonical verifier missed nested duplicate reconstruction route mount:`n$($nestedDuplicateRoute.Output)"
    }
    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/nested/server.js") -Force

    New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "backend/routes/nested") | Out-Null
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/routes/nested/reconstructions.js") -Value @'
module.exports = router;
'@
    $nestedDuplicateModule = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($nestedDuplicateModule.ExitCode -eq 0 -or $nestedDuplicateModule.Output -notmatch "Duplicate reconstruction route module") {
        throw "Canonical verifier missed nested duplicate reconstruction route module:`n$($nestedDuplicateModule.Output)"
    }
    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/routes/nested/reconstructions.js") -Force

    New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "backend/models/nested") | Out-Null
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/models/nested/ReconstructionDecisionCopy.js") -Value @'
module.exports = mongoose.model("ReconstructionDecision", schema);
'@
    $nestedDuplicateModel = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($nestedDuplicateModel.ExitCode -eq 0 -or $nestedDuplicateModel.Output -notmatch "Duplicate Mongoose model registration 'ReconstructionDecision'") {
        throw "Canonical verifier missed nested duplicate ReconstructionDecision registration:`n$($nestedDuplicateModel.Output)"
    }
    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/models/nested/ReconstructionDecisionCopy.js") -Force

    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/server.js") -Force
    $missingMount = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($missingMount.ExitCode -eq 0 -or $missingMount.Output -notmatch "Expected exactly one reconstruction route mount") {
        throw "Canonical verifier allowed a missing reconstruction route mount:`n$($missingMount.Output)"
    }
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/server.js") -Value @'
app.use("/api/reconstructions", require("./routes/reconstructions"));
'@

    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/routes/reconstructions.js") -Force
    $missingModule = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($missingModule.ExitCode -eq 0 -or $missingModule.Output -notmatch "Expected exactly one reconstruction route module") {
        throw "Canonical verifier allowed a missing reconstruction route module:`n$($missingModule.Output)"
    }
    Set-Content -LiteralPath (Join-Path $tempRoot "backend/routes/reconstructions.js") -Value @'
module.exports = router;
'@

    Set-Content -LiteralPath (Join-Path $tempRoot "backend/alternateServer.js") -Value @'
app.use("/api/reconstructions", require("./routes/reconstructions"));
'@
    $duplicateRoute = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($duplicateRoute.ExitCode -eq 0 -or $duplicateRoute.Output -notmatch "Duplicate reconstruction route mount") {
        throw "Canonical verifier missed duplicate reconstruction route mount:`n$($duplicateRoute.Output)"
    }
    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/alternateServer.js") -Force

    foreach ($model in @("VoucherReconstructionRun", "ReconstructionProfile", "ReconstructionDecision")) {
        Set-Content -LiteralPath (Join-Path $tempRoot "backend/models/$($model)Copy.js") -Value "module.exports = mongoose.model(`"$model`", schema);"
        $duplicateModel = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
        if ($duplicateModel.ExitCode -eq 0 -or $duplicateModel.Output -notmatch "Duplicate Mongoose model registration '$model'") {
            throw "Canonical verifier missed duplicate Mongoose model registration for ${model}:`n$($duplicateModel.Output)"
        }
        Remove-Item -LiteralPath (Join-Path $tempRoot "backend/models/$($model)Copy.js") -Force
    }

    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/models/ReconstructionDecision.js") -Force
    $missingModel = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($missingModel.ExitCode -eq 0 -or $missingModel.Output -notmatch "Expected exactly one Mongoose model registration 'ReconstructionDecision'") {
        throw "Canonical verifier allowed a missing ReconstructionDecision registration:`n$($missingModel.Output)"
    }

    Write-Output "PASS verify-transplant-manifest canonical reconstruction invariants"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
