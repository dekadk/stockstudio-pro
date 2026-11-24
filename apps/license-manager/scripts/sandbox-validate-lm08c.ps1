Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$outDir = "C:\SandboxOutput"
$logFile = Join-Path $outDir "sandbox-lm08c.log"
$resultPath = Join-Path $outDir "sandbox-lm08c-result.json"
$installerSrc = "C:\SandboxInput\StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED.exe"
$localInstaller = Join-Path $env:TEMP "StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED.exe"
$installDir = Join-Path $env:LOCALAPPDATA "StockStudio Pro License Manager"
$appExe = Join-Path $installDir "stockstudio-pro-license-manager.exe"
$uninstallerExe = Join-Path $installDir "uninstall.exe"
$webviewDataDir = Join-Path $env:LOCALAPPDATA "com.stockstudiopro.licensemanager"
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$syntheticVault = Join-Path $env:USERPROFILE "Documents\lm08c-synthetic-vault.enc.json"
$syntheticCredTarget = "staging-admin-key.StockStudioPro-LicenseManager-Admin"

function Write-Log {
    param([string]$Msg)
    $line = "[{0}] {1}" -f ((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")), $Msg
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Get-WebView2Version {
    $keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    foreach ($k in $keys) {
        if (Test-Path $k) {
            $pv = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv
            if ($pv) { return [string]$pv }
        }
    }
    return $null
}

function Save-Screenshot {
    param([string]$FilePath)
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bmp.Save($FilePath, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose()
        $bmp.Dispose()
        return $true
    }
    catch {
        Write-Log "Screenshot warning ($FilePath): $($_.Exception.Message)"
        return $false
    }
}

$report = [ordered]@{
    milestone       = "LM-08C"
    started_at_utc  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    sandbox_user    = $env:USERNAME
    webview2_before = $null
    webview2_after  = $null
    steps           = [ordered]@{}
    overall_pass    = $false
    error           = $null
}

try {
    Write-Log "LM-08C Sandbox validation started as $env:USERNAME"
    if (-not (Test-Path -LiteralPath $installerSrc)) {
        throw "Installer not found at $installerSrc"
    }

    # Check initial Credential Manager isolation (zero host credentials)
    $initialCredList = (& cmdkey.exe /list) | Out-String
    $hostCredLeaked = ($initialCredList -match "StockStudioPro-LicenseManager-Admin")
    Write-Log "Initial credential isolation check: hostCredLeaked=$hostCredLeaked"

    $report.webview2_before = Get-WebView2Version
    Write-Log "WebView2 before install: $($report.webview2_before)"

    Copy-Item -LiteralPath $installerSrc -Destination $localInstaller -Force
    Write-Log "Copied installer to $localInstaller"

    # Phase 3: Fresh Installation (silent NSIS /S; allows WebView2 bootstrapper download if needed)
    Write-Log "Running fresh NSIS install (/S)..."
    $p1 = Start-Process -FilePath $localInstaller -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 3
    $report.webview2_after = Get-WebView2Version
    $exeExists = Test-Path -LiteralPath $appExe
    $uninstExists = Test-Path -LiteralPath $uninstallerExe
    $shortcuts = @(Get-ChildItem -Path $startMenuDir -Recurse -Filter "*License Manager*.lnk" -ErrorAction SilentlyContinue)
    Write-Log "Fresh install finished: exit=$($p1.ExitCode) exe=$exeExists uninst=$uninstExists shortcuts=$($shortcuts.Count) wv2_after=$($report.webview2_after)"

    $report.steps.fresh_install = [ordered]@{
        exit_code          = $p1.ExitCode
        install_dir        = $installDir
        exe_exists         = $exeExists
        uninstaller_exists = $uninstExists
        shortcut_count     = $shortcuts.Count
        webview2_installed = [bool]$report.webview2_after
        host_cred_isolated = (-not $hostCredLeaked)
        pass               = ($p1.ExitCode -eq 0 -and $exeExists -and $uninstExists -and $shortcuts.Count -ge 1 -and (-not $hostCredLeaked))
    }

    if (-not $exeExists) {
        throw "Fresh install failed: exit_code=$($p1.ExitCode), exe not found at $appExe"
    }

    # Launch app & verify window + screenshot
    Write-Log "Launching installed License Manager..."
    $appProc = Start-Process -FilePath $appExe -PassThru
    Start-Sleep -Seconds 7
    $appProc.Refresh()
    $stillRunning = -not $appProc.HasExited
    $winTitle = if ($stillRunning) { [string]$appProc.MainWindowTitle } else { "" }
    $webviewCreated = Test-Path -LiteralPath $webviewDataDir
    $shot1 = Save-Screenshot (Join-Path $outDir "01-fresh-launch-locked.png")
    Write-Log "Fresh launch check: running=$stillRunning title='$winTitle' webviewDir=$webviewCreated shot1=$shot1"

    if ($stillRunning) {
        Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    $report.steps.fresh_launch = [ordered]@{
        running             = $stillRunning
        main_window_title   = $winTitle
        webview_dir_created = $webviewCreated
        screenshot_captured = $shot1
        pass                = ($stillRunning -and $webviewCreated)
    }

    # Phase 5 (Prep): Synthetic Credential Manager entry & synthetic encrypted vault file
    Write-Log "Writing synthetic sandbox-only credential & synthetic .enc.json vault..."
    & cmdkey.exe /generic:$syntheticCredTarget /user:staging-admin-key /pass:SYNTHETIC_LM08C_TEST_ONLY | Out-Null
    $credStored = ((& cmdkey.exe /list:$syntheticCredTarget) | Out-String) -match [regex]::Escape($syntheticCredTarget)
    New-Item -ItemType Directory -Force (Split-Path $syntheticVault -Parent) | Out-Null
    '{"format":"stockstudio-pro-license-vault-v1","synthetic":true,"ciphertext_b64":"bG0wOGM="}' | Set-Content -LiteralPath $syntheticVault -Encoding UTF8
    $vaultHashBefore = (Get-FileHash -LiteralPath $syntheticVault -Algorithm SHA256).Hash.ToLower()

    # Phase 4: Upgrade / In-Place Reinstall Over Existing Installation
    Write-Log "Running in-place upgrade installation (/S)..."
    $p2 = Start-Process -FilePath $localInstaller -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 3
    $exeAfterUpgrade = Test-Path -LiteralPath $appExe
    $credAfterUpgrade = ((& cmdkey.exe /list:$syntheticCredTarget) | Out-String) -match [regex]::Escape($syntheticCredTarget)
    $vaultHashAfterUpgrade = (Get-FileHash -LiteralPath $syntheticVault -Algorithm SHA256).Hash.ToLower()

    $appProc2 = Start-Process -FilePath $appExe -PassThru
    Start-Sleep -Seconds 6
    $appProc2.Refresh()
    $launchedAfterUpgrade = -not $appProc2.HasExited
    $shot2 = Save-Screenshot (Join-Path $outDir "02-post-upgrade-launch.png")
    if ($launchedAfterUpgrade) {
        Stop-Process -Id $appProc2.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    Write-Log "Upgrade check: exit=$($p2.ExitCode) launched=$launchedAfterUpgrade credPreserved=$credAfterUpgrade vaultPreserved=$($vaultHashBefore -eq $vaultHashAfterUpgrade) shot2=$shot2"

    $report.steps.upgrade_install = [ordered]@{
        exit_code              = $p2.ExitCode
        exe_exists             = $exeAfterUpgrade
        launched_after_upgrade = $launchedAfterUpgrade
        credential_preserved   = ($credStored -and $credAfterUpgrade)
        vault_preserved        = ($vaultHashBefore -eq $vaultHashAfterUpgrade)
        screenshot_captured    = $shot2
        pass                   = ($p2.ExitCode -eq 0 -and $exeAfterUpgrade -and $launchedAfterUpgrade -and $credStored -and $credAfterUpgrade -and ($vaultHashBefore -eq $vaultHashAfterUpgrade))
    }

    # Phase 6: Uninstall Validation
    Write-Log "Running silent NSIS uninstall (/S)..."
    $p3 = Start-Process -FilePath $uninstallerExe -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 5
    $exeRemoved = -not (Test-Path -LiteralPath $appExe)
    $shortcutsAfter = @(Get-ChildItem -Path $startMenuDir -Recurse -Filter "*License Manager*.lnk" -ErrorAction SilentlyContinue)
    $credAfterUninstall = ((& cmdkey.exe /list:$syntheticCredTarget) | Out-String) -match [regex]::Escape($syntheticCredTarget)
    $vaultExistsAfterUninstall = Test-Path -LiteralPath $syntheticVault
    $vaultHashAfterUninstall = if ($vaultExistsAfterUninstall) { (Get-FileHash -LiteralPath $syntheticVault -Algorithm SHA256).Hash.ToLower() } else { "" }
    $residualWebviewDir = Test-Path -LiteralPath $webviewDataDir

    # Phase 5 (Cleanup): Explicit Credential Removal Verification
    & cmdkey.exe /delete:$syntheticCredTarget | Out-Null
    $credRemovedExplicitly = -not (((& cmdkey.exe /list:$syntheticCredTarget) | Out-String) -match [regex]::Escape($syntheticCredTarget))

    Write-Log "Uninstall check: exit=$($p3.ExitCode) exeRemoved=$exeRemoved shortcutsLeft=$($shortcutsAfter.Count) credPreserved=$credAfterUninstall vaultPreserved=$vaultExistsAfterUninstall residualWebview=$residualWebviewDir explicitCredDelete=$credRemovedExplicitly"

    $report.steps.credential_manager = [ordered]@{
        synthetic_stored            = $credStored
        isolated_from_host          = (-not $hostCredLeaked)
        preserved_across_upgrade    = $credAfterUpgrade
        preserved_across_uninstall  = $credAfterUninstall
        explicit_removal_succeeded  = $credRemovedExplicitly
        pass                        = ($credStored -and (-not $hostCredLeaked) -and $credAfterUpgrade -and $credAfterUninstall -and $credRemovedExplicitly)
    }

    $report.steps.uninstall = [ordered]@{
        exit_code                 = $p3.ExitCode
        exe_removed               = $exeRemoved
        shortcuts_remaining       = $shortcutsAfter.Count
        credential_preserved      = $credAfterUninstall
        vault_preserved           = ($vaultExistsAfterUninstall -and ($vaultHashBefore -eq $vaultHashAfterUninstall))
        residual_webview_data_dir = $residualWebviewDir
        pass                      = ($p3.ExitCode -eq 0 -and $exeRemoved -and $shortcutsAfter.Count -eq 0 -and $credAfterUninstall -and $vaultExistsAfterUninstall -and ($vaultHashBefore -eq $vaultHashAfterUninstall))
    }

    $report.overall_pass = (
        $report.steps.fresh_install.pass -and
        $report.steps.fresh_launch.pass -and
        $report.steps.upgrade_install.pass -and
        $report.steps.credential_manager.pass -and
        $report.steps.uninstall.pass
    )
    Write-Log "LM-08C Sandbox validation completed: overall_pass=$($report.overall_pass)"
}
catch {
    $report.error = $_.Exception.Message
    $report.overall_pass = $false
    Write-Log "ERROR: $($_.Exception.Message)"
}
finally {
    $report.finished_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
