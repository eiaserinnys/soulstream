# Soulstream Standalone Installer
#
# Usage:
#   irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1 | iex
#
# What this does:
#   1. Checks prerequisites (Python 3.11+, Node.js 18+)
#   2. Installs Claude Code CLI if missing
#   3. Installs Haniel if missing
#   4. Installs pnpm if missing
#   5. Prompts for install path, workspace path, and port
#   6. Generates a haniel.yaml from the template
#   7. Runs haniel install (clones repo, creates venv, sets up .env)
#   8. Starts the service
#   9. Builds the dashboard

param(
    [string]$InstallDir      = "",
    [string]$WorkspaceDir    = "",
    [int]$Port               = 0,
    [switch]$Force,
    [switch]$NonInteractive,
    [switch]$SkipDashboard
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = "Stop"

$TEMPLATE_URL = "https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/haniel-standalone.yaml.template"
$HANIEL_INSTALL_URL = "https://raw.githubusercontent.com/eiaserinnys/haniel/main/install-haniel.ps1"

# ── helpers ──────────────────────────────────────────────────────────────────

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "  $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  ✅ $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  ⚠️  $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  ❌ $Message" -ForegroundColor Red
}

function Test-CommandExists {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Read-HostWithDefault {
    param([string]$Prompt, [string]$Default)
    $response = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($response)) { $Default } else { $response }
}

function Test-PortOpen {
    param([int]$Port)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $Port)
        $tcp.Close()
        return $true
    } catch {
        return $false
    }
}

function Find-FreePort {
    param([int]$StartPort)
    $port = $StartPort
    while ($port -le 65535) {
        if (-not (Test-PortOpen $port)) { return $port }
        $port++
    }
    throw "No free port found starting from $StartPort"
}

# ── banner ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       Soulstream Standalone Installer    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── step 1: prerequisites ─────────────────────────────────────────────────────

Write-Step "Checking prerequisites..."

# Python 3.11+
$pythonCmd = $null
foreach ($cmd in @("py", "python", "python3")) {
    if (Test-CommandExists $cmd) {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python (\d+)\.(\d+)") {
            $major = [int]$Matches[1]; $minor = [int]$Matches[2]
            if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 11)) {
                $pythonCmd = $cmd
                break
            }
        }
    }
}

if ($null -eq $pythonCmd) {
    Write-Fail "Python 3.11+ is required but not found."
    Write-Host "    Download: https://www.python.org/downloads/" -ForegroundColor DarkGray
    Write-Host "    Tip: Use the Microsoft Store version or the official installer." -ForegroundColor DarkGray
    exit 1
}
Write-Ok "Python found ($((& $pythonCmd --version 2>&1)))"

# Node.js 18+
if (-not (Test-CommandExists "node")) {
    Write-Fail "Node.js 18+ is required but not found."
    Write-Host "    Download: https://nodejs.org/" -ForegroundColor DarkGray
    exit 1
}
$nodeVer = (node --version) -replace "v", ""
$nodeMajor = [int]($nodeVer -split "\.")[0]
if ($nodeMajor -lt 18) {
    Write-Fail "Node.js 18+ required, found v$nodeVer."
    Write-Host "    Download: https://nodejs.org/" -ForegroundColor DarkGray
    exit 1
}
Write-Ok "Node.js found (v$nodeVer)"

# ── step 2: Claude Code ───────────────────────────────────────────────────────

Write-Step "Checking Claude Code CLI..."

if (-not (Test-CommandExists "claude")) {
    Write-Warn "Claude Code not found. Installing..."
    npm install -g @anthropic-ai/claude-code
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Claude Code installation failed."
        exit 1
    }
    Write-Ok "Claude Code installed."
} else {
    Write-Ok "Claude Code found."
}

# ── step 3: Haniel ────────────────────────────────────────────────────────────

Write-Step "Checking Haniel process manager..."

