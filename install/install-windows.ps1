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
# A host without a console (a scheduled run, some CI hosts) rejects the setter on Windows PowerShell 5.1.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$TASK_NAME = "SoulstreamServer"
$INSTALL_MARKER = ".soulstream-windows-install"
$PNPM_VERSION = "10.32.1"
$MINIMUM_NODE_VERSION = [version]"22.5.0"
$HANIEL_COMMIT = "d143f0d8f7afffa4656f4ed10349a376cef585a1"
$PG_SERVICE = "postgresql-x64-17"
$PG_PORT = 5432

function Write-Step { param([string]$Message) Write-Host ""; Write-Host "== $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "   $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "   WARNING: $Message" -ForegroundColor Yellow }

# Windows PowerShell 5.1 turns native stderr into error records, which stop the script under
# $ErrorActionPreference = "Stop" whenever stderr is redirected or the host output is captured. Every native command
# runs through these two with the preference relaxed; the exit code decides.
function Invoke-Native {
    param([string]$File, [string[]]$Arguments)
    $ErrorActionPreference = "Continue"
    & $File @Arguments 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}

# Standard output only; the caller checks $LASTEXITCODE when it matters.
function Get-NativeOutput {
    param([string]$File, [string[]]$Arguments)
    $ErrorActionPreference = "Continue"
    & $File @Arguments 2>$null
}

# A PowerShell single-quoted literal: a quote inside is written twice, so C:\Users\O'Brien stays one string.
function ConvertTo-SingleQuoted { param([string]$Value) "'" + $Value.Replace("'", "''") + "'" }

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
        $version = Get-NativeOutput $cmd @("--version")
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
                if ($owner -and $owner.CommandLine -and $owner.CommandLine.Contains($Root)) { $null = Get-NativeOutput "taskkill.exe" @("/PID", $recorded, "/T", "/F") }
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
$defaultInstallRoot = Join-Path $env:LOCALAPPDATA "SoulstreamServer"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = $defaultInstallRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
# Never take over a folder another program uses (the Soulstream desktop app lives in %LOCALAPPDATA%\Soulstream).
$marker = Join-Path $InstallRoot $INSTALL_MARKER
if ((Test-Path -LiteralPath $InstallRoot) -and -not (Test-Path -LiteralPath $marker) -and (Get-ChildItem -LiteralPath $InstallRoot -Force | Select-Object -First 1)) {
    throw "$InstallRoot is not empty and was not created by this installer. Choose another folder with -InstallRoot."
}
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
if (-not (Test-Path -LiteralPath $marker)) { Set-Content -LiteralPath $marker -Value "Soulstream server installed by install-windows.ps1" -Encoding ASCII }
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
if (-not (Test-CommandExists "gh")) {
    Write-Host "   Installing GitHub CLI..."
    try { Install-WithWinget "GitHub.cli" } catch { Write-Warn "GitHub CLI was not installed ($($_.Exception.Message)). Install it later with: winget install --id GitHub.cli" }
}
# npm, pnpm and codex also install .ps1 shims, which Restricted execution policy blocks; call the .cmd files.
function Get-NodeVersion { [version]((Get-NativeOutput "node.exe" @("--version")) -replace "v", "") }
$nodeOk = (Test-CommandExists "node.exe") -and ((Get-NodeVersion) -ge $MINIMUM_NODE_VERSION)
if (-not $nodeOk) { Write-Host "   Installing Node.js..."; Install-WithWinget "OpenJS.NodeJS.LTS" }
if (-not (Test-CommandExists "node.exe") -or ((Get-NodeVersion) -lt $MINIMUM_NODE_VERSION)) {
    throw "Node.js 22.5 or newer is required."
}
$pythonCmd = Find-Python
if ($null -eq $pythonCmd) { Write-Host "   Installing Python..."; Install-WithWinget "Python.Python.3.12"; $pythonCmd = Find-Python }
if ($null -eq $pythonCmd) { throw "Python 3.11 or newer is required." }
$pnpmVersion = if (Test-CommandExists "pnpm.cmd") { "$(Get-NativeOutput "pnpm.cmd" @("--version") | Select-Object -First 1)".Trim() } else { "" }
if (-not $pnpmVersion.StartsWith("10.")) {
    Write-Host "   Installing pnpm $PNPM_VERSION..."
    Invoke-Native "npm.cmd" @("install", "-g", "pnpm@$PNPM_VERSION")
    Update-SessionPath
    $pnpmVersion = "$(Get-NativeOutput "pnpm.cmd" @("--version") | Select-Object -First 1)".Trim()
}
Write-Ok "git, node $(Get-NativeOutput "node.exe" @("--version")), python, pnpm $pnpmVersion"

