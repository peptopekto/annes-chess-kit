"""The single-file app: where it keeps its data, and unpacking the engines it carries."""
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

from app import bundled
from app.config import choose_home

BACKEND = Path(__file__).resolve().parents[1]


def test_data_next_to_the_exe_wins(tmp_path):
    exe_dir, local = tmp_path / "anywhere", tmp_path / "Local"
    (exe_dir / "userdata").mkdir(parents=True)
    (local / "AnnesChessKit" / "userdata").mkdir(parents=True)
    assert choose_home(exe_dir, local) == exe_dir


def test_downloaded_exe_uses_the_per_user_folder(tmp_path):
    exe_dir, local = tmp_path / "Downloads", tmp_path / "Local"
    exe_dir.mkdir()
    assert choose_home(exe_dir, local) == local / "AnnesChessKit"


def test_downloaded_exe_finds_the_data_of_an_installed_copy(tmp_path):
    exe_dir, local = tmp_path / "Downloads", tmp_path / "Local"
    exe_dir.mkdir()
    (local / "Programs" / "AnnesChessKit" / "userdata").mkdir(parents=True)
    assert choose_home(exe_dir, local) == local / "Programs" / "AnnesChessKit"
    # Once it has its own data, that is used.
    (local / "AnnesChessKit" / "userdata").mkdir(parents=True)
    assert choose_home(exe_dir, local) == local / "AnnesChessKit"


def _archive(path: Path, files: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


def test_unpack_once_and_again_after_an_update(tmp_path):
    archive = _archive(tmp_path / "engines.zip", {"stockfish-avx2.exe": b"sf", "lc0/lc0.exe": b"lc0",
                                                  "maia/maia-1100.pb.gz": b"net"})
    target = tmp_path / "engine"
    assert bundled.needed(archive, target)
    bundled.unpack(archive, target)
    assert (target / "stockfish-avx2.exe").read_bytes() == b"sf"
    assert (target / "lc0" / "lc0.exe").read_bytes() == b"lc0"
    assert not list(target.rglob("*.part"))
    assert not bundled.needed(archive, target)
    # A different archive (an update): unpacked again, files replaced.
    _archive(archive, {"stockfish-avx2.exe": b"sf-newer-build", "lc0/lc0.exe": b"lc0"})
    assert bundled.needed(archive, target)
    bundled.unpack(archive, target)
    assert (target / "stockfish-avx2.exe").read_bytes() == b"sf-newer-build"


def test_unpack_never_writes_outside_the_engine_folder(tmp_path):
    archive = _archive(tmp_path / "engines.zip", {"../evil.txt": b"x", "ok.txt": b"y"})
    target = tmp_path / "engine"
    bundled.unpack(archive, target)
    assert not (tmp_path / "evil.txt").exists()
    assert (target / "ok.txt").exists()


def test_missing_or_damaged_engines_are_unpacked_again(tmp_path):
    # E.g. an old installed version was uninstalled: its engine files are gone, the marker may stay.
    archive = _archive(tmp_path / "engines.zip", {"stockfish.exe": b"sf", "lc0/lc0.exe": b"lc0"})
    target = tmp_path / "engine"
    bundled.unpack(archive, target)
    assert not bundled.needed(archive, target)
    (target / "lc0" / "lc0.exe").unlink()
    assert bundled.needed(archive, target)
    bundled.unpack(archive, target)
    assert not bundled.needed(archive, target)
    (target / "stockfish.exe").write_bytes(b"s")  # cut short
    assert bundled.needed(archive, target)


def test_an_unsafe_member_does_not_force_unpacking_forever(tmp_path):
    archive = _archive(tmp_path / "engines.zip", {"../evil.txt": b"x", "ok.txt": b"y"})
    target = tmp_path / "engine"
    bundled.unpack(archive, target)
    assert not bundled.needed(archive, target)


def test_licence_texts_are_copied_once_per_version(tmp_path):
    src, dest = tmp_path / "licenses", tmp_path / "home" / "licenses"
    src.mkdir()
    (src / "LICENSE").write_text("GPL")
    bundled.copy_licences(src, dest)
    assert (dest / "LICENSE").read_text() == "GPL"
    (dest / "LICENSE").write_text("edited")
    bundled.copy_licences(src, dest)  # same version: left alone
    assert (dest / "LICENSE").read_text() == "edited"
    (dest / bundled.MARKER).write_text("0.0.1")
    bundled.copy_licences(src, dest)  # after an update: copied again
    assert (dest / "LICENSE").read_text() == "GPL"


def test_a_locked_engine_is_kept_and_retried(tmp_path, monkeypatch):
    archive = _archive(tmp_path / "engines.zip", {"stockfish.exe": b"new"})
    target = tmp_path / "engine"
    real = Path.replace

    def locked(self, dest):
        if Path(dest).name == "stockfish.exe":
            raise PermissionError("in use")
        return real(self, dest)

    monkeypatch.setattr(Path, "replace", locked)
    bundled.unpack(archive, target)
    assert not (target / "stockfish.exe").exists() and not list(target.rglob("*.part"))
    assert bundled.needed(archive, target)  # no marker: the next start tries again


def test_from_the_source_folder_nothing_is_unpacked():
    bundled.start()
    assert not bundled.busy()
    bundled.wait()  # returns at once
    assert not bundled.includes("lc0/")


def test_paths_inside_the_exe(tmp_path):
    """Import the real config as the single-file app would see it (a fresh Python, frozen like PyInstaller)."""
    bundle, exe_dir, local = tmp_path / "_MEI123", tmp_path / "Downloads", tmp_path / "Local"
    (bundle / "backend" / "data").mkdir(parents=True)
    (bundle / "backend" / "data" / "openings.tsv").write_text("A00\tTest\t1. a3\n", encoding="utf-8")
    exe_dir.mkdir()
    code = (
        "import json, sys\n"
        f"sys.frozen = True; sys._MEIPASS = {str(bundle)!r}; sys.executable = {str(exe_dir / 'AnnesChessKit.exe')!r}\n"
        "from app import config, openings\n"
        "print(json.dumps({k: str(getattr(config, k)) for k in "
        "('ROOT', 'HOME', 'USERDATA', 'ENGINE_DIR', 'FRONTEND_DIST', 'DATA')} | {'CACHE': str(openings.CACHE)}))\n")
    env = {k: v for k, v in os.environ.items() if k not in ("CHESSKIT_USERDATA", "BRILLIANT_USERDATA")}
    env.update(LOCALAPPDATA=str(local), PYTHONPATH=os.pathsep.join([str(BACKEND), *sys.path]))
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True).stdout
    p = {k: Path(v) for k, v in json.loads(out.strip().splitlines()[-1]).items()}
    home = local / "AnnesChessKit"
    assert p["ROOT"] == exe_dir and p["HOME"] == home
    assert p["USERDATA"] == home / "userdata" and p["ENGINE_DIR"] == home / "engine"
    assert p["FRONTEND_DIST"] == bundle / "frontend" / "dist" and p["DATA"] == bundle / "backend" / "data"
    assert p["CACHE"].parent == home / "userdata" / "cache"
    assert (home / "userdata" / "games").is_dir()  # created on start, like from the source folder
