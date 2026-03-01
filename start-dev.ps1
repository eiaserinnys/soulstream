param(
    [switch]$Server,
    [switch]$Dashboard
)

# Soulstream Dev Launcher
# Soul Server (:3105) + Soul Dashboard (:3109)
# Usage:
#   .\start-dev.ps1           -> both
#   .\start-dev.ps1 -Server   -> server only
#   .\start-dev.ps1 -Dashboard -> dashboard only

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = "Stop"

if (-not $Server -and -not $Dashboard) {
    $Server = $true
    $Dashboard = $true
}

$Root = $PSScriptRoot
$ServerDir = Join-Path $Root "soul-server"
$DashboardDir = Join-Path $Root "soul-dashboard"
$VenvPython = Join-Path $ServerDir ".venv\Scripts\python.exe"

# Validation
if ($Server) {
    if (-not (Test-Path $VenvPython)) {
        Write-Host "[ERROR] Python venv not found: $VenvPython" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path (Join-Path $ServerDir ".env"))) {
        Write-Host "[ERROR] .env not found in $ServerDir" -ForegroundColor Red
        exit 1
    }
}

if ($Dashboard) {
    if (-not (Test-Path (Join-Path $DashboardDir "node_modules"))) {
        Write-Host "[ERROR] node_modules not found. Run: cd $DashboardDir && npm install" -ForegroundColor Red
        exit 1
    }

    # 클라이언트 빌드 (Express 서버가 dist/client/를 정적 서빙하므로 빌드 필수)
    Write-Host "[Soul Dashboard] Building client..." -ForegroundColor Magenta
    Push-Location $DashboardDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Dashboard client build failed (exit code: $LASTEXITCODE)" -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Host "[Soul Dashboard] Build complete." -ForegroundColor Magenta
}

# PID와 그 자식 프로세스를 모두 종료하는 헬퍼
function Stop-ProcessTree {
    param([int]$Pid)
    # 자식 프로세스 먼저 재귀적으로 종료
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$Pid" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-ProcessTree -Pid $_.ProcessId }
    Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
}

$procIds = @()

if ($Server) {
    Write-Host "[Soul Server] Starting on :3105 ..." -ForegroundColor Cyan
    $serverProc = Start-Process -FilePath $VenvPython `
        -ArgumentList "-m", "soul_server.main" `
        -WorkingDirectory $ServerDir `
        -PassThru
    $procIds += $serverProc.Id
    Write-Host "  PID: $($serverProc.Id)" -ForegroundColor DarkGray
}

if ($Dashboard) {
    Write-Host "[Soul Dashboard] Starting on :3109 ..." -ForegroundColor Magenta
    $dashProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm run dev" `
        -WorkingDirectory $DashboardDir `
        -PassThru
    $procIds += $dashProc.Id
    Write-Host "  PID: $($dashProc.Id)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Soulstream Dev ===" -ForegroundColor Green
if ($Server)    { Write-Host "  Soul Server:    http://localhost:3105" -ForegroundColor Cyan }
if ($Server)    { Write-Host "  API Docs:       http://localhost:3105/docs" -ForegroundColor Cyan }
if ($Dashboard) { Write-Host "  Dashboard:      http://localhost:3109" -ForegroundColor Magenta }
Write-Host ""
Write-Host "Press Enter to stop all processes." -ForegroundColor Yellow
Write-Host ""

Read-Host

Write-Host "[Cleanup] Stopping processes..." -ForegroundColor Yellow
foreach ($p in $procIds) {
    Write-Host "  Killing PID $p (+ children) ..." -ForegroundColor DarkGray
    Stop-ProcessTree -Pid $p
}
Write-Host "[Done] All processes stopped." -ForegroundColor Green
