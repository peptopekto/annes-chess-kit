"""Local copy of your whole Chess.com / Lichess game history.

The first sync downloads everything (in the background, with progress); later
syncs only fetch what's new. The import list is served from disk, so it opens
instantly and survives restarts.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from . import analysis, importers, storage
from .config import USERDATA, write_atomic

LIB_DIR = USERDATA / "imports"
LIB_DIR.mkdir(parents=True, exist_ok=True)
SOURCES = ("chesscom", "lichess")
# Fields sent to the UI (the PGN stays on the server until a game is queued).
LIST_KEYS = ("url", "white", "black", "whiteElo", "blackElo", "myColor", "outcome", "timeClass", "endTime",
             "moves", "source", "id")

_lock = threading.Lock()
_mem: dict[str, dict] = {}       # key -> {"games": [...], "syncedAt": ts}
_status: dict[str, dict] = {}    # key -> {"state", "fetched", "error"}


def _key(source: str, user: str) -> str:
    if source not in SOURCES:
        raise ValueError("unknown source")
    clean = re.sub(r"[^a-z0-9_-]", "", user.strip().lower())
    if not clean:
        raise ValueError("bad username")
    return f"{source}-{clean}"


def _file(key: str) -> Path:
    return LIB_DIR / f"{key}.json"


def _load(key: str) -> dict:
    with _lock:
        if key not in _mem:
            f = _file(key)
            data = {"games": [], "syncedAt": None}
            if f.exists():
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    pass
            _mem[key] = data
        return _mem[key]


def _save(key: str, data: dict) -> None:
    f = _file(key)
    write_atomic(f, json.dumps(data))


def _with_id(g: dict) -> dict:
    """Attach our review id (same hash the analyser uses) so reviewed games can be matched."""
    parsed = analysis.read_games(g["pgn"], limit=1)
    g["id"] = analysis.game_id(parsed[0]) if parsed else None
    return g


def _merge(key: str, new: list[dict]) -> int:
    data = _load(key)
    with _lock:
        have = {g["url"] for g in data["games"]}
    # Parsing PGNs is slow – do it outside the lock so the list stays responsive during a sync.
    fresh = [_with_id(g) for g in new if g["url"] not in have]
    with _lock:
        have = {g["url"] for g in data["games"]}
        fresh = [g for g in fresh if g["url"] not in have]
        if fresh:
            data["games"] = sorted(data["games"] + fresh, key=lambda g: g.get("endTime") or 0, reverse=True)
        return len(fresh)


# --------------------------------------------------------------------------- #
#  API
# --------------------------------------------------------------------------- #

def listing(source: str, user: str) -> dict:
    key = _key(source, user)
    data = _load(key)
    reviews = storage.review_index()
    games = []
    for g in data["games"]:
        row = {k: g.get(k) for k in LIST_KEYS}
        rev = reviews.get(g.get("id") or "")
        row["review"] = {"id": g["id"], "accuracy": rev["accuracy"]} if rev else None
        games.append(row)
    return {"games": games, "syncedAt": data.get("syncedAt"), "status": status(source, user)}


def status(source: str, user: str) -> dict:
    return _status.get(_key(source, user), {"state": "idle", "fetched": 0, "error": None})


def pgns(source: str, user: str, urls: list[str]) -> list[dict]:
    """Queue-ready games for the given URLs (in the order given)."""
    data = _load(_key(source, user))
    by_url = {g["url"]: g for g in data["games"]}
    out = []
    for u in urls:
        g = by_url.get(u)
        if g:
            opp = g["black"] if g["myColor"] == "w" else g["white"]
            out.append({"pgn": g["pgn"], "url": u, "source": g["source"], "id": g.get("id"),
                        "title": f"vs {opp} ({g['timeClass']})"})
    return out


def start_sync(source: str, user: str, full: bool = False) -> dict:
    key = _key(source, user)
    with _lock:
        if _status.get(key, {}).get("state") == "syncing":
            return _status[key]
        _status[key] = {"state": "syncing", "fetched": 0, "error": None}
    threading.Thread(target=_sync, args=(source, user, key, full), daemon=True, name=f"sync-{key}").start()
    return _status[key]


def _sync(source: str, user: str, key: str, full: bool) -> None:
    st = _status[key]
    data = _load(key)
    try:
        if source == "lichess":
            newest = max((g.get("createdAt") or 0 for g in data["games"]), default=0)
            batch: list[dict] = []
            for g in importers.lichess_stream(user, since_ms=None if full or not newest else newest + 1):
                batch.append(g)
                st["fetched"] += 1
                if len(batch) >= 50:  # show progress in the list as it arrives
                    _merge(key, batch)
                    batch = []
            _merge(key, batch)
        else:
            newest = max((g.get("endTime") or 0 for g in data["games"]), default=0)
            cutoff = time.strftime("%Y/%m", time.gmtime(newest)) if newest and not full else None
            with importers.chesscom_client() as client:
                for url in reversed(importers.chesscom_archives(client, user)):
                    month = url.rstrip("/")[-7:]  # "YYYY/MM"
                    if cutoff and month < cutoff:
                        break  # everything older is already here
                    st["fetched"] += _merge(key, importers.chesscom_month(client, url, user))
        with _lock:
            data["syncedAt"] = int(time.time())
        _save(key, data)
        st["state"] = "idle"
    except Exception as e:  # shown in the UI; partial results are kept
        _save(key, data)
        st["state"], st["error"] = "error", str(e)
