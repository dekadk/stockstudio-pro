<#
.SYNOPSIS
    Environment-variable-driven Windows Authenticode signing helper for
    StockStudio Pro License Manager (com.stockstudiopro.licensemanager).

.DESCRIPTION
    Signs the standalone executable and/or NSIS installer using Windows SDK
    signtool.exe with SHA-256 and RFC 3161 timestamping.

    Security invariants:
    - Never hardcodes certificate thumbprints or passwords.
    - Never generates self-signed certificates.
    - Never reuses or modifies Tauri updater signing keys.
    - Reads thumbprint exclusively from $env:WINDOWS_CERT_THUMBPRINT.
    - Compatible with Windows PowerShell 5.1 under Set-StrictMode -Version Latest.

.EXAMPLE
    $env:WINDOWS_CERT_THUMBPRINT = "<40-char-sha1-thumbprint>"
    .\scripts\sign-windows-release.ps1 -TargetPath ".\dist-release-lm08b\StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED.exe"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,

    [string]$TimestampUrl = "http://timestamp.digicert.com",

    [string]$SignToolPath = "",

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-SignToolPath {
    param(
        [string]$ExplicitPath = "",
        [string]$WindowsKitsRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
            throw "Explicit SignToolPath not found: $ExplicitPath"
        }
        return [string](Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    $cmd = Get-Command signtool.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $cmd -and -not [string]::IsNullOrWhiteSpace($cmd.Source)) {
        return [string]$cmd.Source
    }

    if (Test-Path -LiteralPath $WindowsKitsRoot -PathType Container) {
        $kitCandidates = @(
            Get-ChildItem -Path (Join-Path $WindowsKitsRoot "*\x64\signtool.exe") -File -ErrorAction SilentlyContinue |
                Sort-Object FullName -Descending
        )
        if ($kitCandidates.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($kitCandidates[0].FullName)) {
            return [string]$kitCandidates[0].FullName
        }
    }

    throw "Windows SDK signtool.exe not found on PATH or under '$WindowsKitsRoot'. Install Windows 10/11 SDK Signing Tools first."
}

if ([string]::IsNullOrWhiteSpace($TargetPath) -or -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
    throw "Target binary not found: $TargetPath"
}
$resolvedTarget = [string](Resolve-Path -LiteralPath $TargetPath).Path

$thumbprint = $env:WINDOWS_CERT_THUMBPRINT
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
    throw "WINDOWS_CERT_THUMBPRINT environment variable is not set. Aborting without signing."
}
$thumbprint = $thumbprint.Trim()
if ($thumbprint -notmatch "^[0-9A-Fa-f]{40}$") {
    throw "WINDOWS_CERT_THUMBPRINT must be a 40-character hexadecimal SHA-1 thumbprint."
}

if ([string]::IsNullOrWhiteSpace($TimestampUrl) -or $TimestampUrl -notmatch "^https?://") {
    throw "TimestampUrl must be a valid http(s) RFC 3161 timestamp server URL."
}

[string]$signtoolExe = Resolve-SignToolPath -ExplicitPath $SignToolPath
if (-not (Test-Path -LiteralPath $signtoolExe -PathType Leaf)) {
    throw "Resolved signtool.exe does not exist: $signtoolExe"
}

$signArgs = @(
    "sign",
    "/fd", "sha256",
    "/tr", $TimestampUrl,
    "/td", "sha256",
    "/sha1", $thumbprint,
    $resolvedTarget
)

if ($DryRun) {
    $redactedThumb = $thumbprint.Substring(0, 6) + "..." + $thumbprint.Substring(36, 4)
    Write-Output ("DRY_RUN_OK | signtool={0} | target={1} | digest=sha256 | timestamp={2} | thumbprint={3}" -f $signtoolExe, $resolvedTarget, $TimestampUrl, $redactedThumb)
    exit 0
}

Write-Host ("Signing target with SHA-256 + RFC 3161 timestamp ({0}) using {1}..." -f $TimestampUrl, $signtoolExe)
& $signtoolExe @signArgs
if ($LASTEXITCODE -ne 0) {
    throw "signtool.exe exited with code $LASTEXITCODE."
}

$sig = Get-AuthenticodeSignature -FilePath $resolvedTarget
Write-Host ("Authenticode Status: {0} | Signer: {1}" -f $sig.Status, $sig.SignerCertificate.Subject)
if ($sig.Status -ne "Valid") {
    throw "Authenticode signature verification did not return Valid (got: $($sig.Status))."
}
