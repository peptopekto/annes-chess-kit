"""Paths and persisted user settings."""
import json
import os
import sys
import threading
import time
from pathlib import Path

APP_FOLDER = "AnnesChessKit"


def choose_home(exe_dir: Path, local_appdata: Path) -> Path:
    """Where the single-file app keeps its data (userdata/) and unpacked engines (engine/).

    1. A userdata folder next to AnnesChessKit.exe: the portable way. It is also where the zip download and
       the installer of version 1.0.2 and older keep their data, so dropping the exe into such a folder
       carries on with the same data.
    2. Otherwise the per-user folder %LOCALAPPDATA%\\AnnesChessKit – unless only an installed copy has data
       (%LOCALAPPDATA%\\Programs\\AnnesChessKit\\userdata, from the installer of 1.0.2 and older): then the
       exe uses that, so you keep one set of data.
    """
    if (exe_dir / "userdata").is_dir():
        return exe_dir
    own = local_appdata / APP_FOLDER
    installed = local_appdata / "Programs" / APP_FOLDER
    if not (own / "userdata").is_dir() and (installed / "userdata").is_dir():
        return installed
    return own


# Run from the single-file AnnesChessKit.exe (PyInstaller), the program files are unpacked to a temporary
# folder for each run (BUNDLE) and the data lives elsewhere (HOME). From the source folder both are the folder.
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    BUNDLE = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    ROOT = Path(sys.executable).resolve().parent
    _local = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    # CHESSKIT_HOME: somewhere else entirely (the build's self-test uses a scratch folder).
    HOME = Path(os.environ["CHESSKIT_HOME"]) if os.environ.get("CHESSKIT_HOME") else choose_home(ROOT, Path(_local))
else:
    ROOT = Path(__file__).resolve().parents[2]
    BUNDLE = ROOT
    HOME = ROOT
BACKEND = BUNDLE / "backend"
DATA = BACKEND / "data"
# Override with CHESSKIT_USERDATA (e.g. to try things on a copy of your data); BRILLIANT_USERDATA, the old name, still works.
USERDATA = Path(os.environ.get("CHESSKIT_USERDATA") or os.environ.get("BRILLIANT_USERDATA") or HOME / "userdata")
GAMES_DIR = USERDATA / "games"
SETS_DIR = USERDATA / "woodpecker_sets"
SETTINGS_FILE = USERDATA / "settings.json"
FRONTEND_DIST = BUNDLE / "frontend" / "dist"
ENGINE_DIR = HOME / "engine"
# A Stockfish somewhere else (otherwise engine/ is searched, then the PATH).
STOCKFISH_PATH = os.environ.get("STOCKFISH_PATH") or None

for d in (USERDATA, GAMES_DIR, SETS_DIR):
    d.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS = {
    "chesscom_username": "",
    "lichess_username": "",
    # Extra names you play under (e.g. OTB name in PGNs). Matched case-insensitively.
    "aliases": [],
    # How reviews search each position: a fixed depth, or a time per move (up to max_depth).
    "analysis_mode": "depth",   # depth | time
    "depth": 16,
    "move_time": 1.0,           # seconds per move (time mode)
    "max_depth": 30,            # time mode: never deeper than this
    "engine_threads": 0,        # analysis engines (one CPU thread each); 0 = all but two

    "sounds": True,
    "volume": 0.6,
    # How many recent games "Analyze last N" queues up.
    "batch_size": 10,
    # The Lichess puzzle database (https://database.lichess.org/#puzzles), unpacked, for Woodpecker sets.
    "puzzle_csv": str(USERDATA / "lichess_db_puzzle.csv"),
}


def replace_file(tmp: Path, target: Path) -> None:
    """os.replace that copes with Windows: the target can't be replaced while another thread (or a virus
    scanner / search indexer) has it open for a moment – wait briefly and try again instead of failing."""
    for attempt in range(8):
        try:
            os.replace(tmp, target)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.02 * (attempt + 1))


def write_atomic(path: Path, data: str | bytes) -> None:
    """Write a file so that it is either the old or the new version – never half-written (a crash or power
    cut mid-write would otherwise leave a broken file, which reads as "no data" and is then overwritten)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        if isinstance(data, bytes):
            tmp.write_bytes(data)
        else:
            tmp.write_text(data, encoding="utf-8")
        replace_file(tmp, path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def load_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    if SETTINGS_FILE.exists():
        try:
            settings.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            pass
    return settings


def _clean(key: str, value, current):
    """Keep a setting in its valid range (a bad value keeps the current one)."""
    def num(lo, hi, cast=float):
        try:
            return max(lo, min(hi, cast(value)))
        except (TypeError, ValueError):
            return current
    if key == "analysis_mode":
        return value if value in ("depth", "time") else current
    if key == "depth":
        return num(8, 30, int)
    if key == "max_depth":
        return num(10, 40, int)
    if key == "move_time":
        return round(num(0.1, 10.0), 2)
    if key == "engine_threads":
        return num(0, os.cpu_count() or 4, int)
    if key == "batch_size":
        return num(1, 500, int)  # the library picker goes up to 500
    if key == "volume":
        return num(0.0, 1.0)
    if key == "aliases":
        return [str(a).strip() for a in value if str(a).strip()] if isinstance(value, list) else current
    if key == "sounds":
        return bool(value)
    return value if isinstance(value, str) else current


def save_settings(patch: dict) -> dict:
    settings = load_settings()
    old = {k: settings.get(k, "") for k in ("chesscom_username", "lichess_username")}
    settings.update({k: _clean(k, v, settings[k]) for k, v in patch.items() if k in DEFAULT_SETTINGS})
    # A renamed account: keep the old name, so games played under it still count as yours.
    for k, before in old.items():
        before = (before or "").strip()
        now = (settings.get(k) or "").strip()
        if before and now and before.lower() != now.lower() \
                and before.lower() not in {a.lower() for a in settings["aliases"]}:
            settings["aliases"] = [*settings["aliases"], before]
    current = {(settings.get(k) or "").strip().lower() for k in old}
    settings["aliases"] = [a for a in settings["aliases"] if a.lower() not in current]  # a main name isn't an alias
    write_atomic(SETTINGS_FILE, json.dumps(settings, indent=2))
    return settings


_names_cache: tuple | None = None  # (settings mtime, names)


def my_names(settings: dict | None = None) -> set[str]:
    """Your usernames (lower-case). Called on most requests: cached until settings.json changes."""
    global _names_cache
    if settings is None:
        try:
            mtime = SETTINGS_FILE.stat().st_mtime
        except OSError:
            mtime = None
        if _names_cache and _names_cache[0] == mtime:
            return set(_names_cache[1])
        names = _names_from(load_settings())
        _names_cache = (mtime, frozenset(names))
        return names
    return _names_from(settings)


def _names_from(s: dict) -> set[str]:
    names = {s.get("chesscom_username", ""), s.get("lichess_username", ""), *s.get("aliases", [])}
    return {n.strip().lower() for n in names if n and n.strip()}
