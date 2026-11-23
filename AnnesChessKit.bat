@echo off
rem Starts Anne's Chess Kit from the source folder. Sets up a Python environment (.venv) on the first run
rem (in this window); the app then starts without a console: close its window to quit. Need the console
rem for debugging? Use "AnnesChessKit (debug).bat".
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Setting up Python environment...
  python -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || goto :error
)
start "" ".venv\Scripts\pythonw.exe" run.py %*
goto :eof
:error
echo Setup failed. Make sure Python 3.11+ is installed and on PATH.
pause
