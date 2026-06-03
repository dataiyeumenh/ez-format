param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [int]$GatewayPort = 8010,
    [string]$Model = "qwen2.5:7b",
    [string]$OllamaBaseUrl = "http://127.0.0.1:11434",
    [int]$ConverterPort = 8000,
    [string]$MisaTemplateDir = "E:\0. EXE2\Misa File",
    [switch]$NoPopup
)

$ErrorActionPreference = "Stop"

function Show-DesktopMessage {
    param(
        [string]$Title,
        [string]$Message,
        [ValidateSet("Info", "Error")]
        [string]$Kind = "Info"
    )

    if ($script:NoPopup) {
        Write-Host "$Title`n$Message"
        return
    }

    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $icon = if ($Kind -eq "Error") {
            [System.Windows.Forms.MessageBoxIcon]::Error
        } else {
            [System.Windows.Forms.MessageBoxIcon]::Information
        }
        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            $Title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            $icon
        ) | Out-Null
    } catch {
        Write-Host "$Title`n$Message"
    }
}

function Test-HttpOk {
    param(
        [string]$Uri,
        [int]$TimeoutSec = 3
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Wait-HttpOk {
    param(
        [string]$Uri,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk -Uri $Uri -TimeoutSec 2) {
            return $true
        }
        Start-Sleep -Milliseconds 750
    }
    return $false
}

function Get-OllamaAppPath {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"),
        (Join-Path $env:ProgramFiles "Ollama\ollama app.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Ollama\ollama app.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    return $null
}

function Ensure-OllamaTrayApp {
    param([string]$LogPath)

    $appProcess = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ollama app.exe" } |
        Select-Object -First 1
    if ($appProcess) {
        "[$(Get-Date -Format o)] Ollama tray app already running PID $($appProcess.ProcessId)" |
            Add-Content -LiteralPath $LogPath -Encoding UTF8
        return $true
    }

    $appPath = Get-OllamaAppPath
    if (-not $appPath) {
        "[$(Get-Date -Format o)] Ollama tray app executable not found; falling back to ollama serve" |
            Add-Content -LiteralPath $LogPath -Encoding UTF8
        return $false
    }

    "[$(Get-Date -Format o)] Starting Ollama tray app: $appPath" |
        Add-Content -LiteralPath $LogPath -Encoding UTF8
    Start-Process -FilePath $appPath -WorkingDirectory (Split-Path -Parent $appPath) -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 3
    return $true
}

function Get-ListeningProcesses {
    param([int]$Port)

    $listeners = @(netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING")
    if (-not $listeners) {
        return @()
    }
    $processIds = @(
        $listeners |
            ForEach-Object { ($_.ToString().Trim() -split "\s+")[-1] } |
            Sort-Object -Unique
    )
    foreach ($processIdText in $processIds) {
        Get-CimInstance Win32_Process -Filter "ProcessId = $processIdText" -ErrorAction SilentlyContinue
    }
}

function Stop-ManagedListener {
    param(
        [int]$Port,
        [string[]]$CommandLinePatterns,
        [string]$ServiceName
    )

    $processes = @(Get-ListeningProcesses -Port $Port)
    if (-not $processes) {
        return
    }
    foreach ($process in $processes) {
        $isManaged = $false
        foreach ($pattern in $CommandLinePatterns) {
            if ($process.CommandLine -like $pattern) {
                $isManaged = $true
                break
            }
        }
        if (-not $isManaged) {
            throw "Port $Port đang được dùng bởi process khác ($($process.ProcessId)): $($process.CommandLine)"
        }
        "[$(Get-Date -Format o)] Restarting $ServiceName PID $($process.ProcessId)" | Add-Content -LiteralPath $script:LauncherLog -Encoding UTF8
        Stop-Process -Id ([int]$process.ProcessId) -Force
    }
    Start-Sleep -Seconds 1
}

try {
    $resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
    $artifactDir = Join-Path $resolvedRepo ".artifacts\local-ai"
    New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

    $launcherLog = Join-Path $artifactDir "desktop-ai-launcher.log"
    $script:LauncherLog = $launcherLog
    $ollamaOutLog = Join-Path $artifactDir "ollama.out.log"
    $ollamaErrLog = Join-Path $artifactDir "ollama.err.log"
    $converterOutLog = Join-Path $artifactDir "converter-ai.out.log"
    $converterErrLog = Join-Path $artifactDir "converter-ai.err.log"
    $tokenPath = Join-Path $artifactDir "AI_GATEWAY_TOKEN.txt"
    $gatewayDocsUrl = "http://127.0.0.1:$GatewayPort/docs"
    $converterHealthUrl = "http://127.0.0.1:$ConverterPort/healthz"
    $ollamaTagsUrl = "$($OllamaBaseUrl.TrimEnd('/'))/api/tags"

    "[$(Get-Date -Format o)] Starting EzFormat AI Local" | Add-Content -LiteralPath $launcherLog -Encoding UTF8

    $startedTrayApp = Ensure-OllamaTrayApp -LogPath $launcherLog

    if (-not (Test-HttpOk -Uri $ollamaTagsUrl -TimeoutSec 2)) {
        if ($startedTrayApp -and (Wait-HttpOk -Uri $ollamaTagsUrl -TimeoutSeconds 45)) {
            "[$(Get-Date -Format o)] Ollama API ready via tray app" |
                Add-Content -LiteralPath $launcherLog -Encoding UTF8
        } else {
            $ollamaCommand = Get-Command "ollama" -ErrorAction SilentlyContinue
            if (-not $ollamaCommand) {
                throw "Không tìm thấy lệnh 'ollama'. Hãy cài Ollama hoặc mở Ollama trước rồi chạy lại shortcut."
            }

            "[$(Get-Date -Format o)] Starting ollama serve" | Add-Content -LiteralPath $launcherLog -Encoding UTF8
            Start-Process `
                -FilePath $ollamaCommand.Source `
                -ArgumentList @("serve") `
                -WorkingDirectory $resolvedRepo `
                -RedirectStandardOutput $ollamaOutLog `
                -RedirectStandardError $ollamaErrLog `
                -WindowStyle Hidden | Out-Null

            if (-not (Wait-HttpOk -Uri $ollamaTagsUrl -TimeoutSeconds 45)) {
                throw "Đã thử bật Ollama nhưng chưa kết nối được tại $ollamaTagsUrl. Xem log: $ollamaErrLog"
            }
        }
    }

    $gatewayScript = Join-Path $resolvedRepo "scripts\start-local-ai-gateway.ps1"
    if (-not (Test-Path -LiteralPath $gatewayScript)) {
        throw "Không tìm thấy script AI Gateway: $gatewayScript"
    }

    "[$(Get-Date -Format o)] Starting AI Gateway" | Add-Content -LiteralPath $launcherLog -Encoding UTF8
    & $gatewayScript `
        -RepoRoot $resolvedRepo `
        -Port $GatewayPort `
        -Model $Model `
        -OllamaBaseUrl $OllamaBaseUrl `
        -TokenPath $tokenPath `
        -Restart *>> $launcherLog

    if (-not (Wait-HttpOk -Uri $gatewayDocsUrl -TimeoutSeconds 20)) {
        throw "AI Gateway chưa sẵn sàng tại $gatewayDocsUrl. Xem log: $launcherLog"
    }

    Stop-ManagedListener `
        -Port $ConverterPort `
        -CommandLinePatterns @("*uvicorn*app.main:app*", "*node.exe*server/server.js*", "*node.exe*server\server.js*") `
        -ServiceName "Converter AI"

    $env:MISA_TEMPLATE_DIR = $MisaTemplateDir
    $env:MAPPING_DB_PATH = Join-Path $resolvedRepo "converter\data\mapping_profiles.sqlite"
    $env:AI_PROVIDER = "remote_http"
    $env:AI_BASE_URL = "http://127.0.0.1:$GatewayPort/v1/misa/suggest-mapping"
    $env:AI_TOKEN = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $env:AI_TIMEOUT_SECONDS = "120"
    $env:AI_REQUIRED = "false"

    "[$(Get-Date -Format o)] Starting Converter AI" | Add-Content -LiteralPath $launcherLog -Encoding UTF8
    Start-Process `
        -FilePath "python" `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$ConverterPort") `
        -WorkingDirectory (Join-Path $resolvedRepo "converter") `
        -RedirectStandardOutput $converterOutLog `
        -RedirectStandardError $converterErrLog `
        -WindowStyle Hidden | Out-Null

    if (-not (Wait-HttpOk -Uri $converterHealthUrl -TimeoutSeconds 30)) {
        throw "Converter AI chưa sẵn sàng tại $converterHealthUrl. Xem log: $converterErrLog"
    }

    $message = @"
AI Local đã sẵn sàng.

Ollama: $OllamaBaseUrl
AI Gateway: http://127.0.0.1:$GatewayPort/v1/misa/suggest-mapping
Converter AI: http://127.0.0.1:$ConverterPort
Token: $tokenPath
"@
    Show-DesktopMessage -Title "EzFormat AI Local" -Message $message -Kind Info
    "[$(Get-Date -Format o)] Ready" | Add-Content -LiteralPath $launcherLog -Encoding UTF8
} catch {
    $errorMessage = $_.Exception.Message
    try {
        $fallbackLog = Join-Path (Join-Path $RepoRoot ".artifacts\local-ai") "desktop-ai-launcher.log"
        "[$(Get-Date -Format o)] ERROR: $errorMessage" | Add-Content -LiteralPath $fallbackLog -Encoding UTF8
    } catch {}
    Show-DesktopMessage -Title "EzFormat AI Local lỗi" -Message $errorMessage -Kind Error
    exit 1
}
