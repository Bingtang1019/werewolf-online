@echo off
title Werewolf - Public Tunnel
cd /d %~dp0

set CF=%~dp0cloudflared.exe
set NODE=%~dp0node.exe
if not exist "%NODE%" set "NODE=C:\Program Files\nodejs\node.exe"

if not exist "%CF%" (
  echo [ERROR] cloudflared.exe not found in this folder.
  pause
  exit /b
)

rem ---- Ensure game server is running ----
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri 'http://localhost:3000/healthz' -TimeoutSec 2 -UseBasicParsing; exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Starting game server...
  start "Werewolf Server" "%~dp0server-loop.bat"
  timeout /t 3 /nobreak >nul
)

rem ---- Clean stale instances ----
taskkill /F /IM cloudflared.exe >nul 2>&1

echo ==============================================
echo   Werewolf Online - Public Tunnel
echo   Server: http://localhost:3000
echo ==============================================
echo.
echo   Waiting for URL... (Ctrl+C to stop)
echo.

rem ---- Run cloudflared in foreground (URL appears in output) ----
"%CF%" tunnel --url http://localhost:3000 --protocol http2 --no-autoupdate

echo.
echo   Tunnel closed.
pause
