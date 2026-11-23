<#
.SYNOPSIS
  Builds the ready-to-run Anne's Chess Kit for Windows: dist\AnnesChessKit (a folder you can copy anywhere)
  and dist\AnnesChessKit-<version>-windows.zip. Optionally the installer (dist\AnnesChessKit-<version>-setup.exe).

.DESCRIPTION
  The folder contains everything the app needs - its own Python with the packages installed, the built
  web UI, the launcher (AnnesChessKit.exe) and, if asked for, the chess engines - so the target PC needs
  nothing installed. Your data lives in the folder's "userdata" (created on first start).
  The licences of everything included go along: LICENSE (the app), licenses\ (web UI packages, Python),
  engine\ENGINES.txt plus each engine's own licence file.

  Run it from the project folder (or double-click package.bat). Works with Windows PowerShell 5.1 and
  PowerShell 7. Needs internet for Python and the packages (and the engines with -Engines download).

.PARAMETER Engines
  local    (default) copy the engines from this checkout's engine\ folder, if there are any
  download fetch Stockfish, Lc0 and the Maia networks from their official release pages
  none     leave engine\ empty (the user adds Stockfish - see engine\README.md)

.PARAMETER Installer
  Also build the setup program with Inno Setup (iscc.exe on PATH or in its default folder).

.PARAMETER SkipUi
  Don't rebuild the web UI (use frontend\dist as it is).

.PARAMETER NoPython
  Only the web UI, the engines and the licences (no launcher, no bundled Python, no zip): what
  scripts\build-exe.ps1 packs into the single-file AnnesChessKit.exe.

.PARAMETER EngineSources
  Also download the source code of the included Stockfish and Lc0 versions into
  dist\AnnesChessKit-<version>-engine-sources.zip (to publish next to the release: the GPL asks whoever
  distributes the engines to make their source available as well).
#>
param(
    [ValidateSet('local', 'download', 'none')] [string]$Engines = 'local',
    [switch]$Installer,
    [switch]$SkipUi,
    [switch]$EngineSources,
    [switch]$NoPython,
    [string]$PythonVersion = '3.12.10'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Version = ([regex]::Match((Get-Content backend\app\__init__.py -Raw), '__version__\s*=\s*"([^"]+)"')).Groups[1].Value
if (-not $Version) { throw 'Could not read the version from backend\app\__init__.py' }
$Dist = Join-Path $Root 'dist'
$Out = Join-Path $Dist 'AnnesChessKit'
$Cache = Join-Path $Dist '.cache'          # downloads are kept between runs

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "   $text" }
function Warn($text) { Write-Host "   ! $text" -ForegroundColor Yellow }

function Get-File($url, $name) {
    # Download once into dist\.cache; returns the local path.
    New-Item -ItemType Directory -Force $Cache | Out-Null
    $target = Join-Path $Cache $name
    if (-not (Test-Path $target)) {
        Note "downloading $name"
        $tmp = "$target.part"
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -Headers (Get-Headers $url)
        Move-Item -Force $tmp $target
    }
    return $target
}

