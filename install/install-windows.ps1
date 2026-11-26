# Soulstream for Windows: installs the orchestrator, a local worker, atom and the dashboard natively.
#
# Usage, from an elevated PowerShell:
#   irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install-windows.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install-windows.ps1))) -WorkerPort 4305
#
# This script checks and installs the tools, prepares PostgreSQL 17, fetches the sources and starts Haniel from a logon
# task. Secrets, configuration, databases, schema and atom setup are done by install/windows/setup.mjs.

param(
    [string]$InstallRoot = "",
    [int]$WorkerPort = 4205,
    [string]$Ref = "main",
    [string]$AtomRef = "main",
    [string]$Backends = "claude,codex",
    [string]$PostgresPassword = "",
    [string]$AdminPasswordFile = "",
    [string]$RepositoryUrl = "https://github.com/eiaserinnys/soulstream.git",
    [string]$AtomRepositoryUrl = "https://github.com/eiaserinnys/atom.git",
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$TASK_NAME = "Soulstream"
$PNPM_VERSION = "10.32.1"
$MINIMUM_NODE_VERSION = [version]"22.5.0"
$HANIEL_COMMIT = "d143f0d8f7afffa4656f4ed10349a376cef585a1"
$PG_SERVICE = "postgresql-x64-17"
$PG_PORT = 5432

function Write-Step { param([string]$Message) Write-Host ""; Write-Host "== $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "   $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "   WARNING: $Message" -ForegroundColor Yellow }

function Invoke-Native {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}

function Test-CommandExists { param([string]$Command) $null -ne (Get-Command $Command -ErrorAction SilentlyContinue) }

function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Install-WithWinget {
    param([string]$Id, [string[]]$Extra = @())
    if (-not (Test-CommandExists "winget")) {
        throw "winget is not available, so $Id cannot be installed automatically. Install it by hand, then run this script again."
    }
    Invoke-Native "winget" (@("install", "--id", $Id, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements") + $Extra)
    Update-SessionPath
}

function Find-Python {
    foreach ($cmd in @("py", "python", "python3")) {
        if (-not (Test-CommandExists $cmd)) { continue }
        $version = & $cmd --version 2>&1
        if ("$version" -match "Python (\d+)\.(\d+)") {
            if ([int]$Matches[1] -gt 3 -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 11)) { return $cmd }
        }
    }
    return $null
}

function Get-PortOwner {
    param([int]$Port)
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $connection) { return $null }
    $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($process) { $process.ProcessName } else { "unknown" }
    return "$name (PID $($connection.OwningProcess))"
}

# Stops what a previous run of this installer started: the logon task and the Haniel process tree it recorded.
function Stop-Soulstream {
    param([string]$Root)
    $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue }
    foreach ($name in @("haniel.pid", "runner.pid")) {
        $file = Join-Path $Root $name
        if (Test-Path $file) {
            $recorded = (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($recorded -match "^\d+$") {
                # A recorded PID can be reused after a reboot: only a process that was started from this folder is stopped.
                $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$recorded" -ErrorAction SilentlyContinue
                if ($owner -and $owner.CommandLine -and $owner.CommandLine.Contains($Root)) { & taskkill.exe /PID $recorded /T /F 2>&1 | Out-Null }
            }
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host ""
Write-Host "Soulstream installer for Windows" -ForegroundColor Cyan

# ---- 0. this machine ----
Write-Step "Checking this machine"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell (Run as administrator)."
}
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne "AMD64" -or [Environment]::OSVersion.Version.Major -lt 10) {
    throw "Windows 10 or 11 on x64 is required."
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Join-Path $env:LOCALAPPDATA "Soulstream" }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$requestedBackends = $Backends.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
foreach ($backend in $requestedBackends) {
    if ($backend -notin @("claude", "codex")) { throw "-Backends accepts claude and codex. '$backend' is not supported on Windows." }
}
if ($WorkerPort -lt 1024 -or $WorkerPort -gt 65534) { throw "-WorkerPort must be from 1024 to 65534." }
$soulDir = Join-Path $InstallRoot "soulstream"
$atomDir = Join-Path $InstallRoot "atom"
$logsDir = Join-Path $InstallRoot "logs"
$venvDir = Join-Path $InstallRoot "venv"
New-Item -ItemType Directory -Force -Path $InstallRoot, $logsDir | Out-Null
Write-Ok "Install folder: $InstallRoot"

# ---- 1. what a previous run left running ----
Write-Step "Stopping a previous installation"
Stop-Soulstream -Root $InstallRoot
foreach ($port in @(5200, 4200, $WorkerPort, ($WorkerPort + 1))) {
    $owner = Get-PortOwner -Port $port
    if ($owner) {
        $hint = if ($port -eq 5200 -or $port -eq 4200) { "Stop that program; port $port is fixed." } else { "Stop that program or pass another -WorkerPort." }
        throw "Port $port is in use by $owner. $hint"
    }
}
Write-Ok "Ports 5200, 4200, $WorkerPort and $($WorkerPort + 1) are free."

# ---- 2. tools ----
Write-Step "Checking tools"
if (-not (Test-CommandExists "git")) { Write-Host "   Installing Git..."; Install-WithWinget "Git.Git" }
if (-not (Test-CommandExists "git")) { throw "Git was installed but is not on PATH. Open a new elevated PowerShell and run this script again." }
$nodeOk = $false
if (Test-CommandExists "node") {
    $nodeOk = ([version](((node --version) -replace "v", "")) -ge $MINIMUM_NODE_VERSION)
}
if (-not $nodeOk) { Write-Host "   Installing Node.js..."; Install-WithWinget "OpenJS.NodeJS.LTS" }
if (-not (Test-CommandExists "node") -or ([version](((node --version) -replace "v", "")) -lt $MINIMUM_NODE_VERSION)) {
    throw "Node.js 22.5 or newer is required."
}
$pythonCmd = Find-Python
if ($null -eq $pythonCmd) { Write-Host "   Installing Python..."; Install-WithWinget "Python.Python.3.12"; $pythonCmd = Find-Python }
if ($null -eq $pythonCmd) { throw "Python 3.11 or newer is required." }
$pnpmVersion = if (Test-CommandExists "pnpm") { ((pnpm --version) | Select-Object -First 1).Trim() } else { "" }
if (-not $pnpmVersion.StartsWith("10.")) {
    Write-Host "   Installing pnpm $PNPM_VERSION..."
    Invoke-Native "npm" @("install", "-g", "pnpm@$PNPM_VERSION")
    Update-SessionPath
}
Write-Ok "git, node $(node --version), python, pnpm $(pnpm --version)"

# ---- 3. PostgreSQL 17 ----
Write-Step "Preparing PostgreSQL 17"
$passwordFile = Join-Path $InstallRoot ".postgres-superuser-password"
$service = Get-Service -Name $PG_SERVICE -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Write-Host "   Installing PostgreSQL 17 (this takes a few minutes)..."
    $generated = -join ((1..24) | ForEach-Object { "{0:x}" -f (Get-Random -Maximum 16) })
    Set-Content -LiteralPath $passwordFile -Value $generated -Encoding ASCII
    & icacls.exe $passwordFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
    $override = "--mode unattended --unattendedmodeui minimal --superpassword $generated --serverport $PG_PORT --servicename $PG_SERVICE"
    Install-WithWinget "PostgreSQL.PostgreSQL.17" @("--override", $override)
    $installedPath = (Get-CimInstance Win32_Service -Filter "Name='$PG_SERVICE'").PathName
    if ($installedPath -notmatch '-D\s+"([^"]+)"') { throw "Cannot find the PostgreSQL data folder from the $PG_SERVICE service." }
    Add-Content -LiteralPath (Join-Path $Matches[1] "postgresql.conf") -Value "`nlisten_addresses = 'localhost'"
    Restart-Service -Name $PG_SERVICE
    $service = Get-Service -Name $PG_SERVICE
}
if ($service.StartType -ne "Automatic") { Set-Service -Name $PG_SERVICE -StartupType Automatic }
if ($service.Status -ne "Running") { Start-Service -Name $PG_SERVICE }
$pathName = (Get-CimInstance Win32_Service -Filter "Name='$PG_SERVICE'").PathName
if ($pathName -notmatch '^"?([^"]+)\\pg_ctl\.exe') { throw "Cannot find the PostgreSQL bin folder from the $PG_SERVICE service." }
$pgBin = $Matches[1]
if ([string]::IsNullOrEmpty($PostgresPassword) -and (Test-Path $passwordFile)) { $PostgresPassword = (Get-Content -LiteralPath $passwordFile | Select-Object -First 1).Trim() }
if ([string]::IsNullOrEmpty($PostgresPassword)) {
    if ($NonInteractive) { throw "PostgreSQL is already installed. Pass its superuser password with -PostgresPassword." }
    $secure = Read-Host "PostgreSQL superuser (postgres) password" -AsSecureString
    $PostgresPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$env:SOULSTREAM_PG_PASSWORD = $PostgresPassword
$env:PGPASSWORD = $PostgresPassword
$ready = $false
for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
    & (Join-Path $pgBin "pg_isready.exe") -h 127.0.0.1 -p $PG_PORT | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 2 }
}
if (-not $ready) { throw "PostgreSQL does not accept connections on 127.0.0.1:$PG_PORT." }
$answer = & (Join-Path $pgBin "psql.exe") -h 127.0.0.1 -p $PG_PORT -U postgres -d postgres -tAc "SELECT 1"
if ("$answer".Trim() -ne "1") { throw "Could not sign in to PostgreSQL as postgres. Check -PostgresPassword." }
Remove-Item Env:\PGPASSWORD
Write-Ok "PostgreSQL 17 is running on 127.0.0.1:$PG_PORT."

