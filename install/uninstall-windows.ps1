# Removes what install-windows.ps1 installed: the logon task, the processes it recorded, the soulstream and atom
# databases and the soulstream role, and the install folder. PostgreSQL and the coding agent CLIs stay.
#
# Usage, from an elevated PowerShell:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/uninstall-windows.ps1)))
#   options: [-InstallRoot <folder>] [-PostgresPassword <password>] [-NonInteractive]

param(
    [string]$InstallRoot = "",
    [string]$PostgresPassword = "",
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$TASK_NAME = "Soulstream"
$PG_SERVICE = "postgresql-x64-17"

function Write-Step { param([string]$Message) Write-Host ""; Write-Host "== $Message" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell (Run as administrator)."
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Join-Path $env:LOCALAPPDATA "Soulstream" }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Write-Step "Stopping Soulstream"
if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
}
foreach ($name in @("haniel.pid", "runner.pid")) {
    $file = Join-Path $InstallRoot $name
    if (-not (Test-Path $file)) { continue }
    $recorded = (Get-Content -LiteralPath $file | Select-Object -First 1)
    if ($recorded -match "^\d+$") {
        # A recorded PID can be reused after a reboot: only a process that was started from this folder is stopped.
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$recorded" -ErrorAction SilentlyContinue
        if ($owner -and $owner.CommandLine -and $owner.CommandLine.Contains($InstallRoot)) { & taskkill.exe /PID $recorded /T /F 2>&1 | Out-Null }
    }
}

Write-Step "Removing the databases"
$passwordFile = Join-Path $InstallRoot ".postgres-superuser-password"
$keptPassword = $null
if (Test-Path $passwordFile) { $keptPassword = (Get-Content -LiteralPath $passwordFile | Select-Object -First 1).Trim() }
if ([string]::IsNullOrEmpty($PostgresPassword)) { $PostgresPassword = $keptPassword }
$service = Get-Service -Name $PG_SERVICE -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Write-Host "   PostgreSQL service $PG_SERVICE not found; no database to remove."
} else {
    if ($service.Status -ne "Running") { Start-Service -Name $PG_SERVICE }
    if ([string]::IsNullOrEmpty($PostgresPassword)) {
        if ($NonInteractive) { throw "Pass the PostgreSQL superuser password with -PostgresPassword." }
        $secure = Read-Host "PostgreSQL superuser (postgres) password" -AsSecureString
        $PostgresPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    $pathName = (Get-CimInstance Win32_Service -Filter "Name='$PG_SERVICE'").PathName
    if ($pathName -notmatch '^"?([^"]+)\\pg_ctl\.exe') { throw "Cannot find the PostgreSQL bin folder from the $PG_SERVICE service." }
    $psql = Join-Path $Matches[1] "psql.exe"
    $env:PGPASSWORD = $PostgresPassword
    try {
        foreach ($sql in @("DROP DATABASE IF EXISTS soulstream WITH (FORCE)", "DROP DATABASE IF EXISTS atom WITH (FORCE)", "DROP ROLE IF EXISTS soulstream")) {
            & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c $sql
            if ($LASTEXITCODE -ne 0) { throw "psql failed for: $sql" }
        }
    } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
    Write-Host "   Removed the soulstream and atom databases and the soulstream role."
}

Write-Step "Removing the install folder"
if (Test-Path $InstallRoot) {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try { Remove-Item -LiteralPath $InstallRoot -Recurse -Force; break } catch {
            if ($attempt -eq 5) { throw }
            Start-Sleep -Seconds 2
        }
    }
}
Write-Host ""
Write-Host "Soulstream is removed. PostgreSQL and the coding agent CLIs are still installed." -ForegroundColor Green
if ($keptPassword) { Write-Host "The PostgreSQL superuser password the installer set was: $keptPassword" }
