@echo off
setlocal

set "PROJECT_ROOT=%~dp0"

echo Starting BuildDesk API on http://127.0.0.1:8000 ...
start "BuildDesk API" /D "%PROJECT_ROOT%" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%start-backend.ps1"

echo Starting BuildDesk UI on http://127.0.0.1:5173 ...
start "BuildDesk UI" /D "%PROJECT_ROOT%" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%start-frontend.ps1"

echo Waiting for the UI to become reachable (first run installs dependencies)...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(240); while ((Get-Date) -lt $deadline) { try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2; Start-Process 'http://127.0.0.1:5173/'; exit 0 } catch { Start-Sleep -Seconds 2 } }; Write-Host 'UI did not respond in time. Open http://127.0.0.1:5173/ manually once the install finishes.'"

endlocal
