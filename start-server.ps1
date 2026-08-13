param(
    [string]$Workspace = "",
    [ValidateSet("restricted", "user", "container-root", "host-root")]
    [string]$ExecutionProfile = "",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
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
npm start
