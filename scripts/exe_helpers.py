"""Helpers for scripts/build-exe.ps1 (run with the build Python).

  python exe_helpers.py engines <engine folder> <engines.zip>
      Pack the engine folder into one archive for the exe (forward slashes, so it unpacks the same everywhere).
  python exe_helpers.py licenses <folder>
      Write the licences of Python and the packages that go into the exe (not the build tools).
"""
import importlib.metadata as md
import shutil
import sys
import zipfile
from pathlib import Path

BUILD_ONLY = {"pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "pefile", "pywin32-ctypes", "macholib",
              "pip", "setuptools", "wheel", "packaging"}
LICENSE_NAMES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS")


def engines(folder: Path, archive: Path) -> None:
    files = sorted(p for p in folder.rglob("*") if p.is_file())
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            z.write(p, p.relative_to(folder).as_posix())
    print(f"   {len(files)} files, {archive.stat().st_size / 2**20:.0f} MB")


def licenses(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    py_license = Path(sys.base_prefix) / "LICENSE.txt"
    if py_license.is_file():
        shutil.copy(py_license, out / "python-LICENSE.txt")
    parts = ["Python packages inside AnnesChessKit.exe and their licences", ""]
    for d in sorted(md.distributions(), key=lambda d: (d.metadata["Name"] or "").lower()):
        name = d.metadata["Name"] or "?"
        if name.lower() in BUILD_ONLY:
            continue
        kind = d.metadata.get("License-Expression") or (d.metadata.get("License") or "").split("\n")[0]
        parts.append(f"===== {name} {d.version}" + (f" ({kind})" if kind else "") + " =====")
        for f in d.files or []:
            if f.name.upper().startswith(LICENSE_NAMES):
                try:
                    parts.append(Path(f.locate()).read_text(encoding="utf-8", errors="replace").strip())
                except OSError:
                    pass
        parts.append("")
    (out / "python-packages.txt").write_text("\n".join(parts), encoding="utf-8")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    if cmd == "engines":
        engines(Path(args[0]), Path(args[1]))
    elif cmd == "licenses":
        licenses(Path(args[0]))
    else:
        sys.exit(f"unknown command {cmd}")
