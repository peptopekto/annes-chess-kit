@echo off
rem Builds the ready-to-run folder (dist\AnnesChessKit) and its zip: Python, the UI and the launcher
rem included - nothing to install on the target PC. Options are passed on, e.g.:
rem   package.bat -Engines download     (fetch Stockfish, Lc0 and the Maia networks)
rem   package.bat -Engines none         (leave the engine folder empty)
rem   package.bat -Installer            (also build the setup .exe; needs Inno Setup)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\package.ps1" %*
if errorlevel 1 (
  echo.
  echo Packaging failed.
  pause
  exit /b 1
)
pause
