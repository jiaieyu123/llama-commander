@echo off
rem Llama Commander one-click launcher (double-click me).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1" %*
if errorlevel 1 (
  echo.
  echo Exited with an error. Press any key to close...
  pause >nul
)
