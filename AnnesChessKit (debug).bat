@echo off
rem Anne's Chess Kit with a console window (shows errors live; Ctrl+C or closing this window stops it).
cd /d "%~dp0"
".venv\Scripts\python.exe" run.py %*
pause
