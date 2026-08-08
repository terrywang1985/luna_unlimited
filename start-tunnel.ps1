$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

& (Join-Path $PSScriptRoot "install.ps1")

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Missing .env. It must define CONTROL_PLANE_API_KEY, CONTROL_PLANE_TUNNEL_ID, and MCP_SERVER_URL."
}

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
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

& (Join-Path $PSScriptRoot "tunnel-client.exe") run --health.listen-addr 127.0.0.1:0
