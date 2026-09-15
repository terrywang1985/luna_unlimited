param(
    [string]$Workspace = "",
    [ValidateSet("restricted", "user", "container-root", "host-root")]
    [string]$ExecutionProfile = "",
    [switch]$EnableDesktop,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Get-ListeningProcessId {
    param([int]$Port)

    try {
        $connection = Get-NetTCPConnection `
            -LocalAddress "127.0.0.1" `
            -LocalPort $Port `
            -State Listen `
            -ErrorAction Stop |
            Select-Object -First 1
        if ($connection) {
            return [int]$connection.OwningProcess
        }
    } catch {}

    $escapedPort = [regex]::Escape([string]$Port)
    $match = netstat -ano |
        Select-String "^\s*TCP\s+127\.0\.0\.1:$escapedPort\s+\S+\s+LISTENING\s+(\d+)\s*$" |
        Select-Object -First 1
    if ($match -and $match.Matches.Count -gt 0) {
        return [int]$match.Matches[0].Groups[1].Value
    }

    return $null
}

function Stop-ExistingLunaServer {
    param([int]$Port)

    $ownerProcessId = Get-ListeningProcessId -Port $Port
    if (-not $ownerProcessId) {
        return
    }

    $health = $null
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
    } catch {}

    $processInfo = $null
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerProcessId"
    } catch {}

    $commandLine = if ($processInfo) { [string]$processInfo.CommandLine } else { "" }
    $healthLooksLikeLuna = $health -and $health.ok -eq $true -and $health.server -eq "luna-unlimited"
    $commandLooksLikeLuna = $commandLine -match '(?i)(^|[\\/\s\"])(node(?:\.exe)?)([\s\"]|$)' -and
        $commandLine -match '(?i)src[\\/]server\.mjs'

    if (-not $healthLooksLikeLuna -or -not $commandLooksLikeLuna) {
        $displayCommand = if ([string]::IsNullOrWhiteSpace($commandLine)) { "<unavailable>" } else { $commandLine }
        throw "Port $Port is already in use by PID $ownerProcessId, but it is not a verified Luna Unlimited server. Refusing to stop it. Command: $displayCommand"
    }

    Write-Host "Stopping existing Luna Unlimited server on port $Port (PID $ownerProcessId)..." -ForegroundColor Yellow
    Stop-Process -Id $ownerProcessId -Force -ErrorAction Stop

    for ($index = 0; $index -lt 40; $index++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-ListeningProcessId -Port $Port)) {
            return
        }
    }

    throw "Existing Luna Unlimited server PID $ownerProcessId did not release port $Port."
}

if (-not $SkipInstall) {
    & (Join-Path $PSScriptRoot "install.ps1")
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".env")) {
    foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot ".env")) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if ($name -like "MCP_*" -or $name -like "LUNA_*") {
                [Environment]::SetEnvironmentVariable($name, $value, "Process")
            }
        }
    }
}
if (-not [string]::IsNullOrWhiteSpace($Workspace)) {
    [Environment]::SetEnvironmentVariable("MCP_WORKSPACE_ROOT", (Resolve-Path -LiteralPath $Workspace).Path, "Process")
}
if (-not [string]::IsNullOrWhiteSpace($ExecutionProfile)) {
    [Environment]::SetEnvironmentVariable("LUNA_EXECUTION_PROFILE", $ExecutionProfile, "Process")
}
if ($EnableDesktop) {
    [Environment]::SetEnvironmentVariable("LUNA_DESKTOP_ENABLED", "1", "Process")
}

$mcpPort = 18765
$configuredPort = [Environment]::GetEnvironmentVariable("MCP_PORT", "Process")
if (-not [string]::IsNullOrWhiteSpace($configuredPort)) {
    if (-not [int]::TryParse($configuredPort, [ref]$mcpPort) -or $mcpPort -lt 10001 -or $mcpPort -gt 65535) {
        throw "MCP_PORT must be an integer between 10001 and 65535."
    }
}

Stop-ExistingLunaServer -Port $mcpPort
npm start
