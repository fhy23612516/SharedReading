@echo off
title SharedReading Stop
powershell -NoLogo -ExecutionPolicy Bypass -NoExit -File "%~dp0stop-all.ps1"
