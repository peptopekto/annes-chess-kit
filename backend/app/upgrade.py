"""Re-analysing reviews made with an older analysis version, in the background.

The analysis queue lives in memory, so a flag file remembers that an upgrade is under way:
closing the app halfway no longer loses it – it resumes with the remaining reviews on the next
start, until none are left or you cancel the queue.
"""
from __future__ import annotations

import json
import threading

from . import analysis, jobs, storage
from .config import USERDATA

FLAG = USERDATA / "upgrade.json"
_lock = threading.Lock()


def outdated() -> list[dict]:
    old = [s for s in storage.summaries() if (s.get("version") or 1) < analysis.ANALYSIS_VERSION]
    old.sort(key=lambda s: s.get("playedAt") or 0, reverse=True)  # newest games first
    return old


def active() -> bool:
    try:
        return bool(json.loads(FLAG.read_text(encoding="utf-8")).get("active"))
    except (OSError, json.JSONDecodeError):
        return False


def _set_active(on: bool) -> None:
    with _lock:
        if on:
            FLAG.write_text(json.dumps({"active": True}), encoding="utf-8")
        else:
            FLAG.unlink(missing_ok=True)


def _queue(old: list[dict]) -> None:
    # Loading every PGN takes a while for big libraries – queue in chunks so analysis starts right away.
    for start in range(0, len(old), 50):
        if not active():
            return  # cancelled meanwhile
        # Same limits as the old review (depth, or time per move).
        by_limits: dict[analysis.Limits, list[dict]] = {}
        for s in old[start:start + 50]:
            try:
                r = storage.load(s["id"])
            except ValueError:
                r = None
            if r:
                limits = analysis.Limits(depth=int(r.get("depth") or 16), move_time=r.get("moveTime"))
                by_limits.setdefault(limits, []).append(
                    {"pgn": r["pgn"], "title": f"{r.get('white')} vs {r.get('black')}", "source": r.get("source"),
                     "url": r.get("url"), "id": r["id"]})
        for limits, games in by_limits.items():
            jobs.queue.add(games, limits, force=True)


def start() -> int:
    """Queue every outdated review (remembered across restarts). Returns how many."""
    old = outdated()
    if not old:
        _set_active(False)
        return 0
    _set_active(True)
    threading.Thread(target=_queue, args=(old,), daemon=True, name="upgrade-reviews").start()
    return len(old)


def resume() -> None:
    """At startup: carry on with an upgrade that was interrupted by closing the app."""
    if active():
        start()


def stop() -> None:
    _set_active(False)
