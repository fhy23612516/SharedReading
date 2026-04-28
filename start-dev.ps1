$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "[DEV] starting backend in watch mode on http://127.0.0.1:3210"
Write-Host "[DEV] server.js changes will auto-restart the backend"
Write-Host "[DEV] press Ctrl+C to stop"
Write-Host ""

npm.cmd run dev