# ---- 3. PostgreSQL 17 ----
Write-Step "Preparing PostgreSQL 17"
$passwordFile = Join-Path $InstallRoot ".postgres-superuser-password"
$service = Get-Service -Name $PG_SERVICE -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Write-Host "   Installing PostgreSQL 17 (this takes a few minutes)..."
    $generated = -join ((1..24) | ForEach-Object { "{0:x}" -f (Get-Random -Maximum 16) })
    Set-Content -LiteralPath $passwordFile -Value $generated -Encoding ASCII
    $null = Get-NativeOutput "icacls.exe" @($passwordFile, "/inheritance:r", "/grant:r", "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):F")
    $override = "--mode unattended --unattendedmodeui minimal --superpassword $generated --serverport $PG_PORT --servicename $PG_SERVICE"
    # The EDB installer passes its %TEMP% paths to powershell.exe in the ANSI code page, so a profile folder with Korean
    # letters in its name turns into "???" and the install stops. winget and the installer it starts inherit this
    # process's TEMP and TMP, so they point at an ASCII folder for this one install.
    # Any user can add folders under %ProgramData%, so the folder gets an unguessable new name (an existing one is never
    # reused or deleted) and, before anything runs from it, an ACL that only Administrators, SYSTEM and this user can write.
    $random = New-Object byte[] 8
    $pgTemp = $null
    $createError = $null
    for ($attempt = 0; $attempt -lt 5 -and -not $pgTemp; $attempt++) {
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
        $candidate = Join-Path $env:ProgramData ("SoulstreamServer-postgres-" + (($random | ForEach-Object { $_.ToString("x2") }) -join ""))
        try { New-Item -ItemType Directory -Path $candidate -ErrorAction Stop | Out-Null; $pgTemp = $candidate } catch { $createError = $_.Exception.Message }
    }
    if (-not $pgTemp) { throw "Could not create a temporary folder for the PostgreSQL installer under $env:ProgramData ($createError)." }
    $savedTemp = $env:TEMP
    $savedTmp = $env:TMP
    try {
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $acl = @(Invoke-Native "icacls.exe" @($pgTemp, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*${me}:(OI)(CI)F"))
        $aclResult = $acl | Where-Object { "$_".Trim() } | Select-Object -Last 1
        Write-Host "   PostgreSQL installer temporary folder: $pgTemp (icacls: $aclResult)"
        # Until the ACL above was set, the inherited %ProgramData% ACL let other users add entries to the new folder.
        $planted = @(Get-ChildItem -LiteralPath $pgTemp -Force | ForEach-Object { $_.Name })
        if ($planted.Count -gt 0) { throw "The temporary folder $pgTemp was not empty after its ACL was set ($($planted -join ', ')). Run the installer again." }
        $env:TEMP = $pgTemp
        $env:TMP = $pgTemp
        Install-WithWinget "PostgreSQL.PostgreSQL.17" @("--override", $override)
    } finally {
        $env:TEMP = $savedTemp
        $env:TMP = $savedTmp
        $pgLog = Get-ChildItem -LiteralPath $pgTemp -Recurse -File -Include "install-postgresql.log", "bitrock_installer*.log", "installbuilder_installer*.log" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime | Select-Object -Last 1
        if ($pgLog) {
            Copy-Item -LiteralPath $pgLog.FullName -Destination (Join-Path $logsDir "postgresql-install.log") -Force
            Write-Host "   PostgreSQL installer log: $(Join-Path $logsDir "postgresql-install.log")"
        }
        # rmdir /s removes a junction itself instead of following it into its target.
        $removeError = $null
        try { Invoke-Native "cmd.exe" @("/d", "/c", "rmdir", "/s", "/q", $pgTemp) } catch { $removeError = $_.Exception.Message }
        if (Test-Path -LiteralPath $pgTemp) { Write-Warning "Could not remove the PostgreSQL installer temporary folder $pgTemp ($removeError). You can delete it later." }
    }
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
    $null = Get-NativeOutput (Join-Path $pgBin "pg_isready.exe") @("-h", "127.0.0.1", "-p", "$PG_PORT")
    if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 2 }
}
if (-not $ready) { throw "PostgreSQL does not accept connections on 127.0.0.1:$PG_PORT." }
$answer = Get-NativeOutput (Join-Path $pgBin "psql.exe") @("-h", "127.0.0.1", "-p", "$PG_PORT", "-U", "postgres", "-d", "postgres", "-tAc", "SELECT 1")
if ("$answer".Trim() -ne "1") { throw "Could not sign in to PostgreSQL as postgres. Check -PostgresPassword." }
Remove-Item Env:\PGPASSWORD
Write-Ok "PostgreSQL 17 is running on 127.0.0.1:$PG_PORT."

