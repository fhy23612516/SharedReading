$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$runtimeDir = Join-Path $root ".runtime"
$pidFile = Join-Path $runtimeDir "processes.json"
$backendPort = 3210
$frontendPort = 3211
$nodeOutLog = Join-Path $runtimeDir "node.stdout.log"
$nodeErrLog = Join-Path $runtimeDir "node.stderr.log"
$frontendOutLog = Join-Path $runtimeDir "frontend.stdout.log"
$frontendErrLog = Join-Path $runtimeDir "frontend.stderr.log"

function Write-Step($text) {
  Write-Host ("[START] {0}" -f $text)
}

function Resolve-Ngrok {
  $ngrokCommand = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($ngrokCommand) {
    return $ngrokCommand.Source
  }

  $fallbackNgrok = "D:\Program Files\ngrok.exe"
  if (Test-Path $fallbackNgrok) {
    return $fallbackNgrok
  }

  throw "ngrok was not found in PATH, and fallback path D:\Program Files\ngrok.exe does not exist."
}

if (-not (Test-Path $runtimeDir)) {
  New-Item -ItemType Directory -Path $runtimeDir | Out-Null
}

if (Test-Path $pidFile) {
  Write-Step "found previous runtime metadata, stopping old processes first"
  & (Join-Path $root "stop-all.ps1")
  Start-Sleep -Seconds 1
}

Remove-Item $nodeOutLog, $nodeErrLog, $frontendOutLog, $frontendErrLog -Force -ErrorAction SilentlyContinue
$ngrokExe = Resolve-Ngrok

Write-Step "starting backend on port $backendPort"
$nodeProcess = Start-Process `
  -FilePath "node" `
  -ArgumentList "server.js" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $nodeOutLog `
  -RedirectStandardError $nodeErrLog `
  -PassThru

Write-Step "starting frontend on port $frontendPort"
$frontendProcess = Start-Process `
  -FilePath "node" `
  -ArgumentList "frontend.server.js" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $frontendOutLog `
  -RedirectStandardError $frontendErrLog `
  -PassThru

Start-Sleep -Seconds 2

try {
  $null = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/bootstrap" -f $backendPort) -TimeoutSec 5
  $null = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/app-config.js" -f $frontendPort) -TimeoutSec 5
  Write-Step "backend and frontend are healthy"
} catch {
  if ($nodeProcess -and -not $nodeProcess.HasExited) {
    Stop-Process -Id $nodeProcess.Id -Force
  }
  if ($frontendProcess -and -not $frontendProcess.HasExited) {
    Stop-Process -Id $frontendProcess.Id -Force
  }
  throw "Local frontend/backend failed to start."
}

$payload = [ordered]@{
  startedAt = (Get-Date).ToString("s")
  backendPort = $backendPort
  frontendPort = $frontendPort
  nodePid = $nodeProcess.Id
  frontendPid = $frontendProcess.Id
  ngrokPid = $null
  backendUrl = "http://127.0.0.1:$backendPort"
  localUrl = "http://127.0.0.1:$frontendPort"
  nodeStdoutLog = $nodeOutLog
  nodeStderrLog = $nodeErrLog
  frontendStdoutLog = $frontendOutLog
  frontendStderrLog = $frontendErrLog
  tunnels = @()
}

$payload | ConvertTo-Json -Depth 5 | Set-Content -Path $pidFile -Encoding UTF8

Write-Host ""
Write-Host "SharedReading startup prepared."
Write-Host ("Frontend    : http://127.0.0.1:{0}" -f $frontendPort)
Write-Host ("Backend     : http://127.0.0.1:{0}" -f $backendPort)
Write-Host ("Backend PID : {0}" -f $nodeProcess.Id)
Write-Host ("Frontend PID: {0}" -f $frontendProcess.Id)
Write-Host ("ngrok exe   : {0}" -f $ngrokExe)
Write-Host ("ngrok cmd   : {0} http {1} --log stdout --inspect=false" -f $ngrokExe, $frontendPort)
Write-Host ("Backend out : {0}" -f $nodeOutLog)
Write-Host ("Backend err : {0}" -f $nodeErrLog)
Write-Host ("Frontend out: {0}" -f $frontendOutLog)
Write-Host ("Frontend err: {0}" -f $frontendErrLog)
Write-Host ""
Write-Host "ngrok is starting below for this project only: 3211"
Write-Host "The public URL will be printed by ngrok itself in this window."
Write-Host "There is no extra node window, and http inspect is disabled."
Write-Host "Press Ctrl+C to stop this window only. Run stop-all.bat if you want to stop frontend/backend in background."
Write-Host ""

$ngrokProcess = Start-Process `
  -FilePath $ngrokExe `
  -ArgumentList @("http", "$frontendPort", "--log", "stdout", "--inspect=false") `
  -WorkingDirectory $root `
  -NoNewWindow `
  -PassThru

$payload.ngrokPid = $ngrokProcess.Id
$payload | ConvertTo-Json -Depth 5 | Set-Content -Path $pidFile -Encoding UTF8

Wait-Process -Id $ngrokProcess.Id
