<#
.SYNOPSIS
  Builds the single-file Anne's Chess Kit: dist\AnnesChessKit-<version>-windows.exe.

.DESCRIPTION
  One exe with everything inside: Python and its packages, the app, the web UI, the licences and the chess
  engines. The engines are unpacked once into the data folder on the first start; the PC it runs on needs
  nothing installed.

  1. package.ps1 builds the web UI and gathers the engines and their licences (dist\.exe-parts).
  2. The engines are packed into one archive, and the licences of Python and its packages are collected.
  3. A build Python (dist\.cache\exe-venv) with the app's packages and PyInstaller packs it all into one file.
  4. The exe is started once, with a scratch data folder, to check that it runs and finds its engines.

  Run it from the project folder. Needs Node.js 20.19+ or 22+, Python 3.11 or newer (the py launcher or
  python on the PATH) and internet for the packages (and for the engines with -Engines download).

.PARAMETER Engines
  local (default), download or none - as for package.ps1.

.PARAMETER SkipUi
  Don't rebuild the web UI (use frontend\dist as it is).

.PARAMETER EngineSources
  Also download the engines' source code into dist\AnnesChessKit-<version>-engine-sources.zip.

.PARAMETER SkipTest
  Don't start the finished exe to check it.
#>
param(
    [ValidateSet('local', 'download', 'none')] [string]$Engines = 'local',
    [switch]$SkipUi,
    [switch]$EngineSources,
    [switch]$SkipTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Version = ([regex]::Match((Get-Content backend\app\__init__.py -Raw), '__version__\s*=\s*"([^"]+)"')).Groups[1].Value
if (-not $Version) { throw 'Could not read the version from backend\app\__init__.py' }
$Dist = Join-Path $Root 'dist'
$Folder = Join-Path $Dist '.exe-parts'
$Stage = Join-Path $Dist '.exe-stage'
$Venv = Join-Path $Dist '.cache\exe-venv'
$Result = Join-Path $Dist "AnnesChessKit-$Version-windows.exe"

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "   $text" }
function Warn($text) { Write-Host "   ! $text" -ForegroundColor Yellow }
function Check($what) { if ($LASTEXITCODE) { throw "$what failed - see the messages above" } }

# --------------------------------------------------------------------------- 1. UI, engines, licences
Step 'Web UI, engines and licences (package.ps1)'
& (Join-Path $PSScriptRoot 'package.ps1') -Engines $Engines -SkipUi:$SkipUi -EngineSources:$EngineSources

# --------------------------------------------------------------------------- 2. build Python
Step 'Build Python with the packages and PyInstaller'
$vpy = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $vpy)) {
    if ($env:pythonLocation -and (Test-Path "$env:pythonLocation\python.exe")) {
        & "$env:pythonLocation\python.exe" -m venv $Venv            # GitHub's builder (actions/setup-python)
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 -m venv $Venv
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        & python -m venv $Venv
    } else { throw 'Python not found - install Python 3.12 from python.org (with the "py launcher"), then run this again' }
    Check 'Creating the build Python'
}
& $vpy -m pip install --quiet --upgrade pip; Check 'Updating pip'
& $vpy -m pip install --quiet --prefer-binary -r requirements.txt pyinstaller; Check 'Installing the packages'
# (no double quotes inside: Windows PowerShell 5.1 drops them when passing arguments to programs)
Note "Python and PyInstaller: $(& $vpy -c 'import sys, PyInstaller; print(sys.version.split()[0], PyInstaller.__version__)')"

