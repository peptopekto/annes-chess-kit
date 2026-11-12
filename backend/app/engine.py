"""Thread-safe wrapper around a native Stockfish process (python-chess UCI)."""
from __future__ import annotations

import os
import queue
import shutil
import subprocess
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

import chess
import chess.engine

from .config import ENGINE_DIR, STOCKFISH_PATH


# Engines are console programs: started from the windowless app (pythonw) each one would open its own
# console window. This keeps them invisible.
NO_WINDOW: dict = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}

_chosen: Path | None = None
_choose_lock = threading.Lock()


def find_binary(name: str, folder: Path, preferred: tuple[str, ...] = ()) -> list[Path]:
    """Candidates for an engine binary: `folder/<preferred…>`, then any `folder/<name>*`, then the PATH.

    Works with Windows (.exe) and macOS/Linux names, e.g. stockfish-windows-x86-64-avx2.exe or stockfish.
    """
    exe = ".exe" if sys.platform == "win32" else ""
    out: list[Path] = [folder / f"{p}{exe}" for p in preferred]
    if folder.is_dir():
        out += sorted(p for p in folder.iterdir() if p.is_file() and p.name.lower().startswith(name)
                      and (p.suffix.lower() == ".exe" if exe else os.access(p, os.X_OK)))
    on_path = shutil.which(name)
    if on_path:
        out.append(Path(on_path))
    seen: set[Path] = set()
    return [p for p in out if p.exists() and not (p in seen or seen.add(p))]


def engine_path() -> Path:
    """Fastest Stockfish build this CPU can run.

    The BMI2/AVX2 builds are ~2x faster than the generic SSE2 one but crash on
    CPUs without those instructions, so each candidate is probed once.
    """
    global _chosen
    with _choose_lock:
        if _chosen is None:
            if STOCKFISH_PATH:
                candidates = [Path(STOCKFISH_PATH)]
            else:
                # Fastest first: names with bmi2 / avx2 (as in the official downloads), then the rest.
                found = find_binary("stockfish", ENGINE_DIR)
                speed = lambda p: 0 if "bmi2" in p.name.lower() else 1 if "avx2" in p.name.lower() else 2  # noqa: E731
                candidates = sorted(found, key=speed)
            for c in candidates:
                if not c.exists():
                    continue
                try:
                    probe = chess.engine.SimpleEngine.popen_uci(str(c), timeout=10, **NO_WINDOW)
                    probe.analyse(chess.Board(), chess.engine.Limit(depth=4))
                    probe.quit()
                    _chosen = c
                    break
                except Exception:  # illegal instruction, missing DLL, …
                    continue
            if _chosen is None:
                raise RuntimeError(f"No working Stockfish found: put it in {ENGINE_DIR} (see engine/README.md) "
                                   "or set STOCKFISH_PATH.")
        return _chosen


class Engine:
    def __init__(self, threads: int, hash_mb: int, options: dict | None = None):
        self._lock = threading.Lock()
        self._engine: chess.engine.SimpleEngine | None = None
        self._options = {"Threads": threads, "Hash": hash_mb, **(options or {})}

    def _ensure(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self._engine = chess.engine.SimpleEngine.popen_uci(str(engine_path()), **NO_WINDOW)
            self._engine.configure(self._options)
        return self._engine

    def analyse(self, board: chess.Board, depth: int, multipv: int = 1,
                max_time: float | None = None,
                root_moves: list[chess.Move] | None = None, game: object = None) -> list[chess.engine.InfoDict]:
        limit = chess.engine.Limit(depth=depth, time=max_time)
        # A new `game` token makes python-chess send "ucinewgame" (clears the hash table),
        # so a block of positions is searched identically every time.
        kwargs = {"multipv": multipv, "root_moves": root_moves, "game": game}
        with self._lock:
            try:
                return self._ensure().analyse(board, limit, **kwargs)
            except (chess.engine.EngineTerminatedError, chess.engine.EngineError):
                # One retry with a fresh process (e.g. it crashed or was killed).
                self._engine = None
                return self._ensure().analyse(board, limit, **kwargs)

    def close(self) -> None:
        with self._lock:
            if self._engine is not None:
                try:
                    self._engine.quit()
                except chess.engine.EngineError:
                    pass
                self._engine = None


class EnginePool:
    """Several small engines searching different positions at once.

    Lazy-SMP scales poorly at review depths, so N engines x 4 threads give far
    more positions per second than one engine with every core.

    The pool can be resized while running (the "CPU use" setting): extra engines start lazily,
    surplus ones are shut down as soon as they're free.
    """

    def __init__(self, size: int, threads: int, hash_mb: int):
        self._threads, self._hash_mb = threads, hash_mb
        self._lock = threading.Lock()
        self.engines = [Engine(threads, hash_mb) for _ in range(max(1, size))]
        self.size = len(self.engines)
        self._free: queue.Queue[Engine] = queue.Queue()
        for e in self.engines:
            self._free.put(e)

    def resize(self, size: int) -> None:
        size = max(1, size)
        with self._lock:
            self.size = size
            while len(self.engines) < size:
                e = Engine(self._threads, self._hash_mb)
                self.engines.append(e)
                self._free.put(e)
            # Shut idle surplus engines down now; busy ones go when they're released.
            while len(self.engines) > size:
                try:
                    e = self._free.get_nowait()
                except queue.Empty:
                    break
                self.engines.remove(e)
                e.close()

    @contextmanager
    def acquire(self):
        eng = self._free.get()
        try:
            yield eng
        finally:
            with self._lock:
                retire = len(self.engines) > self.size
                if retire:
                    self.engines.remove(eng)
            if retire:
                eng.close()
            else:
                self._free.put(eng)

    def close(self) -> None:
        for e in list(self.engines):
            e.close()


CPUS = os.cpu_count() or 4
# Many single-threaded engines beat a few multi-threaded ones by ~2x at review
# depths (lazy-SMP overhead), and single-threaded searches are near-deterministic.
# Leave two hardware threads for the live engine (retry/explore) and the UI.
AUTO_ENGINES = max(1, CPUS - 2)


def engines_for(setting: int | None) -> int:
    """The "CPU use" setting (0 = automatic) as a number of analysis engines."""
    return AUTO_ENGINES if not setting else max(1, min(CPUS, int(setting)))


batch = EnginePool(size=AUTO_ENGINES, threads=1, hash_mb=32)
live = Engine(threads=4, hash_mb=128)
