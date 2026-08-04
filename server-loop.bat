@echo off
title Werewolf Server (auto-restart)
cd /d %~dp0

rem Auto-detect node.exe: use local copy if present, otherwise common locations
set NODE=%~dp0node.exe
if not exist "%NODE%" set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" (
  echo [ERROR] node.exe not found.
  echo Please copy node.exe into this folder, or install Node.js.
  pause
  exit /b
)

:loop
"%NODE%" server.js
echo [WARN] Server exited. Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
rem If another server is already listening, stop this loop
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri 'http://localhost:3000/healthz' -TimeoutSec 2 -UseBasicParsing; exit 0}catch{exit 1}"
if not errorlevel 1 exit /b 0
goto loop
