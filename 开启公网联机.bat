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
echo ==============================================
echo   Creating public tunnel... please wait
echo   URL will appear below (also saved to tunnel.log)
echo ==============================================
echo [%date% %time%] Tunnel starting... >> "%~dp0tunnel.log"
start "cloudflared" /min cmd /c ""%CF%" tunnel --url http://localhost:3000 --protocol http2 --no-autoupdate --metrics localhost:39571 >> "%~dp0tunnel.log" 2>&1"
echo.
echo   Waiting for tunnel URL...
echo.
:showurl
if exist "%~dp0tunnel.log" (
  for /f "tokens=*" %%L in ('type "%~dp0tunnel.log" ^| findstr /i "trycloudflare.com"') do (
    echo   [URL] %%L
  )
)
timeout /t 2 /nobreak >nul
goto showurl
