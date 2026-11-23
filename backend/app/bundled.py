"""The chess engines inside the single-file AnnesChessKit.exe.

The exe carries Stockfish, Lc0 and the Maia networks as one compressed archive (engines.zip). Unpacking
them on every start would take a long time, so they are unpacked once into the data folder's engine/ and
again only when the exe brings different ones (an update). That happens in the background: the window
opens right away, and whatever needs an engine waits until the engines are ready (pages that go through
your games show it as a progress bar). The licence texts inside the exe are copied to the data folder's
licenses/ as well, so they can be read without unpacking the exe.

Run from the source folder, there is no archive and nothing happens here.
"""
from __future__ import annotations

import shutil
import threading
import zipfile
from pathlib import Path

from . import __version__, progress
from .config import BUNDLE, ENGINE_DIR, FROZEN, HOME

ARCHIVE = BUNDLE / "engines.zip"
MARKER = ".unpacked"     # in the engine folder: which archive was unpacked there
LICENCES = BUNDLE / "licenses"

_ready = threading.Event()
_started = False
_lock = threading.Lock()
_error: list[str] = []


def _dest(target: Path, member: zipfile.ZipInfo) -> Path | None:
    """Where an archive member goes, or None for one that would land outside the engine folder."""
    dest = (target / member.filename.replace("\\", "/")).resolve()
    return dest if target.resolve() in dest.parents else None


def stamp(archive: Path) -> str:
    """What identifies an archive: the app version and the archive's size."""
    return f"{__version__} {archive.stat().st_size}"


def needed(archive: Path, target: Path) -> bool:
    """Does the engine folder need (re)unpacking?

    Yes when it was unpacked from a different archive, and also when a file is missing or has the wrong size
    (deleted by hand, or removed by uninstalling an old version that kept its data in the same folder).
    """
    if not archive.is_file():
        return False
    try:
        if (target / MARKER).read_text(encoding="utf-8").strip() != stamp(archive):
            return True
    except OSError:
        return True
    with zipfile.ZipFile(archive) as z:
        for m in z.infolist():
            dest = None if m.is_dir() else _dest(target, m)
            if dest is None:
                continue
            try:
                if dest.stat().st_size != m.file_size:
                    return True
            except OSError:
                return True
    return False


def unpack(archive: Path, target: Path, task: progress.Task | None = None) -> None:
    """Unpack the archive into target, file by file.

    Each file goes to a temporary name first and then replaces the old one, so a half-written engine is never
    left behind. An engine that is running (another copy of the app) can't be replaced: it is kept, and the
    marker is not written, so the next start tries again.
    """
    target.mkdir(parents=True, exist_ok=True)
    complete = True
    with zipfile.ZipFile(archive) as z:
        members = [m for m in z.infolist() if not m.is_dir()]
        if task:
            task.step(0, len(members))
        for i, m in enumerate(members):
            dest = _dest(target, m)
            if dest is None:  # never write outside the engine folder
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + ".part")
            with z.open(m) as src, open(tmp, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
            try:
                tmp.replace(dest)
            except PermissionError:
                tmp.unlink(missing_ok=True)
                complete = False
            if task:
                task.step(i + 1)
    if complete:
        (target / MARKER).write_text(stamp(archive), encoding="utf-8")


def copy_licences(source: Path, target: Path) -> None:
    """Put the licence texts where you can read them: the data folder's licenses/ (again after an update)."""
    if not source.is_dir():
        return
    marker = target / MARKER
    try:
        if marker.read_text(encoding="utf-8").strip() == __version__:
            return
    except OSError:
        pass
    target.mkdir(parents=True, exist_ok=True)
    for f in source.iterdir():
        if f.is_file():
            shutil.copyfile(f, target / f.name)
    marker.write_text(__version__, encoding="utf-8")


def _run() -> None:
    try:
        if needed(ARCHIVE, ENGINE_DIR):
            with progress.track("engines", "Unpacking the chess engines (first start only)") as task:
                unpack(ARCHIVE, ENGINE_DIR, task)
    except Exception as e:  # a full disk, a virus scanner holding a file: the app still starts
        _error.append(str(e))
        print(f"Unpacking the engines failed: {e}")
    finally:
        _ready.set()


def start() -> None:
    """Begin unpacking in the background (once per run)."""
    global _started
    with _lock:
        if _started:
            return
        _started = True
    if FROZEN:
        try:
            copy_licences(LICENCES, HOME / "licenses")
        except OSError as e:
            print(f"Copying the licence texts failed: {e}")
    if not FROZEN or not needed(ARCHIVE, ENGINE_DIR):
        _ready.set()
        return
    threading.Thread(target=_run, daemon=True, name="unpack-engines").start()


def busy() -> bool:
    """True while the engines are being unpacked."""
    return _started and not _ready.is_set()


def wait() -> None:
    """Block until the engines are in place (returns at once when there is nothing to unpack)."""
    if not _started:
        start()
    _ready.wait()


def includes(prefix: str) -> bool:
    """Does the bundled archive contain files under this folder (e.g. "lc0/")?"""
    if not (FROZEN and ARCHIVE.is_file()):
        return False
    with zipfile.ZipFile(ARCHIVE) as z:
        return any(n.replace("\\", "/").startswith(prefix) for n in z.namelist())
