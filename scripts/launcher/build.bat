@echo off
rem Builds AnnesChessKit.exe (the launcher) into the project folder, with the app icon.
cd /d "%~dp0\..\.."
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ ^
  /win32icon:app.ico /reference:System.Windows.Forms.dll ^
  /out:AnnesChessKit.exe scripts\launcher\Launcher.cs
