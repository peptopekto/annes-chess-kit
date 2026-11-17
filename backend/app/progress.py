"""How far the slow, library-wide jobs are, so a page that waits for one can show a real progress bar.

A job registers itself under a short name ("insights", "peers" …), reports steps as it goes and is removed
when it ends. Pages poll /api/progress while they load. Jobs that finish within a fraction of a second (the
usual case once the caches are warm) are never seen, so nothing flickers.
"""
from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_tasks: dict[int, dict] = {}
_next = 0


class Task:
    """`with progress.track("insights", "Reading your reviews", total) as t: ... t.step(i)`"""

    def __init__(self, name: str, label: str, total: int = 0):
        global _next
        with _lock:
            _next += 1
            self.key = _next
            _tasks[self.key] = {"name": name, "label": label, "done": 0, "total": max(0, int(total)),
                                "started": time.time()}

    def step(self, done: int | None = None, total: int | None = None, label: str | None = None) -> None:
        t = _tasks.get(self.key)
        if t is None:
            return
        if done is not None:
            t["done"] = int(done)
        if total is not None:
            t["total"] = max(0, int(total))
        if label is not None:
            t["label"] = label

    def close(self) -> None:
        with _lock:
            _tasks.pop(self.key, None)

    def __enter__(self) -> "Task":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def track(name: str, label: str, total: int = 0) -> Task:
    return Task(name, label, total)


def snapshot() -> list[dict]:
    """Running jobs, newest first."""
    now = time.time()
    with _lock:
        tasks = [dict(t) for t in _tasks.values()]
    tasks.sort(key=lambda t: -t["started"])
    return [{"name": t["name"], "label": t["label"], "done": min(t["done"], t["total"]) if t["total"] else t["done"],
             "total": t["total"], "seconds": round(now - t["started"], 1)} for t in tasks]
