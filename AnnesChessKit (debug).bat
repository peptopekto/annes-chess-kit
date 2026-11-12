@echo off
rem Anne's Chess Kit with a console window (shows errors live; Ctrl+C or closing this window stops it).
cd /d "%~dp0"
if exist "python\python.exe" (
  "python\python.exe" run.py %*
) else (
  ".venv\Scripts\python.exe" run.py %*
)
pause
