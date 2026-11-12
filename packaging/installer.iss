; Anne's Chess Kit - Windows installer (Inno Setup 6, https://jrsoftware.org/isinfo.php).
;
; Wraps the ready-to-run folder that scripts\package.ps1 builds (dist\AnnesChessKit) into one setup program:
;   package.bat -Installer            or            iscc /DAppVersion=1.0.0 packaging\installer.iss
;
; Installs for the current user only (no administrator rights, no UAC prompt) into
; %LOCALAPPDATA%\Programs\AnnesChessKit. Your data (reviews, settings, progress) is the "userdata" folder
; in there: an update keeps it, and uninstalling leaves it unless you tick the box to delete it.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{3E05F585-DCC0-4CB2-98A5-585D56E1411C}
AppName=Anne's Chess Kit
AppVersion={#AppVersion}
AppPublisher=Anne's Chess Kit contributors
DefaultDirName={localappdata}\Programs\AnnesChessKit
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=AnnesChessKit-{#AppVersion}-setup
SetupIconFile=..\app.ico
UninstallDisplayIcon={app}\AnnesChessKit.exe
UninstallDisplayName=Anne's Chess Kit
LicenseFile=..\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\AnnesChessKit\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[InstallDelete]
; An update replaces the program completely (files that no longer exist in the new version go away);
; userdata and anything you added to engine\ stay.
Type: filesandordirs; Name: "{app}\backend"
Type: filesandordirs; Name: "{app}\frontend"
Type: filesandordirs; Name: "{app}\python"

[Icons]
Name: "{autoprograms}\Anne's Chess Kit"; Filename: "{app}\AnnesChessKit.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Anne's Chess Kit"; Filename: "{app}\AnnesChessKit.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\AnnesChessKit.exe"; Description: "Start Anne's Chess Kit"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Files the app creates while running (Python caches, the opening-book cache). Not your data.
Type: filesandordirs; Name: "{app}\backend"
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\frontend"

[Code]
// The app keeps running in the background while its window is open: ask it to stop (its own shutdown
// request - only this app answers on that address) before files are replaced. Anything still open after
// that is handled by Setup's "close applications" page.
procedure StopApp();
var
  ResultCode: Integer;
begin
  Exec('powershell.exe',
       '-NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 http://127.0.0.1:8765/api/shutdown | Out-Null } catch {}"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1500);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if DirExists(ExpandConstant('{app}\python')) then
    StopApp();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopApp();
  if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(ExpandConstant('{app}\userdata')) then
      if MsgBox('Also delete your data (reviews, settings, training progress)?' + #13#10 + #13#10 +
                'Choose No to keep it for a later installation.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(ExpandConstant('{app}\userdata'), True, True, True);
    RemoveDir(ExpandConstant('{app}\engine'));
    RemoveDir(ExpandConstant('{app}'));
  end;
end;