# ---- 4. coding agent CLIs ----
Write-Step "Checking coding agent CLIs"
try {
    if ($requestedBackends -contains "claude" -and -not (Test-CommandExists "claude")) {
        Write-Host "   Installing Claude Code..."
        Invoke-RestMethod "https://claude.ai/install.ps1" | Invoke-Expression
        Update-SessionPath
    }
    if ($requestedBackends -contains "codex" -and -not (Test-CommandExists "codex")) {
        Write-Host "   Installing Codex CLI..."
        Invoke-Native "npm" @("install", "-g", "@openai/codex")
        Update-SessionPath
    }
} catch {
    Write-Warn "A coding agent CLI could not be installed: $($_.Exception.Message) Install it later; the dashboard shows how to connect it."
}

# ---- 5. sources ----
Write-Step "Fetching sources"
function Sync-Repository {
    param([string]$Url, [string]$Directory, [string]$Revision)
    if (Test-Path (Join-Path $Directory ".git")) {
        $dirty = & git -C $Directory status --porcelain --untracked-files=no
        if ($dirty) { throw "$Directory has local changes. Commit or discard them, then run this script again." }
    } else {
        Invoke-Native "git" @("clone", "--no-checkout", $Url, $Directory)
    }
    Invoke-Native "git" @("-C", $Directory, "fetch", "--tags", "origin", $Revision)
    Invoke-Native "git" @("-C", $Directory, "checkout", "--force", "--detach", "FETCH_HEAD")
}
Sync-Repository -Url $RepositoryUrl -Directory $soulDir -Revision $Ref
Sync-Repository -Url $AtomRepositoryUrl -Directory $atomDir -Revision $AtomRef
Write-Ok "soulstream $(git -C $soulDir rev-parse --short=12 HEAD), atom $(git -C $atomDir rev-parse --short=12 HEAD)"

