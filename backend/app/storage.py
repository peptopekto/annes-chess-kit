"""Analysed-game library: one JSON file per game under userdata/games.

Everything list-like (summaries, highlights) is served from a per-file cache
that is only refreshed when a file changes, so thousands of reviews stay fast.
"""
from __future__ import annotations

import json
import os
import pickle
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import GAMES_DIR, my_names, write_atomic

SUMMARY_KEYS = ("id", "white", "black", "whiteElo", "blackElo", "result", "date", "timeControl",
                "plies", "opening", "me", "accuracy", "counts", "analysedAt", "source", "url", "depth", "moveTime", "depthReached", "version",
                "sacCheck", "specialCheck", "rateCheck")
HIGHLIGHT_CLASSES = ("brilliant", "great", "blunder", "mistake", "miss")
HIGHLIGHT_KEYS = ("ply", "san", "uci", "color", "cls", "fenBefore", "bestUci", "bestSan", "text", "loss")


def _path(game_id: str) -> Path:
    if not game_id.isalnum():
        raise ValueError("bad id")
    return GAMES_DIR / f"{game_id}.json"


_write_lock = threading.Lock()  # save() vs update(): a background fix-up never overwrites a fresh analysis


def save(record: dict) -> dict:
    record.setdefault("analysedAt", int(time.time()))
    p = _path(record["id"])
    with _write_lock:
        write_atomic(p, json.dumps(record))  # readers never see a half-written review
    return record


def update(game_id: str, fn) -> bool:
    """Load a review, let `fn(record)` change it (returns True if it did), and save – all under the write lock."""
    p = _path(game_id)
    with _write_lock:
        try:
            record = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if not fn(record):
            return False
        write_atomic(p, json.dumps(record))
    return True


def load(game_id: str) -> dict | None:
    p = _path(game_id)
    if not p.exists():
        return None
    record = json.loads(p.read_text(encoding="utf-8"))
    _refresh_me(record)
    return record


def delete(game_id: str) -> None:
    _path(game_id).unlink(missing_ok=True)


def _refresh_me(record: dict, names: set[str] | None = None) -> None:
    """Re-detect which side is "me" (usernames may have been set after analysis)."""
    names = names if names is not None else my_names()
    if record.get("white", "").lower() in names:
        record["me"] = "w"
    elif record.get("black", "").lower() in names:
        record["me"] = "b"


def played_at(record: dict) -> float:
    """When the game was played (PGN headers, UTC when available), else when it was analysed."""
    h = record.get("headers") or {}
    date = (h.get("UTCDate") or h.get("Date") or record.get("date") or "").replace("-", ".")
    clock = h.get("UTCTime") or h.get("StartTime") or "12:00:00"
    try:
        dt = datetime.strptime(f"{date} {clock[:8]}", "%Y.%m.%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return float(record.get("analysedAt") or 0)


# --------------------------------------------------------------------------- #
#  Per-file cache (kept on disk, so a cold start doesn't re-read every review)
# --------------------------------------------------------------------------- #

CACHE_VERSION = 1

_cache: dict[str, tuple[float, dict, list[dict]]] = {}  # id -> (mtime, summary, highlights)
_cache_lock = threading.Lock()
_build_lock = threading.Lock()  # one rebuild at a time; concurrent requests wait for it
_entries_snap: tuple | None = None  # (index, [(summary, highlights)]) – reused while no file changed
_disk_loaded = False
_disk_saved_at = 0.0
DISK_SAVE_EVERY = 60.0  # during a big batch a game finishes every few seconds: don't rewrite the cache each time


def _cache_file() -> Path:
    return GAMES_DIR.parent / "cache" / "summaries.pkl"


def index() -> list[tuple[str, float]]:
    """(id, mtime) of every stored review – no file reads (scandir gets mtimes from the listing: ~5 ms for 2k games)."""
    out = []
    try:
        with os.scandir(GAMES_DIR) as it:
            for e in it:
                if e.name.endswith(".json"):
                    try:
                        out.append((e.name[:-5], e.stat().st_mtime))
                    except OSError:
                        continue
    except OSError:
        pass
    return out


def _load_disk_cache() -> None:
    global _disk_loaded
    _disk_loaded = True
    try:
        with _cache_file().open("rb") as f:
            data = pickle.load(f)
        if data.get("version") == CACHE_VERSION:
            with _cache_lock:
                _cache.update(data["entries"])
    except (OSError, pickle.PickleError, EOFError, AttributeError, KeyError, TypeError):
        pass


def _save_disk_cache() -> None:
    try:
        target = _cache_file()
        with _cache_lock:
            payload = {"version": CACHE_VERSION, "entries": dict(_cache)}
        write_atomic(target, pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL))
    except OSError:
        pass


