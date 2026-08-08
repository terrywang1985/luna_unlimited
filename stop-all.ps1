param(
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$logsDir = Join-Path $PSScriptRoot "logs"
$mcpPidFile = Join-Path $logsDir "mcp.pid"
$tunnelPidFile = Join-Path $logsDir "tunnel.pid"
$mcpPort = 18765
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path -LiteralPath $envFile) {
    $portLine = Get-Content -LiteralPath $envFile |
        Where-Object { $_ -match '^\s*MCP_PORT\s*=' } |
        Select-Object -Last 1
    if ($portLine) {
        $portValue = ($portLine -split '=', 2)[1].Trim()
        $parsedPort = 0
        if ([int]::TryParse($portValue, [ref]$parsedPort)) { $mcpPort = $parsedPort }
    }
}

if (Test-Path -LiteralPath $mcpPidFile) {
    $mcpPid = (Get-Content -Raw -LiteralPath $mcpPidFile).Trim()
    if ($mcpPid -match '^\d+$') {
        $escapedPort = [regex]::Escape([string]$mcpPort)
        $listener = netstat -ano | Select-String "127\.0\.0\.1:$escapedPort\s+.*LISTENING\s+$mcpPid$" | Select-Object -First 1
        $process = Get-Process -Id ([int]$mcpPid) -ErrorAction SilentlyContinue
        if ($listener -and $process -and $process.ProcessName -eq "node") {
            Stop-Process -Id $process.Id -Force
            if (-not $Quiet) { Write-Host "Stopped MCP server PID $mcpPid" }
        }
    }
    Remove-Item -LiteralPath $mcpPidFile -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $tunnelPidFile) {
    $tunnelPid = (Get-Content -Raw -LiteralPath $tunnelPidFile).Trim()
    if ($tunnelPid -match '^\d+$') {
        $process = Get-Process -Id ([int]$tunnelPid) -ErrorAction SilentlyContinue
        $expectedPath = Join-Path $PSScriptRoot "tunnel-client.exe"
        if ($process -and $process.ProcessName -eq "tunnel-client" -and $process.Path -eq $expectedPath) {
            Stop-Process -Id $process.Id -Force
            if (-not $Quiet) { Write-Host "Stopped Tunnel PID $tunnelPid" }
        }
    }
    Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

if (-not $Quiet) { Write-Host "Luna Local MCP stopped." -ForegroundColor Yellow }
