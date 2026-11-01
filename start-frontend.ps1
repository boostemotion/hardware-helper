$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $projectRoot "frontend")

try {
  if (-not (Test-Path "node_modules")) {
    Write-Host "Installing frontend dependencies (first run may take a few minutes)..."
    npm install
  }
  npm run dev -- --host 127.0.0.1
}
catch {
  Write-Host ""
  Write-Host "BuildDesk UI failed to start: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "If port 5173 is already in use, close the other process and try again."
  Write-Host "Press Enter to close this window..."
  [void](Read-Host)
}
