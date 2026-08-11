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

rem ---- Start game server if not running ----
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri 'http://localhost:3000/healthz' -TimeoutSec 2 -UseBasicParsing; exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Starting game server with auto-restart...
  start "Werewolf Server" "%~dp0server-loop.bat"
  timeout /t 3 /nobreak >nul
)

rem ---- Kill stale cloudflared instances (avoid port conflict) ----
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 1 /nobreak >nul

rem ---- Public tunnel with auto-restart loop ----
echo ==============================================
echo   Creating public tunnel... please wait
echo   URL will appear below (also saved to tunnel.log)
echo ==============================================
:cf
echo [%date% %time%] Tunnel starting... >> "%~dp0tunnel.log"
powershell -NoProfile -Command "$p = Start-Process -FilePath '%CF%' -ArgumentList 'tunnel','--url','http://localhost:3000','--protocol','http2','--no-autoupdate','--metrics','localhost:39571' -WindowStyle Minimized -RedirectStandardOutput '%~dp0tunnel.log' -RedirectStandardError '%~dp0tunnel-err.log' -PassThru; $p.Id | Out-File -FilePath '%~dp0tunnel.pid' -Encoding ascii"
echo.
echo   Waiting for tunnel URL...
echo.
:showurl
if exist "%~dp0tunnel.pid" (
  set /p CFPID=<"%~dp0tunnel.pid"
)
if defined CFPID (
  tasklist /FI "PID eq %CFPID%" | findstr /i cloudflared >nul
  if errorlevel 1 (
    echo [WARN] cloudflared exited. Restarting...
    goto cf
  )
)
for /f "delims=" %%L in ('node.exe tools\tunnel-url.js') do set "LASTURL=%%L"
if defined LASTURL (
  if not "%LASTURL%"=="%SHOWNURL%" (
    echo.
    echo   ==================================================
    echo    Public URL: %LASTURL%
    echo    (saved to tunnel.log)
    echo   ==================================================
    echo.
    set "SHOWNURL=%LASTURL%"
  )
)
timeout /t 2 /nobreak >nul
goto showurl
