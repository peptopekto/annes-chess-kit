@echo off
rem Builds the frontend (frontend\dist). Uses the portable Node in .tools\node if it is there, else Node on PATH.
setlocal
set "ROOT=%~dp0"
set "NPM=npm"
if exist "%ROOT%.tools\node\npm.cmd" set "NPM=%ROOT%.tools\node\npm.cmd"
if exist "%ROOT%.tools\node\node.exe" set "PATH=%ROOT%.tools\node;%PATH%"
echo Using %NPM%
cd /d "%ROOT%frontend" || goto :error
if not exist node_modules call "%NPM%" install
if not exist node_modules goto :error
call "%NPM%" run build
if errorlevel 1 goto :error
echo.
echo Frontend built. Restart the app to use it.
pause
exit /b 0
:error
echo.
echo Build failed.
pause
exit /b 1
