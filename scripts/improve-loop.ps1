# Recurring site improvement loop — wakes Cursor agent via monitored shell sentinel
param(
    [int]$IntervalMinutes = 120,
    [string]$Purpose = "ezformat-ux"
)

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Prompt = @"
EzFormat continuous improvement tick. Run: pwsh -File `"$RepoRoot\scripts\site-improve.ps1`". If checks pass, pick ONE small UX improvement in frontend (accessibility, mobile, copy, performance). If checks fail, fix the failure first. Keep diffs minimal. Do not commit unless user asked.
"@

$escaped = $Prompt -replace '"', '\"'
$sentinel = "AGENT_LOOP_WAKE_$Purpose"

Write-Host "Improve loop: every ${IntervalMinutes}m | sentinel $sentinel"
Write-Host "First tick after ${IntervalMinutes} minutes. Run site-improve.ps1 manually now if needed."

while ($true) {
    Start-Sleep -Seconds ($IntervalMinutes * 60)
    $json = "{`"prompt`":`"$escaped`"}"
    Write-Output "$sentinel $json"
}
