[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,
    [switch]$RequireClean
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$manifestRelative = "docs/qa/task-11-code-tree.manifest.json"
$evidenceRelative = "docs/qa/task-11-evidence.json"
$resultRelative = "docs/qa/task-11-command-results.json"

function Fail-Binding {
    param([string]$Message)
    Write-Error "TASK11_EVIDENCE_BINDING=FAIL: $Message"
    exit 1
}

function Resolve-TrackedPath {
    param([string]$RelativePath)

    $normalized = $RelativePath.Replace("\", "/")
    if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized.StartsWith("/") -or $normalized.Contains("../")) {
        Fail-Binding "invalid repository-relative path: $RelativePath"
    }
    $candidate = Join-Path $root ($normalized -replace "/", [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Fail-Binding "tracked evidence file is missing: $normalized"
    }
    $tracked = & git -C $root ls-files --error-unmatch -- $normalized 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($tracked -join ""))) {
        Fail-Binding "evidence path is not tracked: $normalized"
    }
    return (Resolve-Path -LiteralPath $candidate).Path
}

function Get-CanonicalTextSha256 {
    param([string]$Path)

    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $text = [IO.File]::ReadAllText($Path, $utf8).Replace("`r`n", "`n")
    $bytes = $utf8.GetBytes($text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-CanonicalTreeDigest {
    param([object[]]$Files)

    $builder = [Text.StringBuilder]::new()
    foreach ($entry in @($Files | Sort-Object path)) {
        $path = [string]$entry.path
        $hash = [string]$entry.sha256
        [void]$builder.Append($path.Replace("\", "/"))
        [void]$builder.Append([char]0)
        [void]$builder.Append($hash.ToLowerInvariant())
        [void]$builder.Append("`n")
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($builder.ToString())
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

$manifestPath = Resolve-TrackedPath $manifestRelative
$evidencePath = Resolve-TrackedPath $evidenceRelative
$resultPath = Resolve-TrackedPath $resultRelative
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json

if ($manifest.schema_version -ne "1" -or $manifest.algorithm -ne "sha256-path-v1") {
    Fail-Binding "unsupported tree manifest schema or algorithm"
}
if (-not ($manifest.files -is [Array]) -or $manifest.files.Count -eq 0) {
    Fail-Binding "tree manifest has no files"
}

$seen = @{}
foreach ($entry in @($manifest.files)) {
    $relative = [string]$entry.path
    $normalized = $relative.Replace("\", "/")
    if ($seen.ContainsKey($normalized)) { Fail-Binding "duplicate tree manifest path: $normalized" }
    $seen[$normalized] = $true
    if ([string]$entry.sha256 -notmatch "^[a-f0-9]{64}$") {
        Fail-Binding "invalid file hash in tree manifest: $normalized"
    }
    $path = Resolve-TrackedPath $normalized
    $actual = Get-CanonicalTextSha256 $path
    if ($actual -ne ([string]$entry.sha256).ToLowerInvariant()) {
        Fail-Binding "tracked tree file changed: $normalized"
    }
}

$treeDigest = Get-CanonicalTreeDigest @($manifest.files)
if ($treeDigest -ne ([string]$manifest.tree_digest).ToLowerInvariant()) {
    Fail-Binding "tracked tree digest does not match manifest"
}

$revision = [string]$evidence.subject.revision
$expectedRevision = "task11-code-test-gate-tree-sha256:$treeDigest"
if ($revision -ne $expectedRevision) {
    Fail-Binding "evidence revision is not the tracked tree digest"
}
if ($revision -match "^[a-f0-9]{40}$") {
    Fail-Binding "evidence must not claim a self-referential commit SHA"
}

foreach ($check in @($evidence.checks)) {
    foreach ($item in @($check.evidence)) {
        $relative = ([string]$item.path).Replace("\", "/")
        if ($relative.StartsWith(".artifacts/")) {
            Fail-Binding "required evidence cannot depend on ignored artifact path: $relative"
        }
        $path = Resolve-TrackedPath $relative
        $actualHash = Get-CanonicalTextSha256 $path
        $actualSize = (Get-Item -LiteralPath $path).Length
        if ($actualHash -ne ([string]$item.sha256).ToLowerInvariant() -or $actualSize -ne [int64]$item.size) {
            Fail-Binding "tracked command/result evidence hash or size mismatch: $relative"
        }
    }
}

if ($RequireClean) {
    $dirty = @(git -C $root status --porcelain --untracked-files=all)
    if ($dirty.Count -gt 0) {
        Fail-Binding "repository is not clean"
    }
}

Write-Output "TASK11_CODE_TREE_DIGEST=$treeDigest"
Write-Output "ARTIFACT_DEPENDENCY=NONE"
Write-Output "TASK11_EVIDENCE_BINDING=PASS"