function Get-Headers($url) {
    # In CI a token avoids GitHub's anonymous rate limit.
    $h = @{ 'User-Agent' = 'annes-chess-kit-packaging' }
    if ($env:GITHUB_TOKEN -and $url -like 'https://api.github.com/*') { $h['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
    return $h
}

function Get-ReleaseAsset($repo, $pattern) {
    # The newest release asset of a GitHub repository whose name matches $pattern (a regex).
    $url = "https://api.github.com/repos/$repo/releases?per_page=10"
    $releases = Invoke-RestMethod -Uri $url -Headers (Get-Headers $url)
    foreach ($r in $releases) {
        if ($r.prerelease -or $r.draft) { continue }
        $asset = $r.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
        if ($asset) { return $asset }
    }
    return $null
}

# --------------------------------------------------------------------------- 1. web UI
Step 'Web UI'
if ($SkipUi) {
    Note 'skipped (-SkipUi)'
} else {
    # The portable Node in .tools\node (like build-frontend.bat): npm.cmd calls "node", so its folder has
    # to be on the PATH for this run too.
    if (Test-Path '.tools\node\node.exe') {
        $nodeDir = (Resolve-Path '.tools\node').Path
        $env:Path = "$nodeDir;$env:Path"
    }
    $npm = if (Test-Path '.tools\node\npm.cmd') { (Resolve-Path '.tools\node\npm.cmd').Path } else { (Get-Command npm -ErrorAction SilentlyContinue).Source }
    if ($npm) {
        Push-Location frontend
        try {
            if (-not (Test-Path node_modules)) { & $npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
            & $npm run build; if ($LASTEXITCODE) { throw 'The UI build failed' }
        } finally { Pop-Location }
    } elseif (Test-Path 'frontend\dist\index.html') {
        Warn 'npm not found - using the existing frontend\dist as it is'
    }
}
if (-not (Test-Path 'frontend\dist\index.html')) { throw 'frontend\dist is missing: build the UI first (build-frontend.bat)' }

# --------------------------------------------------------------------------- 2. launcher
Step 'Launcher (AnnesChessKit.exe)'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if ($NoPython) {
    Note 'skipped (-NoPython)'
} elseif (Test-Path $csc) {
    & $csc /nologo /target:winexe /optimize+ /win32icon:app.ico /reference:System.Windows.Forms.dll /out:AnnesChessKit.exe scripts\launcher\Launcher.cs
    if ($LASTEXITCODE) { throw 'Building AnnesChessKit.exe failed' }
} elseif (-not (Test-Path 'AnnesChessKit.exe')) {
    throw "The C# compiler wasn't found ($csc) and there is no AnnesChessKit.exe yet"
} else { Warn 'C# compiler not found - using the existing AnnesChessKit.exe' }

# --------------------------------------------------------------------------- 3. the folder
Step "Folder dist\AnnesChessKit (version $Version)"
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
foreach ($item in 'backend', 'run.py', 'AnnesChessKit.exe', 'AnnesChessKit.bat', 'AnnesChessKit (debug).bat', 'app.ico',
                  'requirements.txt', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md') {
    if (Test-Path $item) { Copy-Item -Recurse $item $Out } else { Warn "$item not found - left out" }
}
New-Item -ItemType Directory -Force "$Out\frontend" | Out-Null
Copy-Item -Recurse frontend\dist "$Out\frontend\dist"
New-Item -ItemType Directory -Force "$Out\engine" | Out-Null
Copy-Item engine\README.md "$Out\engine\README.md"
Get-ChildItem $Out -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force
foreach ($junk in 'backend\tests', 'backend\.pytest_cache', 'backend\data\openings.cache.json') {
    if (Test-Path "$Out\$junk") { Remove-Item -Recurse -Force "$Out\$junk" }
}

# --------------------------------------------------------------------------- 4. Python
Step "Python $PythonVersion with the packages"
$py = Join-Path $Out 'python'
if ($NoPython) { Note 'skipped (-NoPython)' } else {
$zip = Get-File "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" "python-$PythonVersion-embed-amd64.zip"
Expand-Archive -Path $zip -DestinationPath $py -Force
# The embedded Python only looks where its ._pth file says: add site-packages (for the packages below).
$pth = Get-ChildItem $py -Filter 'python*._pth' | Select-Object -First 1
if (-not $pth) { throw 'Unexpected Python download: no ._pth file' }
$stdlib = (Get-ChildItem $py -Filter 'python*.zip' | Select-Object -First 1).Name
Set-Content -Path $pth.FullName -Encoding ASCII -Value @($stdlib, '.', 'Lib\site-packages', 'import site')
$getPip = Get-File 'https://bootstrap.pypa.io/get-pip.py' 'get-pip.py'
& "$py\python.exe" $getPip --no-warn-script-location --quiet
if ($LASTEXITCODE) { throw 'Installing pip into the bundled Python failed' }
# python-chess is published as source only (it's pure Python), so pip has to build it - with setuptools, in
# this Python itself: pip's usual separate build environment doesn't work in the embedded Python (its ._pth
# file ignores the paths pip sets up). --no-cache-dir: build the same way as on a fresh PC (GitHub's builder),
# instead of reusing a wheel pip built earlier on this one.
& "$py\python.exe" -m pip install --no-warn-script-location --quiet --no-cache-dir setuptools wheel
if ($LASTEXITCODE) { throw 'Installing setuptools into the bundled Python failed' }
& "$py\python.exe" -m pip install --no-warn-script-location --quiet --no-cache-dir --prefer-binary --no-build-isolation -r requirements.txt
if ($LASTEXITCODE) { throw 'Installing the Python packages failed' }
& "$py\python.exe" -m pip uninstall --quiet --yes setuptools wheel   # only needed for building
# Check that it really starts, then drop what isn't needed at run time (pip, caches, launch scripts).
& "$py\python.exe" -c "import sys; sys.path.insert(0, r'$Out\backend'); import chess, fastapi, uvicorn, httpx, yaml; import app.main"
if ($LASTEXITCODE) { throw 'The packaged Python cannot import the app - see the error above' }
foreach ($drop in 'Scripts', 'Lib\site-packages\pip', 'Lib\site-packages\setuptools', 'Lib\site-packages\wheel') {
    if (Test-Path "$py\$drop") { Remove-Item -Recurse -Force "$py\$drop" }
}
Get-ChildItem "$py\Lib\site-packages" -Directory -Filter 'pip-*.dist-info' | Remove-Item -Recurse -Force
Get-ChildItem $Out -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force
if (Test-Path "$Out\userdata") { Remove-Item -Recurse -Force "$Out\userdata" }   # created by the import check
}   # -NoPython

# --------------------------------------------------------------------------- 5. engines
Step "Engines ($Engines)"
$eng = Join-Path $Out 'engine'
if ($Engines -eq 'local') {
    $sf = @(Get-ChildItem engine -File -Filter 'stockfish*' -ErrorAction SilentlyContinue)
    if (-not $sf) {
        Warn 'no Stockfish in engine\ - the folder ships without engines (use -Engines download to fetch them)'
    } else {
        # One fast and one that runs everywhere is enough (each build is ~80 MB).
        $pick = @($sf | Where-Object { $_.Name -match 'avx2' } | Select-Object -First 1) +
                @($sf | Where-Object { $_.Name -notmatch 'avx2|bmi2|avx512|vnni' } | Select-Object -First 1)
        if (-not $pick) { $pick = @($sf | Select-Object -First 1) }
        $pick | ForEach-Object { Copy-Item $_.FullName $eng; Note "Stockfish: $($_.Name)" }
        foreach ($dir in 'lc0', 'maia') {
            if (Test-Path "engine\$dir") { Copy-Item -Recurse "engine\$dir" $eng; Note "$dir copied" }
        }
        if (Test-Path 'engine\syzygy') { Note 'syzygy tablebases are not copied (large) - add them by hand if wanted' }
    }
} elseif ($Engines -eq 'download') {
    # Each engine on its own: one failing download doesn't stop the rest (Stockfish is the one that matters).
    try {
        $n = 0
        foreach ($pattern in '^stockfish-windows-x86-64-avx2\.zip$', '^stockfish-windows-x86-64(-sse41-popcnt)?\.zip$') {
            $a = Get-ReleaseAsset 'official-stockfish/Stockfish' $pattern
            if (-not $a) { continue }
            $tmp = Join-Path $Cache ([IO.Path]::GetFileNameWithoutExtension($a.name))
            if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
            Expand-Archive -Path (Get-File $a.browser_download_url $a.name) -DestinationPath $tmp -Force
            Get-ChildItem $tmp -Recurse -File -Filter 'stockfish*.exe' | ForEach-Object { Copy-Item $_.FullName $eng; Note "Stockfish: $($_.Name)"; $n++ }
            Get-ChildItem $tmp -Recurse -File | Where-Object { $_.Name -match '^(Copying|COPYING|AUTHORS)' } | Select-Object -First 2 |
                ForEach-Object { Copy-Item $_.FullName (Join-Path $eng "stockfish-$($_.Name)") -Force }
        }
        if (-not $n) { throw 'no matching download found on the Stockfish release page' }
    } catch { Warn "Stockfish: $($_.Exception.Message)"; if ($env:CI) { throw } }
    try {
        $a = Get-ReleaseAsset 'LeelaChessZero/lc0' 'windows-cpu-dnnl\.zip$'
        if (-not $a) { throw 'no cpu-dnnl download found on the Lc0 release page' }
        New-Item -ItemType Directory -Force "$eng\lc0" | Out-Null
        Expand-Archive -Path (Get-File $a.browser_download_url $a.name) -DestinationPath "$eng\lc0" -Force
        Get-ChildItem "$eng\lc0" -File | Where-Object { $_.Extension -in '.pb', '.gz' -or $_.Name -match '^(client|.*\.pdb$)' } | Remove-Item -Force
        Note "Lc0: $($a.name)"
        New-Item -ItemType Directory -Force "$eng\maia" | Out-Null
        foreach ($level in 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900) {
            $f = "maia-$level.pb.gz"
            Copy-Item (Get-File "https://raw.githubusercontent.com/CSSLab/maia-chess/master/maia_weights/$f" $f) "$eng\maia\$f"
        }
        Note 'Maia networks 1100-1900'
    } catch { Warn "Lc0 / Maia: $($_.Exception.Message) - the Instructive bot will be unavailable until they are added" }
} else {
    Note 'none - see engine\README.md in the folder'
}

# --------------------------------------------------------------------------- 6. licences
Step 'Licences'
$lic = Join-Path $Out 'licenses'
New-Item -ItemType Directory -Force $lic | Out-Null
# Web UI: the bundler drops the packages' copyright notices, so their licence texts go into one file.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
    & $node scripts\collect-licenses.mjs "$lic\web-ui.txt"
    if ($LASTEXITCODE) { Warn 'collecting the web UI licences failed (run npm ci in frontend, then package again)' }
} else { Warn 'node not found - licenses\web-ui.txt left out' }
# Python and its packages: their licence files stay where they are installed.
Set-Content -Encoding ASCII -Path "$lic\README.txt" -Value @(
    'Licences of the third-party software in this folder',
    '',
    '  ..\LICENSE                       Anne''s Chess Kit itself (GNU GPL v3 or later)',
    '  ..\THIRD_PARTY_NOTICES.md        overview: what is included, its licence and where its source is',
    '  web-ui.txt                       the packages bundled into the web interface (frontend\dist)',
    '  ..\python\LICENSE.txt            Python (PSF License)',
    '  ..\python\Lib\site-packages\*.dist-info\   each Python package (its licence file or METADATA)',
    '  ..\engine\ENGINES.txt            the chess engines and networks: versions, licences, source code',
    '  ..\frontend\dist\sounds\LICENSE.txt   the sound effects (CC0)')

# Engines: which versions are included, their licences and where their exact source code is.
function Get-Banner($exe) {
    # What a UCI engine prints first names its version ("Stockfish 17.1 by ...", lc0: "... v0.31.2 built ...").
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { return ((@('quit' | & $exe 2>&1 | Select-Object -First 6) | ForEach-Object { "$_" }) -join ' ') }
    catch { return '' }
    finally { $ErrorActionPreference = $prev }
}
$engineInfo = @('Chess engines and networks included in this folder', '')
$sources = @{}   # name -> source archive of the exact version
$sfExe = @(Get-ChildItem $eng -File -Filter 'stockfish*.exe' -ErrorAction SilentlyContinue)
if ($sfExe) {
    # Stockfish is GPL v3, the same licence text as ..\LICENSE.
    if (-not (Get-ChildItem $eng -File -Filter 'stockfish-Cop*' -ErrorAction SilentlyContinue)) { Copy-Item LICENSE "$eng\stockfish-Copying.txt" }
    foreach ($exe in $sfExe) {
        $m = [regex]::Match((Get-Banner $exe.FullName), 'Stockfish\s+(\S+)')
        $ver = if ($m.Success) { $m.Groups[1].Value } else { 'unknown version' }
        $src = if ($ver -match '^\d+(\.\d+)*$') { "https://github.com/official-stockfish/Stockfish/tree/sf_$ver" } else { 'https://github.com/official-stockfish/Stockfish' }
        if ($ver -match '^\d+(\.\d+)*$') { $sources["stockfish-sf_$ver"] = "https://github.com/official-stockfish/Stockfish/archive/refs/tags/sf_$ver.zip" }
        $engineInfo += "$($exe.Name): Stockfish $ver - GNU GPL v3 (stockfish-Copying.txt) - source: $src"
        Note "Stockfish $ver ($($exe.Name))"
    }
}
if (Test-Path "$eng\lc0\lc0.exe") {
    $m = [regex]::Match((Get-Banner "$eng\lc0\lc0.exe"), 'v(\d+\.\d+(\.\d+)?)')
    $ver = if ($m.Success) { $m.Groups[1].Value } else { 'unknown version' }
    $src = if ($m.Success) { "https://github.com/LeelaChessZero/lc0/tree/v$ver" } else { 'https://github.com/LeelaChessZero/lc0' }
    if ($m.Success) { $sources["lc0-v$ver"] = "https://github.com/LeelaChessZero/lc0/archive/refs/tags/v$ver.zip" }
    $engineInfo += "lc0\lc0.exe: Lc0 $ver - GNU GPL v3 (lc0\COPYING; its libraries: lc0\*-LICENSE) - source: $src"
    Note "Lc0 $ver"
}
if (Test-Path "$eng\maia") {
    Copy-Item LICENSE "$eng\maia\COPYING.txt"
    Set-Content -Encoding ASCII -Path "$eng\maia\README.txt" -Value @(
        'Maia chess networks (maia-1100 ... maia-1900), unchanged.',
        'By the Computational Social Science Lab (CSSLab), University of Toronto: https://maiachess.com',
        'Licence: GNU GPL v3 (COPYING.txt). Source: https://github.com/CSSLab/maia-chess (folder maia_weights).')
    $engineInfo += 'maia\: Maia networks by the CSSLab, University of Toronto - GNU GPL v3 (maia\COPYING.txt) - source: https://github.com/CSSLab/maia-chess'
}
if ($engineInfo.Count -gt 2) {
    $engineInfo += @('', 'The engines are separate programs; the app talks to them over the UCI protocol.',
                     'They are included unchanged, as published by their authors.')
    Set-Content -Encoding ASCII -Path "$eng\ENGINES.txt" -Value $engineInfo
}
if ($EngineSources -and $sources.Count) {
    $srcDir = Join-Path $Cache 'engine-sources'
    if (Test-Path $srcDir) { Remove-Item -Recurse -Force $srcDir }
    New-Item -ItemType Directory -Force $srcDir | Out-Null
    foreach ($k in @($sources.Keys)) { Copy-Item (Get-File $sources[$k] "$k.zip") $srcDir }
    $srcZip = Join-Path $Dist "AnnesChessKit-$Version-engine-sources.zip"
    if (Test-Path $srcZip) { Remove-Item -Force $srcZip }
    Compress-Archive -Path "$srcDir\*" -DestinationPath $srcZip
    Note "engine sources: $srcZip"
}

if ($NoPython) {
    Write-Host "`nDone: dist\AnnesChessKit has the UI, the engines and the licences (for build-exe.ps1)." -ForegroundColor Green
    return
}

# --------------------------------------------------------------------------- 7. zip (+ installer)
Step 'Zip'
$zipOut = Join-Path $Dist "AnnesChessKit-$Version-windows.zip"
if (Test-Path $zipOut) { Remove-Item -Force $zipOut }
Compress-Archive -Path $Out -DestinationPath $zipOut
$mb = { param($p) '{0:N0} MB' -f ((Get-ChildItem $p -Recurse -File | Measure-Object Length -Sum).Sum / 1MB) }
Note "folder: $Out  ($(& $mb $Out))"
Note "zip:    $zipOut  ($('{0:N0} MB' -f ((Get-Item $zipOut).Length / 1MB)))"

if ($Installer) {
    Step 'Installer'
    $iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
    if (-not $iscc) {
        # Installed for all users (Program Files) or just for you (winget without admin: AppData\Local\Programs),
        # else wherever the uninstall entry in the registry says.
        $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ }
        $iscc = @(foreach ($r in $roots) { foreach ($v in '6', '7') { Join-Path $r "Inno Setup $v\ISCC.exe" } }) |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $iscc) {
            $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup*_is1',
                    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup*_is1',
                    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup*_is1'
            $iscc = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
                ForEach-Object { if ($_.InstallLocation) { Join-Path $_.InstallLocation 'ISCC.exe' } } |
                Where-Object { Test-Path $_ } | Select-Object -First 1
        }
    }
    if (-not $iscc) { throw 'Inno Setup not found - install it from https://jrsoftware.org/isdl.php (free), then run this again with -Installer' }
    & $iscc /Qp "/DAppVersion=$Version" packaging\installer.iss
    if ($LASTEXITCODE) { throw 'Building the installer failed' }
    Note "setup:  $(Join-Path $Dist "AnnesChessKit-$Version-setup.exe")"
}

Write-Host "`nDone. Test it: start dist\AnnesChessKit\AnnesChessKit.exe" -ForegroundColor Green
