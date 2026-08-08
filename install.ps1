param(
    [switch]$ForceTunnelDownload
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Assert-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Install-TunnelClient {
    param([switch]$Force)

    $targetPath = Join-Path $PSScriptRoot "tunnel-client.exe"
    if ((Test-Path -LiteralPath $targetPath) -and -not $Force) {
        $version = (& $targetPath --version 2>$null | Select-Object -First 1)
        Write-Host "Tunnel client already installed: $version" -ForegroundColor DarkGreen
        return
    }

    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $releaseArchitecture = switch ($architecture) {
        "x64" { "amd64" }
        "arm64" { "arm64" }
        default { throw "Unsupported Windows architecture: $architecture. Only x64 and arm64 are supported." }
    }

    Write-Host "Resolving the latest official OpenAI tunnel-client release..."
    $headers = @{
        "Accept" = "application/vnd.github+json"
        "User-Agent" = "luna-unlimited-installer"
    }
    $release = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest" `
        -Headers $headers `
        -TimeoutSec 30

    $archiveAsset = $release.assets |
        Where-Object { $_.name -like "*-windows-$releaseArchitecture.zip" } |
        Select-Object -First 1
    $checksumAsset = $release.assets |
        Where-Object { $_.name -eq "SHA256SUMS.txt" } |
        Select-Object -First 1
    if (-not $archiveAsset -or -not $checksumAsset) {
        throw "The latest openai/tunnel-client release does not contain the expected Windows archive or checksum file."
    }

    $systemTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $downloadRoot = Join-Path $systemTempRoot ("luna-tunnel-" + [guid]::NewGuid().ToString("N"))
    $resolvedDownloadRoot = [System.IO.Path]::GetFullPath($downloadRoot)
    if (-not $resolvedDownloadRoot.StartsWith($systemTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use a temporary directory outside the system temp root."
    }

    New-Item -ItemType Directory -Path $resolvedDownloadRoot | Out-Null
    try {
        $archivePath = Join-Path $resolvedDownloadRoot $archiveAsset.name
        $checksumPath = Join-Path $resolvedDownloadRoot "SHA256SUMS.txt"
        Invoke-WebRequest -Uri $archiveAsset.browser_download_url -OutFile $archivePath -UseBasicParsing -TimeoutSec 180
        Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumPath -UseBasicParsing -TimeoutSec 60

        $checksumText = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($checksumPath))
        $escapedArchiveName = [regex]::Escape($archiveAsset.name)
        $checksumMatch = [regex]::Match($checksumText, "(?im)^([a-f0-9]{64})\s+\*?$escapedArchiveName\s*$")
        if (-not $checksumMatch.Success) {
            throw "Could not find the archive checksum in the official SHA256SUMS.txt file."
        }

        $expectedHash = $checksumMatch.Groups[1].Value.ToLowerInvariant()
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Tunnel client checksum verification failed. Expected $expectedHash but received $actualHash."
        }

        $expandedPath = Join-Path $resolvedDownloadRoot "expanded"
        Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedPath -Force
        $downloadedExecutable = Get-ChildItem -LiteralPath $expandedPath -Filter "tunnel-client.exe" -File -Recurse |
            Select-Object -First 1
        if (-not $downloadedExecutable) {
            throw "The downloaded archive did not contain tunnel-client.exe."
        }

        Copy-Item -LiteralPath $downloadedExecutable.FullName -Destination $targetPath -Force
        $version = (& $targetPath --version 2>$null | Select-Object -First 1)
        Write-Host "Installed official tunnel-client $version and verified SHA-256." -ForegroundColor Green
    } finally {
        $cleanupPath = [System.IO.Path]::GetFullPath($resolvedDownloadRoot)
        if ($cleanupPath.StartsWith($systemTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $cleanupPath) -like "luna-tunnel-*") {
            Remove-Item -LiteralPath $cleanupPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)) {
    throw "The bundled installer currently supports Windows only."
}

Assert-CommandAvailable -Name "node"
Assert-CommandAvailable -Name "npm"

$nodeVersionText = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersionText.Split(".")[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Installed version: $nodeVersionText"
}
Write-Host "Node.js $nodeVersionText detected." -ForegroundColor DarkGreen

$dependenciesHealthy = $false
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules")) {
    & npm ls --depth=0 --silent *> $null
    $dependenciesHealthy = $LASTEXITCODE -eq 0
}
if ($dependenciesHealthy) {
    Write-Host "npm dependencies are already installed." -ForegroundColor DarkGreen
} else {
    Write-Host "Installing locked npm dependencies with lifecycle scripts disabled..."
    & npm ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
}

Install-TunnelClient -Force:$ForceTunnelDownload

$environmentPath = Join-Path $PSScriptRoot ".env"
$environmentExamplePath = Join-Path $PSScriptRoot ".env.example"
if (-not (Test-Path -LiteralPath $environmentPath)) {
    Copy-Item -LiteralPath $environmentExamplePath -Destination $environmentPath
    Write-Host "Created .env from .env.example. Fill in CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID before starting." -ForegroundColor Yellow
}

Write-Host "Luna Unlimited installation is ready." -ForegroundColor Green
