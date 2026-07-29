param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$ManifestPath,
    [string]$HeadRef = "HEAD"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-ManifestScalar {
    param([string]$Value)

    $value = $Value.Trim()
    if ($value.Length -ge 2 -and (
            ($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or
            ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'")
        )) {
        return $value.Substring(1, $value.Length - 2)
    }

    return $value
}

function Normalize-ManifestPath {
    param([string]$Value, [string]$Label)

    $normalized = (ConvertTo-ManifestScalar -Value $Value) -replace "\\", "/"
    $normalized = $normalized.Trim()
    while ($normalized.StartsWith("./", [System.StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(2)
    }
    $normalized = [System.Text.RegularExpressions.Regex]::Replace($normalized, "/+", "/")

    if ([string]::IsNullOrWhiteSpace($normalized) -or
        [System.IO.Path]::IsPathRooted($normalized) -or
        $normalized -match "^[A-Za-z]:/") {
        throw "$Label must be a non-empty repository-relative path."
    }

    $segments = @($normalized.Split("/"))
    if (@($segments | Where-Object { $_ -eq "." -or $_ -eq ".." -or $_.Length -eq 0 }).Count -gt 0) {
        throw "$Label must not contain empty, '.' or '..' segments."
    }

    return $normalized
}

function ConvertTo-ManifestGlobRegex {
    param([string]$Pattern)

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append("^")
    for ($index = 0; $index -lt $Pattern.Length; $index++) {
        $character = $Pattern[$index]
        if ($character -eq "*") {
            if ($index + 1 -lt $Pattern.Length -and $Pattern[$index + 1] -eq "*") {
                [void]$builder.Append(".*")
                $index++
            } else {
                [void]$builder.Append("[^/]*")
            }
        } elseif ($character -eq "?") {
            [void]$builder.Append("[^/]")
        } else {
            [void]$builder.Append([System.Text.RegularExpressions.Regex]::Escape([string]$character))
        }
    }
    [void]$builder.Append("$")

    return [System.Text.RegularExpressions.Regex]::new(
        $builder.ToString(),
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
}

function Read-TransplantManifest {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Manifest not found: $Path"
    }

    $manifest = [ordered]@{
        base_sha = $null
        source_sha = $null
        rollback_ref = $null
        rules = @()
        excluded = @()
    }
    $section = ""
    $currentRule = $null
    $lineNumber = 0

    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $lineNumber++
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#", [System.StringComparison]::Ordinal)) {
            continue
        }

        if ($trimmed -match "^(base_sha|source_sha|rollback_ref):\s*(.+)$") {
            if ($section) {
                throw "Unexpected top-level field at line $lineNumber."
            }
            $manifest[$Matches[1]] = ConvertTo-ManifestScalar -Value $Matches[2]
            continue
        }
        if ($trimmed -eq "rules:") {
            if ($section) {
                throw "Unexpected rules section at line $lineNumber."
            }
            $section = "rules"
            continue
        }
        if ($trimmed -eq "excluded:") {
            if ($section -ne "rules") {
                throw "Unexpected excluded section at line $lineNumber."
            }
            if ($null -ne $currentRule) {
                $manifest.rules += [pscustomobject]$currentRule
                $currentRule = $null
            }
            $section = "excluded"
            continue
        }
        if ($section -eq "rules" -and $trimmed -match "^- path:\s*(.+)$") {
            if ($null -ne $currentRule) {
                $manifest.rules += [pscustomobject]$currentRule
            }
            $currentRule = [ordered]@{ path = ConvertTo-ManifestScalar -Value $Matches[1] }
            continue
        }
        if ($section -eq "rules" -and $trimmed -match "^(owner|reason):\s*(.+)$") {
            if ($null -eq $currentRule) {
                throw "Rule field without a path at line $lineNumber."
            }
            $currentRule[$Matches[1]] = ConvertTo-ManifestScalar -Value $Matches[2]
            continue
        }
        if ($section -eq "excluded" -and $trimmed -match "^-\s*(.+)$") {
            $manifest.excluded += ConvertTo-ManifestScalar -Value $Matches[1]
            continue
        }

        throw "Unsupported manifest syntax at line $lineNumber."
    }

    if ($section -ne "excluded") {
        throw "Manifest must contain rules and excluded sections."
    }
    foreach ($field in @("base_sha", "source_sha", "rollback_ref")) {
        if ([string]::IsNullOrWhiteSpace([string]$manifest[$field])) {
            throw "Manifest field '$field' is required."
        }
    }
    foreach ($shaField in @("base_sha", "source_sha")) {
        if ($manifest[$shaField] -notmatch "^[0-9a-f]{40}$") {
            throw "Manifest field '$shaField' must be a 40-character lowercase SHA."
        }
    }

    $validOwners = @("main", "source", "compose", "regenerate", "exclude")
    foreach ($rule in @($manifest.rules)) {
        foreach ($field in @("path", "owner", "reason")) {
            if ($null -eq $rule.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace([string]$rule.$field)) {
                throw "Each rule requires '$field'."
            }
        }
        $rule.path = Normalize-ManifestPath -Value $rule.path -Label "Rule path"
        if ($validOwners -notcontains $rule.owner) {
            throw "Rule '$($rule.path)' has invalid owner '$($rule.owner)'."
        }
        $rule | Add-Member -NotePropertyName regex -NotePropertyValue (ConvertTo-ManifestGlobRegex -Pattern $rule.path)
    }
    foreach ($index in 0..($manifest.excluded.Count - 1)) {
        $manifest.excluded[$index] = Normalize-ManifestPath -Value $manifest.excluded[$index] -Label "Excluded path"
    }

    return [pscustomobject]$manifest
}

function Invoke-Git {
    param([string]$WorkingDirectory, [string[]]$Arguments)

    $output = & git -C $WorkingDirectory @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed."
    }
    return @($output | ForEach-Object { [string]$_ })
}

