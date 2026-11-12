@echo off
rem Double-click to start Anne's Chess Kit (or use AnnesChessKit.exe). Uses the Python that comes with the download (python\), else sets up
rem a Python environment on the first run (in this window). The app then starts without a console:
rem close its window to quit. Need the console for debugging? Use "AnnesChessKit (debug).bat".
cd /d "%~dp0"
if exist "python\pythonw.exe" (
  start "" "python\pythonw.exe" run.py %*
  goto :eof
)
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
