# PyInstaller recipe for the single-file AnnesChessKit.exe (built by scripts\build-exe.ps1).
#
# The exe holds Python, the packages, the backend (backend\app, backend\data), the built web UI
# (frontend\dist), the licences and - as one archive, engines.zip - the chess engines, which the app unpacks
# into its data folder on the first start (backend\app\bundled.py). CHESSKIT_STAGE points to the folder with
# engines.zip and licenses\ that build-exe.ps1 prepared.
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent
STAGE = Path(os.environ.get("CHESSKIT_STAGE") or ROOT / "dist" / ".exe-stage")

datas = [
    (str(ROOT / "backend" / "data"), "backend/data"),
    (str(ROOT / "frontend" / "dist"), "frontend/dist"),
    (str(ROOT / "LICENSE"), "."),
    (str(ROOT / "THIRD_PARTY_NOTICES.md"), "."),
]
if (STAGE / "engines.zip").is_file():
    datas.append((str(STAGE / "engines.zip"), "."))
if (STAGE / "licenses").is_dir():
    datas.append((str(STAGE / "licenses"), "licenses"))

# uvicorn loads the app by name ("app.main:app") and picks its parts at run time: list them, since
# PyInstaller only finds imports it can see in the code.
app_modules = ["app"] + [f"app.{p.stem}" for p in (ROOT / "backend" / "app").glob("*.py") if p.stem != "__init__"]
hiddenimports = app_modules + collect_submodules("uvicorn")

a = Analysis(
    [str(ROOT / "run.py")],
    pathex=[str(ROOT / "backend")],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="AnnesChessKit",
    icon=str(ROOT / "app.ico"),
    console=False,      # no console window: output goes to userdata\app.log, like before
    upx=False,          # compressed executables are what virus scanners distrust most
    runtime_tmpdir=None,
)