# ---- 4. coding agent CLIs ----
Write-Step "Checking coding agent CLIs"
# The official Claude installer puts claude.exe here without adding it to PATH; the worker looks here too.
$claudeLocal = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
try {
    if ($requestedBackends -contains "claude" -and -not (Test-CommandExists "claude") -and -not (Test-Path -LiteralPath $claudeLocal)) {
        Write-Host "   Installing Claude Code..."
        # The official installer runs in its own scope with the default preference, as it would from a plain prompt.
        & { $ErrorActionPreference = "Continue"; Invoke-RestMethod -UseBasicParsing "https://claude.ai/install.ps1" | Invoke-Expression }
        Update-SessionPath
    }
    if ($requestedBackends -contains "codex" -and -not (Test-CommandExists "codex.cmd")) {
        Write-Host "   Installing Codex CLI..."
        Invoke-Native "npm.cmd" @("install", "-g", "@openai/codex")
        Update-SessionPath
    }
} catch {
    Write-Warn "A coding agent CLI could not be installed: $($_.Exception.Message)"
}

# ---- 5. sources ----
Write-Step "Fetching sources"
function Sync-Repository {
    param([string]$Url, [string]$Directory, [string]$Revision)
    if (Test-Path (Join-Path $Directory ".git")) {
        $dirty = Get-NativeOutput "git" @("-C", $Directory, "status", "--porcelain", "--untracked-files=no")
        if ($dirty) { throw "$Directory has local changes. Commit or discard them, then run this script again." }
    } else {
        Invoke-Native "git" @("clone", "--no-checkout", $Url, $Directory)
    }
    Invoke-Native "git" @("-C", $Directory, "fetch", "--tags", "origin", $Revision)
    Invoke-Native "git" @("-C", $Directory, "checkout", "--force", "--detach", "FETCH_HEAD")
}
Sync-Repository -Url $RepositoryUrl -Directory $soulDir -Revision $Ref
Sync-Repository -Url $AtomRepositoryUrl -Directory $atomDir -Revision $AtomRef
Write-Ok "soulstream $(Get-NativeOutput "git" @("-C", $soulDir, "rev-parse", "--short=12", "HEAD")), atom $(Get-NativeOutput "git" @("-C", $atomDir, "rev-parse", "--short=12", "HEAD"))"

