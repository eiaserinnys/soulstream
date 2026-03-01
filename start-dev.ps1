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
}

$jobs = @()

try {
    if ($Server) {
        Write-Host "[Soul Server] Starting on :3105 ..." -ForegroundColor Cyan
        $serverJob = Start-Process -FilePath $VenvPython `
            -ArgumentList "-m", "soul_server.main" `
            -WorkingDirectory $ServerDir `
            -PassThru
        $jobs += $serverJob
        Write-Host "[Soul Server] PID: $($serverJob.Id)" -ForegroundColor DarkGray
    }

    if ($Dashboard) {
        Write-Host "[Soul Dashboard] Starting on :3109 ..." -ForegroundColor Magenta
        $dashboardJob = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", "npm run dev" `
            -WorkingDirectory $DashboardDir `
            -PassThru
        $jobs += $dashboardJob
        Write-Host "[Soul Dashboard] PID: $($dashboardJob.Id)" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "=== Soulstream Dev ===" -ForegroundColor Green
    if ($Server)    { Write-Host "  Soul Server:    http://localhost:3105" -ForegroundColor Cyan }
    if ($Server)    { Write-Host "  API Docs:       http://localhost:3105/docs" -ForegroundColor Cyan }
    if ($Dashboard) { Write-Host "  Dashboard:      http://localhost:3109" -ForegroundColor Magenta }
    Write-Host ""
    Write-Host "Press Ctrl+C to stop all processes." -ForegroundColor Yellow
    Write-Host ""

    while ($true) {
        $alive = $jobs | Where-Object { -not $_.HasExited }
        if ($alive.Count -eq 0) {
            Write-Host "[INFO] All processes exited." -ForegroundColor Yellow
            break
        }
        Start-Sleep -Seconds 2
    }
}
finally {
    Write-Host ""
    Write-Host "[Cleanup] Stopping processes..." -ForegroundColor Yellow
    foreach ($job in $jobs) {
        if (-not $job.HasExited) {
            Write-Host "  Stopping PID $($job.Id)..." -ForegroundColor DarkGray
            Stop-Process -Id $job.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "[Done] All processes stopped." -ForegroundColor Green
}
