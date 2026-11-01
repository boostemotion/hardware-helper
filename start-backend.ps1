$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $projectRoot "backend")

try {
  if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Creating Python venv and installing requirements (first run)..."
    python -m venv .venv
    .\.venv\Scripts\pip.exe install -r requirements.txt
  }
  & .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
}
catch {
  Write-Host ""
  Write-Host "BuildDesk API failed to start: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "If port 8000 is already in use, close the other process and try again."
  Write-Host "Press Enter to close this window..."
  [void](Read-Host)
}