# ---- 6. set up and build (Node) ----
$setup = Join-Path $soulDir "install\windows\setup.mjs"
$common = @("--install-root", $InstallRoot, "--worker-port", "$WorkerPort", "--backends", ($requestedBackends -join ","), "--pg-bin", $pgBin)
$prepare = @($setup, "prepare") + $common
if ($AdminPasswordFile) { $prepare += @("--admin-password-file", (Resolve-Path -LiteralPath $AdminPasswordFile).Path) }
Invoke-Native "node" $prepare
Remove-Item Env:\SOULSTREAM_PG_PASSWORD

# ---- 7. Haniel in its own virtual environment ----
Write-Step "Installing Haniel"
$env:PYTHONUTF8 = "1"
if (-not (Test-Path (Join-Path $venvDir "Scripts\python.exe"))) { Invoke-Native $pythonCmd @("-m", "venv", $venvDir) }
Invoke-Native (Join-Path $venvDir "Scripts\python.exe") @("-m", "pip", "install", "--disable-pip-version-check", "git+https://github.com/eiaserinnys/haniel.git@$HANIEL_COMMIT")
Invoke-Native "node" (@($setup, "haniel-config") + $common)

# ---- 8. logon task ----
Write-Step "Registering the logon task"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$hanielYaml = Join-Path $InstallRoot "haniel.yaml"
$runner = Join-Path $InstallRoot "run-haniel.ps1"
$runnerPython = ConvertTo-SingleQuoted $venvPython
$runnerYaml = ConvertTo-SingleQuoted "`"$hanielYaml`""
$runnerRoot = ConvertTo-SingleQuoted $InstallRoot
$runnerOut = ConvertTo-SingleQuoted (Join-Path $logsDir "haniel.out.log")
$runnerErr = ConvertTo-SingleQuoted (Join-Path $logsDir "haniel.err.log")
$runnerPid = ConvertTo-SingleQuoted (Join-Path $InstallRoot "haniel.pid")
# The runner is UTF-16 with a byte order mark so Windows PowerShell 5.1 reads non-ASCII paths (a profile folder with
# Korean letters); its UTF8 is written without one by PowerShell 7 and read as the ANSI code page by 5.1.
# PYTHONUTF8: Haniel decodes the services' UTF-8 output with the locale code page (cp949 on Korean Windows), and its
# log reader stops at the first line it cannot decode. In UTF-8 mode Haniel also decodes netstat and taskkill output
# as UTF-8; only the "ready: port:" and self-update paths call those, and haniel.yaml here uses "ready: http:".
@"
`$ErrorActionPreference = 'Stop'
`$env:PYTHONUTF8 = '1'
`$process = Start-Process -FilePath $runnerPython -ArgumentList @('-m', 'haniel', 'run', $runnerYaml) -WorkingDirectory $runnerRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $runnerOut -RedirectStandardError $runnerErr
Set-Content -LiteralPath $runnerPid -Value `$process.Id -Encoding ASCII
`$process.WaitForExit()
"@ | Set-Content -LiteralPath $runner -Encoding Unicode
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
if ($started) {
    Write-Ok "Task '$TASK_NAME' registered; Haniel was started by the logon task."
} else {
    Write-Warn "The logon task did not start Haniel within $i seconds in this session (task state: $((Get-ScheduledTask -TaskName $TASK_NAME).State))."
    $direct = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$runner`"") -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath (Join-Path $InstallRoot "runner.pid") -Value $direct.Id -Encoding ASCII
    Write-Ok "Task '$TASK_NAME' registered; Haniel was started directly (PID $($direct.Id)) and the task starts it at your next logon."
}

# ---- 9. wait and finish (Node) ----
Invoke-Native "node" (@($setup, "finish") + $common)
$uninstallArguments = if ($InstallRoot -eq $defaultInstallRoot) { "" } else { " -InstallRoot $(ConvertTo-SingleQuoted $InstallRoot)" }
Write-Host ""
Write-Host "To remove it, run in an elevated PowerShell:" -ForegroundColor DarkGray
Write-Host "  & ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/uninstall-windows.ps1')))$uninstallArguments" -ForegroundColor DarkGray
