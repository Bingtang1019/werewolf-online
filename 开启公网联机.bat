@echo off
title Werewolf - Public Tunnel (auto-restart)
cd /d %~dp0

rem Auto-detect node.exe
set NODE=%~dp0node.exe
if not exist "%NODE%" set "NODE=C:\Program Files\nodejs\node.exe"
set CF=%~dp0cloudflared.exe

if not exist "%CF%" (
  echo [ERROR] cloudflared.exe not found.
  echo Please copy cloudflared.exe into this folder.
  pause
  exit /b
)
if not exist "%NODE%" (
  echo [ERROR] node.exe not found.
  echo Please copy node.exe into this folder or install Node.js.
  pause
  exit /b
)

rem ---- Start game server if not running (auto-restart loop in server-loop.bat) ----
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri 'http://localhost:3000/healthz' -TimeoutSec 2 -UseBasicParsing; exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Starting game server with auto-restart...
  start "Werewolf Server" "%~dp0server-loop.bat"
  timeout /t 3 /nobreak >nul
)

rem ---- Public tunnel with auto-restart loop ----
echo ==============================================
echo   Creating public tunnel... please wait
echo   Send this URL to your friends:
echo   (look for https://xxx.trycloudflare.com above)
echo ==============================================
:cf
"%CF%" tunnel --url http://localhost:3000 --protocol http2 --edge-ip-version 4 --no-autoupdate --metrics localhost:39571
echo [WARN] Tunnel exited/crashed. Restarting in 3s...  (press Ctrl+C twice to quit)
timeout /t 3 /nobreak >nul
goto cf