# --------------------------------------------------------------------------- 3. engines archive + licences
Step 'Engines archive and licences'
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Stage | Out-Null
$eng = Join-Path $Folder 'engine'
if (Get-ChildItem $eng -Recurse -File -Filter 'stockfish*' -ErrorAction SilentlyContinue) {
    & $vpy scripts\exe_helpers.py engines $eng (Join-Path $Stage 'engines.zip'); Check 'Packing the engines'
} else {
    Warn 'no Stockfish to pack - the exe will ask for it, like the source version (use -Engines download)'
}
$lic = Join-Path $Stage 'licenses'
New-Item -ItemType Directory -Force $lic | Out-Null
if (Test-Path "$Folder\licenses\web-ui.txt") { Copy-Item "$Folder\licenses\web-ui.txt" $lic }
if (Test-Path "$eng\ENGINES.txt") { Copy-Item "$eng\ENGINES.txt" $lic }
Copy-Item LICENSE, THIRD_PARTY_NOTICES.md $lic
& $vpy scripts\exe_helpers.py licenses $lic; Check 'Collecting the licences'
Set-Content -Encoding ASCII -Path "$lic\README.txt" -Value @(
    'Licences of Anne''s Chess Kit and of the third-party software inside AnnesChessKit.exe',
    '(AnnesChessKit.exe copies this folder into its data folder, next to userdata\ and engine\)',
    '',
    '  LICENSE                     Anne''s Chess Kit itself (GNU GPL v3 or later)',
    '  THIRD_PARTY_NOTICES.md      overview: what is included, its licence and where its source is',
    '  web-ui.txt                  the packages bundled into the web interface',
    '  python-LICENSE.txt          Python (PSF License)',
    '  python-packages.txt         the Python packages, each with its licence',
    '  ENGINES.txt                 the chess engines and networks: versions, licences, source code',
    '',
    'The engines are unpacked into the data folder (engine\) with their own licence files.')

# --------------------------------------------------------------------------- 4. the exe
Step "AnnesChessKit.exe (version $Version)"
$env:CHESSKIT_STAGE = $Stage
try {
    & $vpy -m PyInstaller --noconfirm --clean --log-level WARN --distpath (Join-Path $Dist 'exe') `
        --workpath (Join-Path $Dist '.cache\pyinstaller') packaging\AnnesChessKit.spec
    Check 'PyInstaller'
} finally { Remove-Item Env:CHESSKIT_STAGE -ErrorAction SilentlyContinue }
$built = Join-Path $Dist 'exe\AnnesChessKit.exe'
Copy-Item -Force $built $Result
Note ("{0}  ({1:N0} MB)" -f $Result, ((Get-Item $Result).Length / 1MB))

# --------------------------------------------------------------------------- 5. try it once
if ($SkipTest) {
    Note 'test skipped (-SkipTest)'
} else {
    Step 'Test start (scratch data folder, port 8799)'
    $testHome = Join-Path $Dist '.cache\exe-test-home'
    if (Test-Path $testHome) { Remove-Item -Recurse -Force $testHome }
    $port = 8799
    $env:CHESSKIT_HOME = $testHome
    try {
        $proc = Start-Process -FilePath $Result -ArgumentList '--no-open', '--port', "$port" -PassThru
        $health = $null
        $deadline = (Get-Date).AddMinutes(4)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            if ($proc.HasExited) { break }
            try { $health = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$port/api/health" } catch { continue }
            if (-not $health.preparing) { break }
            Note 'unpacking the engines...'
        }
        $log = Join-Path $testHome 'userdata\app.log'
        if (-not $health -or $health.preparing) {
            if (Test-Path $log) { Get-Content $log -Tail 40 | ForEach-Object { Write-Host "   | $_" } }
            throw 'The exe did not start properly (log above)'
        }
        if ($health.version -ne $Version) { throw "The exe reports version $($health.version), expected $Version" }
        Note "runs: version $($health.version), data in $($health.userdata)"
        if (-not (Test-Path "$testHome\licenses\LICENSE")) { throw 'The exe did not copy its licence texts into the data folder' }
        if (Test-Path "$Stage\engines.zip") {
            if (-not $health.engine) { throw 'The exe started, but found no working Stockfish after unpacking' }
            Note "Stockfish: $($health.enginePath)"
            Note ("Lc0 + Maia: {0}" -f $(if ($health.maia) { 'yes' } else { 'no' }))
        }
    } finally {
        try { Invoke-RestMethod -Method Post -TimeoutSec 5 "http://127.0.0.1:$port/api/shutdown" | Out-Null } catch {}
        if ($proc -and -not $proc.WaitForExit(15000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item Env:CHESSKIT_HOME -ErrorAction SilentlyContinue
    }
}

Write-Host "`nDone: $Result" -ForegroundColor Green
Write-Host 'Try it: double-click it. Its data goes to %LOCALAPPDATA%\AnnesChessKit, or to a userdata folder next to it if there is one.'
