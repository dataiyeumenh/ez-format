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

    $clean = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($clean.ExitCode -ne 0) {
        throw "Canonical verifier rejected clean fixture:`n$($clean.Output)"
    }

    Set-Content -LiteralPath (Join-Path $tempRoot "backend/alternateServer.js") -Value @'
app.use("/api/reconstructions", require("./routes/reconstructions"));
'@
    $duplicateRoute = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($duplicateRoute.ExitCode -eq 0 -or $duplicateRoute.Output -notmatch "Duplicate reconstruction route mount") {
        throw "Canonical verifier missed duplicate reconstruction route mount:`n$($duplicateRoute.Output)"
    }
    Remove-Item -LiteralPath (Join-Path $tempRoot "backend/alternateServer.js") -Force

    Set-Content -LiteralPath (Join-Path $tempRoot "backend/models/ReconstructionProfileCopy.js") -Value @'
module.exports = mongoose.model("ReconstructionProfile", schema);
'@
    $duplicateModel = Invoke-CanonicalVerifier -FixtureRoot $tempRoot
    if ($duplicateModel.ExitCode -eq 0 -or $duplicateModel.Output -notmatch "Duplicate Mongoose model registration") {
        throw "Canonical verifier missed duplicate Mongoose model registration:`n$($duplicateModel.Output)"
    }

    Write-Output "PASS verify-transplant-manifest canonical reconstruction invariants"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
