param(
    [string]$Workspace = "",
    [switch]$NoBrowser,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not $SkipInstall) {
    & (Join-Path $PSScriptRoot "install.ps1")
}

$logsDir = Join-Path $PSScriptRoot "logs"
$envFile = Join-Path $PSScriptRoot ".env"
$mcpPidFile = Join-Path $logsDir "mcp.pid"
$tunnelPidFile = Join-Path $logsDir "tunnel.pid"
$tunnelHealthFile = Join-Path $logsDir "tunnel-health.url"

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Missing .env. It must define CONTROL_PLANE_API_KEY, CONTROL_PLANE_TUNNEL_ID, and MCP_SERVER_URL."
}

$configuration = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $parts = $line -split '=', 2
    if ($parts.Count -ne 2) {
        continue
    }

    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
        $configuration[$name] = $value
    }
}

$requiredSettings = @("CONTROL_PLANE_API_KEY", "CONTROL_PLANE_TUNNEL_ID", "MCP_SERVER_URL")
foreach ($setting in $requiredSettings) {
    if (-not $configuration.ContainsKey($setting) -or
        [string]::IsNullOrWhiteSpace($configuration[$setting]) -or
        $configuration[$setting] -like "*replace_with_*") {
        throw "Configure $setting in .env before starting Luna Unlimited."
    }
}

if ($configuration["CONTROL_PLANE_TUNNEL_ID"] -notmatch '^tunnel_[A-Za-z0-9_-]+$') {
    throw "CONTROL_PLANE_TUNNEL_ID in .env does not look like a tunnel ID."
}

$mcpPort = 18765
if ($configuration.ContainsKey("MCP_PORT")) {
    if (-not [int]::TryParse($configuration["MCP_PORT"], [ref]$mcpPort) -or $mcpPort -lt 10001 -or $mcpPort -gt 65535) {
        throw "MCP_PORT must be an integer between 10001 and 65535."
    }
}
$mcpHost = if ($configuration.ContainsKey("MCP_HOST")) { $configuration["MCP_HOST"] } else { "127.0.0.1" }
if ($mcpHost -notin @("127.0.0.1", "localhost")) {
    throw "For local use, MCP_HOST must remain 127.0.0.1 or localhost."
}
$localBaseUrl = "http://127.0.0.1:$mcpPort"
$dashboardUrl = "$localBaseUrl/admin"

foreach ($entry in $configuration.GetEnumerator()) {
    if ($entry.Key -like "MCP_*" -or $entry.Key -like "LUNA_*") {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
}

if (-not [string]::IsNullOrWhiteSpace($Workspace)) {
    $resolvedWorkspace = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
    $workspaceItem = Get-Item -LiteralPath $resolvedWorkspace -ErrorAction Stop
    if (-not $workspaceItem.PSIsContainer) {
        throw "Workspace must be an existing directory."
    }
    [Environment]::SetEnvironmentVariable("MCP_WORKSPACE_ROOT", $resolvedWorkspace, "Process")
}

if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "stop-all.ps1")) {
    & (Join-Path $PSScriptRoot "stop-all.ps1") -Quiet
}

$escapedPort = [regex]::Escape([string]$mcpPort)
$occupied = netstat -ano | Select-String "127\.0\.0\.1:$escapedPort\s+.*LISTENING" | Select-Object -First 1
if ($occupied) {
    throw "Port $mcpPort is already in use. Stop the conflicting application or choose another MCP_PORT above 10000."
}

$server = $null
$tunnel = $null

try {
    $server = Start-Process `
        -FilePath "node" `
        -ArgumentList "src/server.mjs" `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logsDir "server.out.log") `
        -RedirectStandardError (Join-Path $logsDir "server.err.log") `
        -PassThru
    Set-Content -LiteralPath $mcpPidFile -Value $server.Id -NoNewline

    $mcpReady = $false
    for ($index = 0; $index -lt 40; $index++) {
        try {
            $health = Invoke-RestMethod -Uri "$localBaseUrl/healthz" -TimeoutSec 1
            if ($health.ok) {
                $mcpReady = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 250
    }

    if (-not $mcpReady) {
        throw "MCP server did not become ready. Check logs/server.err.log."
    }

    Remove-Item -LiteralPath $tunnelHealthFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue

    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $configuration["CONTROL_PLANE_API_KEY"], "Process")
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_TUNNEL_ID", $configuration["CONTROL_PLANE_TUNNEL_ID"], "Process")

    $tunnel = Start-Process `
        -FilePath (Join-Path $PSScriptRoot "tunnel-client.exe") `
        -ArgumentList @(
            "run",
            "--health.listen-addr", "127.0.0.1:0",
            "--health.url-file", $tunnelHealthFile,
            "--pid.file", $tunnelPidFile,
            "--log.file", (Join-Path $logsDir "tunnel.log")
        ) `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden `
        -PassThru

    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "Process")
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_TUNNEL_ID", $null, "Process")

    $tunnelReady = $false
    $healthBase = $null
    for ($index = 0; $index -lt 60; $index++) {
        if (Test-Path -LiteralPath $tunnelHealthFile) {
            $healthBase = (Get-Content -Raw -LiteralPath $tunnelHealthFile).Trim()
            if ($healthBase) {
                try {
                    $readyResponse = Invoke-WebRequest -Uri "$healthBase/readyz" -UseBasicParsing -TimeoutSec 2
                    if ($readyResponse.StatusCode -eq 200) {
                        $tunnelReady = $true
                        break
                    }
                } catch {}
            }
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $tunnelReady) {
        throw "Tunnel did not become ready. Check logs/tunnel.log."
    }

    if (-not $NoBrowser) {
        Start-Process $dashboardUrl
    }

    Write-Host "Luna Local MCP started." -ForegroundColor Green
    Write-Host "MCP:       $localBaseUrl/mcp"
    Write-Host "Dashboard: $dashboardUrl"
    Write-Host "Workspace: $($health.workspace)"
    Write-Host "MCP PID:   $($server.Id)"
    Write-Host "Tunnel PID: $($tunnel.Id)"
} catch {
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "Process")
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_TUNNEL_ID", $null, "Process")
    if ($tunnel -and -not $tunnel.HasExited) {
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    }
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    throw
}