if (-not (Test-CommandExists "haniel")) {
    if ($NonInteractive) {
        # CI: install haniel as a CLI tool only — the full install-haniel.ps1 bootstrapper
        # requires interactive prompts (service account password, config URL) that cannot
        # be automated. We only need the haniel binary to run `haniel install`.
        Write-Warn "Haniel not found. Installing via pip (non-interactive)..."
        pip install git+https://github.com/eiaserinnys/haniel.git
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "Haniel pip install failed."
            exit 1
        }
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("PATH", "User") + ";" +
                    (python -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>$null)
    } else {
        Write-Warn "Haniel not found. Installing..."
        Invoke-RestMethod $HANIEL_INSTALL_URL | Invoke-Expression
        # Refresh PATH so haniel is available in this session
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("PATH", "User")
    }
    if (-not (Test-CommandExists "haniel")) {
        Write-Fail "Haniel installation failed. Please install manually:"
        Write-Host "    irm $HANIEL_INSTALL_URL | iex" -ForegroundColor DarkGray
        exit 1
    }
    Write-Ok "Haniel installed."
} else {
    Write-Ok "Haniel found."
}

# ── step 3.5: pnpm ───────────────────────────────────────────────────────────

Write-Step "Checking pnpm..."

if (-not (Test-CommandExists "pnpm")) {
    Write-Warn "pnpm not found. Installing..."
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "pnpm installation failed."
        exit 1
    }
    Write-Ok "pnpm installed."
} else {
    Write-Ok "pnpm found."
}

# ── step 4: user input ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ─── Installation Settings ───" -ForegroundColor DarkCyan
Write-Host ""

$defaultInstallDir = Join-Path $env:USERPROFILE "soulstream"
$defaultWorkspace  = Join-Path $env:USERPROFILE "workspace"

if ($NonInteractive) {
    $installDir   = if ($InstallDir)   { $InstallDir }   else { $defaultInstallDir }
    $workspaceDir = if ($WorkspaceDir) { $WorkspaceDir } else { $defaultWorkspace }
} else {
    $installDir   = Read-HostWithDefault "  Install path  " $defaultInstallDir
    $workspaceDir = Read-HostWithDefault "  Workspace path" $defaultWorkspace
}

# Port selection with conflict detection
$defaultPort = if ($Port -gt 0) { $Port } else { 3105 }
$portInUse = Test-PortOpen $defaultPort
if ($portInUse) {
    $suggestedPort = Find-FreePort -StartPort ($defaultPort + 1)
    Write-Warn "Port $defaultPort is already in use."
    if ($NonInteractive) {
        $port = $suggestedPort
        Write-Ok "Auto-selected port $port."
    } else {
        $useAlt = Read-Host "  Use port $suggestedPort instead? [Y/n]"
        if ($useAlt -eq "" -or $useAlt -match "^[Yy]") {
            $port = $suggestedPort
            Write-Ok "Using port $port."
        } else {
            $portInput = Read-Host "  Enter port number"
            $port = [int]$portInput
        }
    }
} else {
    $port = $defaultPort
}

Write-Host ""
Write-Host "  Install path : $installDir" -ForegroundColor DarkGray
Write-Host "  Workspace    : $workspaceDir" -ForegroundColor DarkGray
Write-Host "  Port         : $port" -ForegroundColor DarkGray
Write-Host ""

# ── step 5: existing install detection ───────────────────────────────────────

$soulstreamDir = Join-Path $installDir "soulstream"
if (Test-Path $soulstreamDir) {
    if ($Force -or $NonInteractive) {
        Write-Warn "Existing installation found at $soulstreamDir — overwriting (Force/NonInteractive)."
    } else {
        Write-Warn "Existing installation found at $soulstreamDir"
        $reinstall = Read-Host "  Reinstall? This will overwrite existing files. [y/N]"
        if ($reinstall -notmatch "^[Yy]") {
            Write-Host "  Aborted." -ForegroundColor DarkGray
            exit 0
        }
    }
}

# Create install directory
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# ── step 6: generate haniel.yaml from template ───────────────────────────────

Write-Step "Generating haniel.yaml..."

# Prefer local template (CI checkout) — fall back to remote URL (irm | iex usage)
$localTemplate = Join-Path $PSScriptRoot "haniel-standalone.yaml.template"
if (Test-Path $localTemplate) {
    $template = Get-Content $localTemplate -Raw
    Write-Host "    Using local template: $localTemplate" -ForegroundColor DarkGray
} else {
    $template = Invoke-RestMethod $TEMPLATE_URL
}

# Normalize paths to forward slashes (Haniel / Python work fine with them on Windows)
$installDirFwd  = $installDir  -replace "\\", "/"
$workspaceDirFwd = $workspaceDir -replace "\\", "/"

