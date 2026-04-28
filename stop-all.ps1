$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $root ".runtime"
$pidFile = Join-Path $runtimeDir "processes.json"

function Write-Step($text) {
  Write-Host ("[STOP] {0}" -f $text)
}

function Stop-ById($targetPid, $label) {
  if (-not $targetPid) { return }
  $process = Get-Process -Id $targetPid
  if ($process) {
    Stop-Process -Id $targetPid -Force
    Write-Step ("stopped {0} (PID {1})" -f $label, $targetPid)
  } else {
    Write-Step ("{0} (PID {1}) is already not running" -f $label, $targetPid)
  }
}

function Stop-ByPort($port, $label) {
  $lines = netstat -ano | Select-String (":{0}\s" -f $port)
  foreach ($line in $lines) {
    $text = ($line.ToString() -replace "\s+", " ").Trim()
    $parts = $text.Split(" ")
    if ($parts.Length -ge 5) {
      $targetPid = $parts[$parts.Length - 1]
      if ($targetPid -match "^\d+$") {
        Stop-ById ([int]$targetPid) $label
      }
    }
  }
}

if (Test-Path $pidFile) {
  $meta = Get-Content -Path $pidFile -Raw | ConvertFrom-Json
  Write-Step "reading runtime metadata"
  Stop-ById $meta.nodePid "node server"
  Stop-ById $meta.frontendPid "frontend server"
  Stop-ById $meta.ngrokPid "ngrok"
  Remove-Item $pidFile -Force
  Write-Step "removed runtime metadata"
  if ($meta.nodeStdoutLog) {
    Write-Step ("node stdout log: {0}" -f $meta.nodeStdoutLog)
  }
  if ($meta.nodeStderrLog) {
    Write-Step ("node stderr log: {0}" -f $meta.nodeStderrLog)
  }
  if ($meta.frontendStdoutLog) {
    Write-Step ("frontend stdout log: {0}" -f $meta.frontendStdoutLog)
  }
  if ($meta.frontendStderrLog) {
    Write-Step ("frontend stderr log: {0}" -f $meta.frontendStderrLog)
  }
  Write-Host "Shutdown completed."
} else {
  Write-Step "no runtime metadata found"
  Write-Step "trying fallback cleanup for local frontend/backend services only"
  Stop-ByPort 3210 "node server on 3210"
  Stop-ByPort 3211 "frontend server on 3211"
  Write-Host "Fallback cleanup completed."
}