# ---- 6. set up and build (Node) ----
$setup = Join-Path $soulDir "install\windows\setup.mjs"
$common = @("--install-root", $InstallRoot, "--worker-port", "$WorkerPort", "--backends", ($requestedBackends -join ","), "--pg-bin", $pgBin)
$prepare = @($setup, "prepare") + $common
if ($AdminPasswordFile) { $prepare += @("--admin-password-file", (Resolve-Path -LiteralPath $AdminPasswordFile).Path) }
Invoke-Native "node" $prepare
Remove-Item Env:\SOULSTREAM_PG_PASSWORD

# ---- 7. Haniel in its own virtual environment ----
Write-Step "Installing Haniel"
if (-not (Test-Path (Join-Path $venvDir "Scripts\python.exe"))) { Invoke-Native $pythonCmd @("-m", "venv", $venvDir) }
Invoke-Native (Join-Path $venvDir "Scripts\python.exe") @("-m", "pip", "install", "--disable-pip-version-check", "git+https://github.com/eiaserinnys/haniel.git@$HANIEL_COMMIT")
Invoke-Native "node" (@($setup, "haniel-config") + $common)

# ---- 8. logon task ----
Write-Step "Registering the logon task"
$haniel = Join-Path $venvDir "Scripts\haniel.exe"
$hanielYaml = Join-Path $InstallRoot "haniel.yaml"
$runner = Join-Path $InstallRoot "run-haniel.ps1"
@"
`$ErrorActionPreference = 'Stop'
`$process = Start-Process -FilePath '$haniel' -ArgumentList @('run', '"$hanielYaml"') -WorkingDirectory '$InstallRoot' -WindowStyle Hidden -PassThru -RedirectStandardOutput '$logsDir\haniel.out.log' -RedirectStandardError '$logsDir\haniel.err.log'
Set-Content -LiteralPath '$InstallRoot\haniel.pid' -Value `$process.Id -Encoding ASCII
`$process.WaitForExit()
"@ | Set-Content -LiteralPath $runner -Encoding ASCII
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TASK_NAME
$started = $false
for ($i = 0; $i -lt 60 -and -not $started; $i++) {
    Start-Sleep -Seconds 1
    $started = Test-Path (Join-Path $InstallRoot "haniel.pid")
    if (-not $started -and $i -ge 15 -and (Get-ScheduledTask -TaskName $TASK_NAME).State -ne "Running") { break }
}
if (-not $started) {
    Write-Warn "The logon task did not start in this session; starting Haniel directly for now. It starts at your next logon."
    $direct = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$runner`"") -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath (Join-Path $InstallRoot "runner.pid") -Value $direct.Id -Encoding ASCII
}
Write-Ok "Task '$TASK_NAME' registered and started."

# ---- 9. wait and finish (Node) ----
Invoke-Native "node" (@($setup, "finish") + $common)
Write-Host ""
Write-Host "Remove it with: install\uninstall-windows.ps1 (or the same script from the repository's install folder)." -ForegroundColor DarkGray
