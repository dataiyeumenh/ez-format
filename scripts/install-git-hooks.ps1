# Optional: run QA before push
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$hookDir = Join-Path $RepoRoot ".git\hooks"
if (-not (Test-Path $hookDir)) {
    Write-Host "Not a git repo — skip hooks."
    exit 0
}

$prePush = @'
#!/bin/sh
echo "Running EzFormat QA (fast)..."
npm run qa:fast || exit 1
'@

$hookPath = Join-Path $hookDir "pre-push"
Set-Content -Path $hookPath -Value $prePush -Encoding UTF8 -NoNewline
Write-Host "Installed pre-push hook -> npm run qa:fast"