try {
    $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
        $ManifestPath = Join-Path $RepoRoot "docs/integration/main-experimental-transplant.yml"
    }
    $ManifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path
    $manifest = Read-TransplantManifest -Path $ManifestPath

    [void](Invoke-Git -WorkingDirectory $RepoRoot -Arguments @("rev-parse", "--verify", "$($manifest.base_sha)^{commit}"))
    [void](Invoke-Git -WorkingDirectory $RepoRoot -Arguments @("rev-parse", "--verify", "$HeadRef^{commit}"))

    $diffArguments = @("diff", "--name-only", "--diff-filter=ACDMRTUXB")
    $changedPaths = @(
        Invoke-Git -WorkingDirectory $RepoRoot -Arguments ($diffArguments + @("$($manifest.base_sha)...$HeadRef", "--"))
        Invoke-Git -WorkingDirectory $RepoRoot -Arguments ($diffArguments + @("--"))
        Invoke-Git -WorkingDirectory $RepoRoot -Arguments ($diffArguments + @("--cached", "--"))
        Invoke-Git -WorkingDirectory $RepoRoot -Arguments @("ls-files", "--others", "--exclude-standard", "--")
    )

    $pathSet = [System.Collections.Generic.SortedSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($path in $changedPaths) {
        if (-not [string]::IsNullOrWhiteSpace($path)) {
            [void]$pathSet.Add((Normalize-ManifestPath -Value $path -Label "Changed path"))
        }
    }

    $results = @()
    $failures = @()
    foreach ($path in $pathSet) {
        $excludedMatches = @($manifest.excluded | Where-Object { $path -match (ConvertTo-ManifestGlobRegex -Pattern $_) })
        if ($excludedMatches.Count -gt 0) {
            $results += [pscustomobject]@{ path = $path; status = "excluded"; owner = "exclude"; matches = $excludedMatches }
            continue
        }

        $matches = @($manifest.rules | Where-Object { $_.regex.IsMatch($path) })
        if ($matches.Count -eq 1 -and $matches[0].owner -eq "exclude") {
            $results += [pscustomobject]@{ path = $path; status = "excluded"; owner = "exclude"; matches = @($matches[0].path) }
            continue
        }
        if ($matches.Count -ne 1) {
            $failure = [pscustomobject]@{ path = $path; matches = @($matches | ForEach-Object { $_.path }); count = $matches.Count }
            $failures += $failure
            $results += [pscustomobject]@{ path = $path; status = "invalid"; owner = $null; matches = $failure.matches }
            continue
        }

        $results += [pscustomobject]@{ path = $path; status = "owned"; owner = $matches[0].owner; matches = @($matches[0].path) }
    }

    $summary = [ordered]@{
        status = if ($failures.Count -eq 0) { "pass" } else { "fail" }
        repo_root = $RepoRoot
        base_sha = $manifest.base_sha
        head_ref = $HeadRef
        checked_paths = $pathSet.Count
        owned_paths = @($results | Where-Object { $_.status -eq "owned" }).Count
        excluded_paths = @($results | Where-Object { $_.status -eq "excluded" }).Count
        failures = $failures
        results = $results
    }
    Write-Output "TRANSPLANT_MANIFEST_SUMMARY $($summary | ConvertTo-Json -Compress -Depth 6)"

    if ($failures.Count -gt 0) {
        [Console]::Error.WriteLine("Transplant manifest ownership failed for $($failures.Count) changed path(s).")
        exit 1
    }
} catch {
    $summary = [ordered]@{ status = "error"; error = $_.Exception.Message }
    Write-Output "TRANSPLANT_MANIFEST_SUMMARY $($summary | ConvertTo-Json -Compress)"
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
