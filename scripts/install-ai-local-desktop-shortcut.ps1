param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$ShortcutName = "AI Local",
    [int]$GatewayPort = 8010,
    [int]$ConverterPort = 8000,
    [string]$Model = "qwen2.5:7b",
    [string]$OllamaBaseUrl = "http://127.0.0.1:11434",
    [string]$MisaTemplateDir = "E:\0. EXE2\Misa File"
)

$ErrorActionPreference = "Stop"

$resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$launcherScript = Join-Path $resolvedRepo "scripts\start-ai-local-desktop.ps1"
if (-not (Test-Path -LiteralPath $launcherScript)) {
    throw "Launcher script not found: $launcherScript"
}

$desktopDir = [Environment]::GetFolderPath("DesktopDirectory")
if (-not $desktopDir) {
    $desktopDir = Join-Path $env:USERPROFILE "Desktop"
}
New-Item -ItemType Directory -Force -Path $desktopDir | Out-Null

$shortcutPath = Join-Path $desktopDir "$ShortcutName.lnk"
$temporaryShortcutPath = Join-Path $desktopDir "EzFormat-AI-Local.tmp.lnk"
$fallbackCmdPath = Join-Path $desktopDir "$ShortcutName.cmd"
$legacyShortcutPaths = @(
    (Join-Path $desktopDir "Bật EzFormat AI Local.lnk"),
    (Join-Path $desktopDir "EzFormat AI Local.lnk"),
    (Join-Path $desktopDir "EzFormat AI Local.cmd")
)
$pwshCommand = Get-Command "pwsh.exe" -ErrorAction SilentlyContinue
if (-not $pwshCommand) {
    throw "pwsh.exe not found. Install PowerShell 7+ or add pwsh.exe to PATH."
}

$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$launcherScript`"",
    "-RepoRoot", "`"$resolvedRepo`"",
    "-GatewayPort", "$GatewayPort",
    "-Model", "`"$Model`"",
    "-OllamaBaseUrl", "`"$OllamaBaseUrl`"",
    "-ConverterPort", "$ConverterPort",
    "-MisaTemplateDir", "`"$MisaTemplateDir`""
) -join " "

$shell = New-Object -ComObject WScript.Shell
Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
foreach ($legacyShortcutPath in $legacyShortcutPaths) {
    Remove-Item -LiteralPath $legacyShortcutPath -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $temporaryShortcutPath -Force -ErrorAction SilentlyContinue
$shortcut = $shell.CreateShortcut($temporaryShortcutPath)
$shortcut.TargetPath = $pwshCommand.Source
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $resolvedRepo
$shortcut.WindowStyle = 7
$shortcut.Description = "Bật Ollama và EzFormat AI Gateway local"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,44"
$shortcut.Save()
Move-Item -LiteralPath $temporaryShortcutPath -Destination $shortcutPath -Force

$fallbackCmd = @"
@echo off
cd /d "$resolvedRepo"
"$($pwshCommand.Source)" $arguments
pause
"@
Set-Content -LiteralPath $fallbackCmdPath -Value $fallbackCmd -Encoding ASCII

Write-Host "Desktop shortcut created"
Write-Host "Path: $shortcutPath"
Write-Host "Fallback CMD: $fallbackCmdPath"
Write-Host "Target: $($pwshCommand.Source)"
Write-Host "Arguments: $arguments"
