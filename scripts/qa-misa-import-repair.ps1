param(
    [string]$RepoRoot = (Join-Path $PSScriptRoot ".."),
    [switch]$SkipSlowTests
)

$ErrorActionPreference = "Stop"

try {
    $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
} catch {
    throw "RepoRoot does not resolve: $RepoRoot"
}

foreach ($marker in @("package.json", "frontend\package.json", "backend\package.json", "converter\requirements.txt")) {
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedRepoRoot $marker) -PathType Leaf)) {
        throw "RepoRoot is not the EzFormat repository: missing $marker"
    }
}

if (-not $SkipSlowTests) {
    throw "Task 9 focused gate requires -SkipSlowTests; use npm run qa:fast."
}

$artifactRoot = Join-Path $resolvedRepoRoot ".artifacts\qa\misa-import-repair\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$failures = [System.Collections.Generic.List[string]]::new()
$locationPushed = $false

function Invoke-FocusedStep {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string]$Executable,
        [string[]]$Arguments
    )

    $safeName = $Name.ToLowerInvariant() -replace "[^a-z0-9._-]", "-"
    $logPath = Join-Path $artifactRoot "$safeName.log"
    Write-Host "== $Name ==" -ForegroundColor Cyan
    $stepLocationPushed = $false
    try {
        Push-Location -LiteralPath $WorkingDirectory
        $stepLocationPushed = $true
        & $Executable @Arguments 2>&1 | Tee-Object -FilePath $logPath
        if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
        Write-Host "PASS $Name" -ForegroundColor Green
    } catch {
        $failures.Add($Name)
        Write-Host "FAIL $Name : $($_.Exception.Message)" -ForegroundColor Red
    } finally {
        if ($stepLocationPushed) { Pop-Location }
    }
}

try {
    Push-Location -LiteralPath $resolvedRepoRoot
    $locationPushed = $true

    Invoke-FocusedStep "converter-import-repair-contract" (Join-Path $resolvedRepoRoot "converter") "python" @(
        "-m", "pytest", "tests/test_export_manifest.py", "tests/test_import_result_parser.py",
        "tests/test_import_result_matching.py", "tests/test_import_result_api.py",
        "tests/test_import_repair_export.py", "tests/test_misa_template_export_contract.py",
        "-q", "--tb=line"
    )

    Invoke-FocusedStep "backend-import-repair-contract" (Join-Path $resolvedRepoRoot "backend") "node" @(
        "--test", "tests/misaImportRepairGateway.test.js", "tests/misaImportRepairModels.test.js",
        "tests/misaImportRepairSecurity.test.js", "tests/misaImportRetry.test.js"
    )

    Invoke-FocusedStep "frontend-import-repair-journeys" (Join-Path $resolvedRepoRoot "frontend") "npm" @(
        "exec", "--", "playwright", "test", "tests/misa-import-repair.integration.spec.mjs",
        "--workers=1", "--reporter=line"
    )

    if ($failures.Count -gt 0) {
        Write-Host "`nTask 9 QA FAILED: $($failures -join ', ')" -ForegroundColor Red
        Write-Host "Evidence: $artifactRoot" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "`nTask 9 QA PASSED (3 focused steps)" -ForegroundColor Green
    Write-Host "Evidence: $artifactRoot" -ForegroundColor Gray
    exit 0
} finally {
    if ($locationPushed) { Pop-Location }
}