$hanielYaml = $template `
    -replace "__INSTALL_DIR__",   $installDirFwd `
    -replace "__WORKSPACE_DIR__", $workspaceDirFwd `
    -replace "__PORT__",          $port

$hanielYamlPath = Join-Path $installDir "haniel.yaml"
[System.IO.File]::WriteAllText($hanielYamlPath, $hanielYaml, [System.Text.UTF8Encoding]::new($false))
Write-Ok "haniel.yaml written to $hanielYamlPath"

# ── step 7: haniel install ───────────────────────────────────────────────────

Write-Step "Running haniel install (this may take a few minutes)..."
Write-Host "    Haniel will clone soulstream, create a Python venv, and" -ForegroundColor DarkGray
Write-Host "    prompt you for .env settings (node ID, auth token, etc.)" -ForegroundColor DarkGray
Write-Host ""

# Ensure Python subprocesses use UTF-8 stdout (haniel prints unicode checkmarks)
$env:PYTHONUTF8 = "1"

$hanielArgs = @($hanielYamlPath)
if ($NonInteractive) { $hanielArgs += "--skip-interactive" }
haniel install @hanielArgs
if ($LASTEXITCODE -ne 0) {
    Write-Fail "haniel install failed (exit code: $LASTEXITCODE)."
    Write-Host "    Check the output above for details." -ForegroundColor DarkGray
    Write-Host "    You can retry with: haniel install $hanielYamlPath" -ForegroundColor DarkGray
    exit 1
}
Write-Ok "haniel install completed."

# ── step 7.5: start service ───────────────────────────────────────────────────

Write-Step "Starting Soulstream service..."

sc.exe start soulstream 2>$null
if ($LASTEXITCODE -ne 0) {
    # Service may not be registered as Windows service — try haniel run in background
    Write-Warn "Windows service not found. Starting with haniel run..."
    $hanielLogPath = Join-Path $installDir "logs\haniel-run.log"
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "logs") | Out-Null
    $env:PYTHONUTF8 = "1"
    Start-Process -FilePath "haniel" -ArgumentList "run", $hanielYamlPath `
        -RedirectStandardOutput $hanielLogPath `
        -RedirectStandardError "$hanielLogPath.err" `
        -NoNewWindow
    Write-Host "    Waiting for service to start... (log: $hanielLogPath)" -ForegroundColor DarkGray
    $maxWait = 60
    $elapsed = 0
    $running = $false
    while ($elapsed -lt $maxWait) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        if (Test-PortOpen $port) {
            $running = $true
            break
        }
    }
    if (-not $running) {
        Write-Warn "Service did not respond within ${maxWait}s. Check: haniel status $hanielYamlPath"
    } else {
        Write-Ok "Service is up on port $port."
    }
} else {
    Write-Ok "Soulstream Windows service started."
}

# ── step 8: dashboard build ───────────────────────────────────────────────────

Write-Step "Building dashboard..."

$monoRepoDir  = Join-Path $installDir "soulstream"
$dashboardDir = Join-Path $monoRepoDir "unified-dashboard"

if ($SkipDashboard) {
    Write-Warn "Dashboard build skipped (-SkipDashboard)."
} elseif (-not (Test-Path $dashboardDir)) {
    Write-Warn "Dashboard directory not found at $dashboardDir — skipping build."
} else {
    Write-Host "    Installing Node.js dependencies..." -ForegroundColor DarkGray
    pnpm --dir $monoRepoDir install
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "pnpm install failed."
        exit 1
    }

    Write-Host "    Building (this may take a minute)..." -ForegroundColor DarkGray
    pnpm --dir $dashboardDir build
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Dashboard build failed."
        exit 1
    }
    Write-Ok "Dashboard built."
}

# ── step 9: done ─────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║          ✅  Installation Complete!       ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Soulstream is running at:" -ForegroundColor White
Write-Host "    http://localhost:$port" -ForegroundColor Cyan
Write-Host "    http://localhost:$port/docs  (API docs)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Service management:" -ForegroundColor White
Write-Host "    sc start soulstream     start service" -ForegroundColor DarkGray
Write-Host "    sc stop  soulstream     stop service" -ForegroundColor DarkGray
Write-Host "    haniel status $hanielYamlPath" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Config: $hanielYamlPath" -ForegroundColor DarkGray
Write-Host "  Logs  : $installDir\logs\" -ForegroundColor DarkGray
Write-Host ""
