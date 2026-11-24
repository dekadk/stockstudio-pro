Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resultPath = "C:\SandboxOutput\sandbox-validation-result.json"
$installerPath = "C:\SandboxInput\StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED-PREVIEW.exe"
$installDir = Join-Path $env:LOCALAPPDATA "StockStudio Pro License Manager"
$appExe = Join-Path $installDir "stockstudio-pro-license-manager.exe"
$uninstallerExe = Join-Path $installDir "uninstall.exe"
$webviewDataDir = Join-Path $env:LOCALAPPDATA "com.stockstudiopro.licensemanager"
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$syntheticVault = Join-Path $env:USERPROFILE "Documents\lm08b-synthetic-vault.enc.json"
$syntheticCredTarget = "staging-admin-key.StockStudioPro-LicenseManager-Admin"

$report = [ordered]@{
    started_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    sandbox_user   = $env:USERNAME
    steps          = [ordered]@{}
    overall_pass   = $false
    error          = $null
}

try {
    if (-not (Test-Path -LiteralPath $installerPath)) {
        throw "Installer not found in SandboxInput: $installerPath"
    }

    # Copy installer to local writable %TEMP% inside Sandbox
    $localInstaller = Join-Path $env:TEMP "StockStudio-Pro-License-Manager-setup.exe"
    Copy-Item -LiteralPath $installerPath -Destination $localInstaller -Force

    # Check if WebView2 Runtime is preinstalled in Windows Sandbox
    $wv2Keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    $wv2Version = $null
    foreach ($k in $wv2Keys) {
        if (Test-Path $k) {
            $pv = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv
            if ($pv) { $wv2Version = $pv; break }
        }
    }
    $report.webview2_preinstalled = [bool]$wv2Version
    $report.webview2_version = $wv2Version

    # 1. Fresh Installation (Per-User Silent NSIS)
    $p1 = Start-Process -FilePath $localInstaller -ArgumentList "/S" -Wait -PassThru
    $exeExists = Test-Path -LiteralPath $appExe
    $uninstExists = Test-Path -LiteralPath $uninstallerExe
    $shortcuts = @(Get-ChildItem -Path $startMenuDir -Recurse -Filter "*License Manager*.lnk" -ErrorAction SilentlyContinue)
    $report.steps.fresh_install = [ordered]@{
        exit_code          = $p1.ExitCode
        install_dir        = $installDir
        exe_exists         = $exeExists
        uninstaller_exists = $uninstExists
        shortcut_count     = $shortcuts.Count
        pass               = ($p1.ExitCode -eq 0 -and $exeExists -and $uninstExists -and $shortcuts.Count -ge 1)
    }

    if (-not $exeExists) {
        throw "NSIS installer exited with code $($p1.ExitCode) and did not create $appExe (webview2_preinstalled=$($report.webview2_preinstalled))"
    }

    # 2. Launch App & Verify Running Process + Isolated Data Dir
    $appProc = Start-Process -FilePath $appExe -PassThru
    Start-Sleep -Seconds 5
    $stillRunning = -not $appProc.HasExited
    $webviewCreated = Test-Path -LiteralPath $webviewDataDir
    if ($stillRunning) {
        Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    $report.steps.startup_check = [ordered]@{
        process_started_and_stayed_running = $stillRunning
        webview_data_dir_created           = $webviewCreated
        pass                               = $stillRunning
    }

    # 3. Provision Synthetic Sandbox-Only Credential & Vault Export
    & cmdkey.exe /generic:$syntheticCredTarget /user:staging-admin-key /pass:SYNTHETIC_LM08B_SANDBOX_ONLY | Out-Null
    $credBefore = ((& cmdkey.exe /list:$syntheticCredTarget) | Out-String) -match [regex]::Escape($syntheticCredTarget)
    New-Item -ItemType Directory -Force (Split-Path $syntheticVault -Parent) | Out-Null
    '{"format":"synthetic-lm08b-test","ciphertext_b64":"c3ludGhldGlj"}' | Set-Content -LiteralPath $syntheticVault -Encoding UTF8
    $vaultHashBefore = (Get-FileHash -LiteralPath $syntheticVault -Algorithm SHA256).Hash.ToLower()

    # 4. Upgrade / Reinstall Over Existing Installation
    $p2 = Start-Process -FilePath $localInstaller -ArgumentList "/S" -Wait -PassThru
    $exeAfterUpgrade = Test-Path -LiteralPath $appExe
    $credAfterUpgrade = ((& cmdkey.exe /list:$syntheticCredTarget) | Out-String) -match [regex]::Escape($syntheticCredTarget)
    $vaultHashAfterUpgrade = (Get-FileHash -LiteralPath $syntheticVault -Algorithm SHA256).Hash.ToLower()

    $appProc2 = Start-Process -FilePath $appExe -PassThru
    Start-Sleep -Seconds 4
    $launchedAfterUpgrade = -not $appProc2.HasExited
    if ($launchedAfterUpgrade) {
        Stop-Process -Id $appProc2.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    $report.steps.upgrade_install = [ordered]@{
        exit_code              = $p2.ExitCode
        exe_exists             = $exeAfterUpgrade
        launched_after_upgrade = $launchedAfterUpgrade
        credential_preserved   = ($credBefore -and $credAfterUpgrade)
        vault_preserved        = ($vaultHashBefore -eq $vaultHashAfterUpgrade)
        pass                   = ($p2.ExitCode -eq 0 -and $exeAfterUpgrade -and $launchedAfterUpgrade -and $credBefore -and $credAfterUpgrade -and ($vaultHashBefore -eq $vaultHashAfterUpgrade))
    }

    # 5. Uninstallation & Cleanup Verification
    $p3 = Start-Process -FilePath $uninstallerExe -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 4
    $exeRemoved = -not (Test-Path -LiteralPath $appExe)
    $shortcutsAfter = @(Get-ChildItem -Path $startMenuDir -Recurse -Filter "*License Manager*.lnk" -ErrorAction SilentlyContinue)
    $credAfterUninstall = ((& cmdkey.exe /list:$syntheticCredTarget) | Out-String) -match [regex]::Escape($syntheticCredTarget)
    $vaultExistsAfterUninstall = Test-Path -LiteralPath $syntheticVault
    $vaultHashAfterUninstall = if ($vaultExistsAfterUninstall) { (Get-FileHash -LiteralPath $syntheticVault -Algorithm SHA256).Hash.ToLower() } else { "" }
    $residualWebviewDir = Test-Path -LiteralPath $webviewDataDir

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
        $report.steps.startup_check.pass -and
        $report.steps.upgrade_install.pass -and
        $report.steps.uninstall.pass
    )
}
catch {
    $report.error = $_.Exception.Message
    $report.overall_pass = $false
}
finally {
    $report.finished_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
