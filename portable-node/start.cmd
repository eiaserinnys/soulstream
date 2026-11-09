@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%bootstrap.ps1" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
