$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Push-Location $Root
try {
    npm run qa:main-contracts
    if ($LASTEXITCODE -ne 0) { throw "Main contract QA failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Push-Location (Join-Path $Root "backend")
try {
    node --test
    if ($LASTEXITCODE -ne 0) { throw "Backend tests failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Push-Location (Join-Path $Root "converter")
try {
    python -m pytest -q --tb=short
    if ($LASTEXITCODE -ne 0) { throw "Converter tests failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Push-Location (Join-Path $Root "frontend")
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed with exit code $LASTEXITCODE" }

    npm run lint
    if ($LASTEXITCODE -ne 0) { throw "Frontend lint failed with exit code $LASTEXITCODE" }

    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