def _entry(gid: str, mtime: float) -> tuple[tuple[dict, list[dict]] | None, bool]:
    """(summary, highlights) for one review, and whether the file had to be read."""
    with _cache_lock:
        cached = _cache.get(gid)
    if cached and cached[0] == mtime:
        return (cached[1], cached[2]), False
    try:
        record = json.loads(_path(gid).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None, False
    summary = {k: record.get(k) for k in SUMMARY_KEYS}
    summary["playedAt"] = played_at(record)
    hl = [{k: m[k] for k in HIGHLIGHT_KEYS} for m in record.get("moves", []) if m["cls"] in HIGHLIGHT_CLASSES]
    with _cache_lock:
        _cache[gid] = (mtime, summary, hl)
    return (summary, hl), True


def _entries() -> list[tuple[dict, list[dict]]]:
    global _entries_snap, _disk_saved_at
    idx = index()
    snap = _entries_snap
    if snap and snap[0] == idx:
        return snap[1]
    with _build_lock:
        idx = index()
        snap = _entries_snap
        if snap and snap[0] == idx:
            return snap[1]  # another request just built it
        if not _disk_loaded:
            _load_disk_cache()
        live = {gid for gid, _ in idx}
        out, changed = [], False
        for gid, mtime in idx:
            e, read = _entry(gid, mtime)
            changed |= read
            if e:
                out.append(e)
        with _cache_lock:
            for gone in set(_cache) - live:
                del _cache[gone]
                changed = True
        if changed and time.monotonic() - _disk_saved_at >= DISK_SAVE_EVERY:
            # Throttled: a missed save only means a few files get re-read on the next start.
            _save_disk_cache()
            _disk_saved_at = time.monotonic()
        _entries_snap = (idx, out)
        return out


def warm() -> None:
    """Build the summary cache at startup so the first page load is instant."""
    try:
        _entries()
    except Exception:  # never take the server down over a cache
        pass


def summaries(limit: int | None = None) -> list[dict]:
    """Per-game summaries, most recently analysed first."""
    names = my_names()
    out = []
    for summary, _ in _entries():
        s = dict(summary)
        _refresh_me(s, names)
        out.append(s)
    out.sort(key=lambda r: r.get("analysedAt") or 0, reverse=True)
    return out[:limit] if limit else out


def review_index() -> dict[str, dict]:
    """game id -> {accuracy (yours, or White's), me, depth} for marking games as reviewed."""
    idx = {}
    for s in summaries():
        side = s.get("me") or "w"
        idx[s["id"]] = {"accuracy": (s.get("accuracy") or {}).get(side), "me": s.get("me"), "depth": s.get("depth") or 0,
                        "moveTime": s.get("moveTime"), "depthReached": s.get("depthReached")}
    return idx


def highlights(classes: tuple[str, ...] = HIGHLIGHT_CLASSES) -> list[dict]:
    """Your brilliant/great moves and mistakes (both sides if your username is unknown), newest game first."""
    names = my_names()
    out = []
    for summary, hl in _entries():
        s = dict(summary)
        _refresh_me(s, names)
        me = s.get("me")
        for m in hl:
            if m["cls"] in classes and (not me or m["color"] == me):
                out.append({"gameId": s["id"], "white": s.get("white"), "black": s.get("black"),
                            "date": s.get("date"), "playedAt": s["playedAt"], **m})
    out.sort(key=lambda h: (-h["playedAt"], h["ply"]))
    return out


def load_many(ids) -> dict[str, dict]:
    out = {}
    for gid in ids:
        try:
            r = load(gid)
        except ValueError:
            continue
        if r:
            out[gid] = r
    return out
