$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$environmentPath = Join-Path $PSScriptRoot ".env"
$tunnelPath = Join-Path $PSScriptRoot "tunnel-client.exe"
if (-not (Test-Path -LiteralPath $environmentPath)) {
    throw "Missing .env. Run .\install.ps1 and configure the generated file first."
}
if (-not (Test-Path -LiteralPath $tunnelPath)) {
    throw "Missing tunnel-client.exe. Run .\install.ps1 first."
}

$configuration = @{}
foreach ($line in Get-Content -LiteralPath $environmentPath) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2) { continue }
    $name = $parts[0].Trim()
    if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
        $configuration[$name] = $parts[1].Trim()
    }
}

foreach ($setting in @("CONTROL_PLANE_API_KEY", "CONTROL_PLANE_TUNNEL_ID", "MCP_SERVER_URL")) {
    if (-not $configuration.ContainsKey($setting) -or
        [string]::IsNullOrWhiteSpace($configuration[$setting]) -or
        $configuration[$setting] -like "*replace_with_*") {
        throw "Configure $setting in .env before running diagnostics."
    }
    [Environment]::SetEnvironmentVariable($setting, $configuration[$setting], "Process")
}

try {
    $mcpPort = if ($configuration.ContainsKey("MCP_PORT")) { [int]$configuration["MCP_PORT"] } else { 18765 }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$mcpPort/healthz" -TimeoutSec 2
        Write-Host "Luna MCP health: ready ($($health.server))" -ForegroundColor Green
    } catch {
        Write-Warning "Luna MCP is not reachable on port $mcpPort. Start it before testing ChatGPT tool calls."
    }

    & $tunnelPath doctor --explain
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE." }
} finally {
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "Process")
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_TUNNEL_ID", $null, "Process")
    [Environment]::SetEnvironmentVariable("MCP_SERVER_URL", $null, "Process")
}
