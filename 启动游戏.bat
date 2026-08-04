@echo off
title Werewolf - Game Server
cd /d %~dp0

rem Auto-detect node.exe: use local copy if present, otherwise common locations
set NODE=%~dp0node.exe
if not exist "%NODE%" set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" (
  echo [ERROR] node.exe not found.
  echo Please copy node.exe into this folder, or install Node.js, or edit this file.
  pause
  exit /b
)

echo ==============================================
echo   Werewolf server starting...
echo   Browser will open http://localhost:3000
echo ==============================================
start "" http://localhost:3000
"%NODE%" server.js
pause
