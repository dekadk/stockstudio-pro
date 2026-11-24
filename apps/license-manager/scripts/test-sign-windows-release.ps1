Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptPath = (Resolve-Path (Join-Path $PSScriptRoot "sign-windows-release.ps1")).Path
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("lm08b-sign-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmpDir | Out-Null

$origPath = $env:PATH
$origThumb = $env:WINDOWS_CERT_THUMBPRINT

function Invoke-PS51 {
    param([string[]]$ArgsList)
    $ps51 = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $ps51 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath @ArgsList 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
    return [pscustomobject]@{
        ExitCode = $code
        Output   = ($out | Out-String).Trim()
    }
}

try {
    # Create synthetic dummy target binary & dummy PATH signtool.exe
    $dummyTarget = Join-Path $tmpDir "dummy-installer.exe"
    [System.IO.File]::WriteAllText($dummyTarget, "dummy")
    $stubBinDir = Join-Path $tmpDir "stub-bin"
    New-Item -ItemType Directory -Force $stubBinDir | Out-Null
    $stubSignTool = Join-Path $stubBinDir "signtool.exe"
    [System.IO.File]::WriteAllText($stubSignTool, "stub")

    $syntheticThumb = "0123456789ABCDEF0123456789ABCDEF01234567"

    # Test 6: PowerShell 5.1 AST & StrictMode syntax check
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw "TEST 6 FAILED: AST parse errors: $($errors.Count)" }
    Write-Output "PASS 6: PowerShell 5.1 AST & StrictMode parse check (0 errors)"

    # Test 1: SignTool found through PATH
    $env:PATH = "$stubBinDir;$origPath"
    $env:WINDOWS_CERT_THUMBPRINT = $syntheticThumb
    $r1 = Invoke-PS51 @("-TargetPath", $dummyTarget, "-DryRun")
    if ($r1.ExitCode -ne 0 -or $r1.Output -notmatch "DRY_RUN_OK" -or $r1.Output -notmatch [regex]::Escape($stubSignTool)) {
        throw "TEST 1 FAILED: $($r1.Output)"
    }
    if ($r1.Output -match $syntheticThumb) {
        throw "TEST 1 FAILED: Full thumbprint leaked in output"
    }
    Write-Output "PASS 1: SignTool resolved via PATH (normalized string, thumbprint redacted)"

    # Test 2: SignTool found via Windows SDK fallback (not on PATH) AND explicit SDK path
    $env:PATH = "C:\Windows\System32;C:\Windows"
    $r2a = Invoke-PS51 @("-TargetPath", $dummyTarget, "-DryRun")
    if ($r2a.ExitCode -ne 0 -or $r2a.Output -notmatch "Windows Kits\\10\\bin\\.*\\x64\\signtool\.exe") {
        throw "TEST 2a (SDK fallback) FAILED: $($r2a.Output)"
    }
    $r2b = Invoke-PS51 @("-TargetPath", $dummyTarget, "-SignToolPath", $stubSignTool, "-DryRun")
    if ($r2b.ExitCode -ne 0 -or $r2b.Output -notmatch [regex]::Escape($stubSignTool)) {
        throw "TEST 2b (Explicit SDK path) FAILED: $($r2b.Output)"
    }
    Write-Output "PASS 2: SignTool resolved via Windows SDK FileInfo fallback (.FullName) & explicit path"

    # Test 3: Missing SignTool produces clear error
    $r3 = Invoke-PS51 @("-TargetPath", $dummyTarget, "-SignToolPath", (Join-Path $tmpDir "nonexistent-signtool.exe"), "-DryRun")
    if ($r3.ExitCode -eq 0 -or $r3.Output -notmatch "SignToolPath not found") {
        throw "TEST 3 FAILED: $($r3.Output)"
    }
    Write-Output "PASS 3: Missing SignTool produced clear error"

    # Test 4: Missing certificate thumbprint produces clear error
    $env:WINDOWS_CERT_THUMBPRINT = ""
    $r4 = Invoke-PS51 @("-TargetPath", $dummyTarget, "-SignToolPath", $stubSignTool, "-DryRun")
    if ($r4.ExitCode -eq 0 -or $r4.Output -notmatch "WINDOWS_CERT_THUMBPRINT environment variable is not set") {
        throw "TEST 4 FAILED: $($r4.Output)"
    }
    Write-Output "PASS 4: Missing certificate thumbprint produced clear error"

    # Test 5: Missing target binary produces clear error
    $env:WINDOWS_CERT_THUMBPRINT = $syntheticThumb
    $r5 = Invoke-PS51 @("-TargetPath", (Join-Path $tmpDir "does-not-exist.exe"), "-SignToolPath", $stubSignTool, "-DryRun")
    if ($r5.ExitCode -eq 0 -or $r5.Output -notmatch "Target binary not found") {
        throw "TEST 5 FAILED: $($r5.Output)"
    }
    Write-Output "PASS 5: Missing target binary produced clear error"

    Write-Output "ALL_SIGNING_SCRIPT_TESTS_PASSED=6/6"
}
finally {
    $env:PATH = $origPath
    $env:WINDOWS_CERT_THUMBPRINT = $origThumb
    if (Test-Path -LiteralPath $tmpDir) {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
