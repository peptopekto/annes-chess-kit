"""Background analysis queue: single reviews and mass analysis share one worker.

Two games are analysed at a time: each game spreads over every engine in the pool, and a second
game fills the engines that go idle while the first one finishes its last positions (~15 % more
games per hour, identical results). Single "analyse now" requests jump the queue.
"""
from __future__ import annotations

import itertools
import threading
import time
from collections import deque
from dataclasses import dataclass, field

from . import analysis, storage


WORKERS = 2  # games analysed at the same time


class Cancelled(Exception):
    pass


@dataclass
class Job:
    id: int
    title: str
    pgn: str
    limits: analysis.Limits
    source: str | None = None
    url: str | None = None
    status: str = "queued"  # queued | running | done | error | cancelled
    done: int = 0
    total: int = 0
    fen: str | None = None
    game_id: str | None = None
    error: str | None = None
    summary: dict | None = None
    created: float = field(default_factory=time.time)
    cancel: bool = False
    key: str | None = None  # review id of the game (for de-duplication)
    priority: bool = False  # "analyse now": gets the engines to itself (no second game alongside)

    def public(self) -> dict:
        return {
            "id": self.id, "title": self.title, "status": self.status, "done": self.done, "total": self.total,
            "fen": self.fen, "gameId": self.game_id, "error": self.error, "summary": self.summary,
            "source": self.source, "url": self.url, "depth": self.limits.depth, "moveTime": self.limits.move_time,
        }


class AnalysisQueue:
    def __init__(self) -> None:
        self._jobs: dict[int, Job] = {}
        self._pending: deque[int] = deque()
        self._ids = itertools.count(1)
        self._cv = threading.Condition()
        self._workers: list[threading.Thread] = []

    # ---- API ---------------------------------------------------------------
    def add(self, games: list[dict], limits: analysis.Limits | int, front: bool = False, force: bool = False) -> list[dict]:
        if isinstance(limits, int):
            limits = analysis.Limits(depth=limits)
        out = []
        reviews = storage.review_index()  # cached summaries, no full reads
        addresses = storage.by_address(reviews)
        with self._cv:
            active = {j.key: j for j in self._jobs.values() if j.key and j.status in ("queued", "running")}
            new_ids = []
            for g in games:
                job = Job(id=next(self._ids), title=g.get("title") or "Game", pgn=g["pgn"], limits=limits,
                          source=g.get("source"), url=g.get("url"), priority=front and len(games) == 1)
                gid = g.get("id")
                if not gid:
                    parsed = analysis.read_games(job.pgn, limit=1)
                    gid = analysis.game_id(parsed[0]) if parsed else None
                if not gid:
                    job.status, job.error = "error", "Couldn't read this PGN."
                else:
                    cached = storage.find_review(reviews, addresses, gid, g.get("url"))
                    if cached and not force and limits.covers(cached):
                        job.status, job.game_id = "done", cached["id"]
                        job.summary = {"me": cached["me"], "accuracy": cached["accuracy"], "counts": {}}
                    else:
                        # Don't queue the same game twice; "analyse now" pulls a queued one forward.
                        dup = active.get(gid)
                        if dup:
                            if front and dup.status == "queued" and dup.id in self._pending:
                                self._pending.remove(dup.id)
                                self._pending.appendleft(dup.id)
                                dup.priority = len(games) == 1
                            out.append(dup.public())
                            continue
                        job.key = gid
                        active[gid] = job
                        new_ids.append(job.id)
                self._jobs[job.id] = job
                out.append(job.public())
            if front:
                self._pending.extendleft(reversed(new_ids))
            else:
                self._pending.extend(new_ids)
            self._ensure_worker()
            self._cv.notify_all()
        return out

    def list(self, recent_done: int = 30) -> dict:
        """Active jobs plus the most recent finished ones, and totals (stays small for huge batches)."""
        with self._cv:
            jobs = sorted(self._jobs.values(), key=lambda j: j.id)
            counts = {s: 0 for s in ("queued", "running", "done", "error", "cancelled")}
            for j in jobs:
                counts[j.status] += 1
            running = [j for j in jobs if j.status == "running"]
            queued = [j for j in jobs if j.status == "queued"]
            finished = [j for j in jobs if j.status not in ("queued", "running")][-recent_done:]
            shown = finished + running + queued[:50]
            return {"jobs": [j.public() for j in shown], "counts": counts}

    def get(self, job_id: int) -> dict | None:
        job = self._jobs.get(job_id)
        return job.public() if job else None

    def cancel(self, job_id: int | None = None) -> None:
        """Cancel one job, or everything queued/running when job_id is None."""
        with self._cv:
            for job in self._jobs.values():
                if (job_id is None or job.id == job_id) and job.status in ("queued", "running"):
                    job.cancel = True
                    if job.status == "queued":
                        job.status = "cancelled"
            self._pending = deque(i for i in self._pending if self._jobs[i].status == "queued")

    def clear_finished(self) -> None:
        with self._cv:
            self._jobs = {i: j for i, j in self._jobs.items() if j.status in ("queued", "running")}

    # ---- worker ------------------------------------------------------------
    def _ensure_worker(self) -> None:
        self._workers = [w for w in self._workers if w.is_alive()]
        while len(self._workers) < WORKERS:
            w = threading.Thread(target=self._run, daemon=True, name=f"analysis-queue-{len(self._workers) + 1}")
            w.start()
            self._workers.append(w)

    def _run(self) -> None:
        while True:
            with self._cv:
                # Wait for work – and don't start a second game while an "analyse now" game is running,
                # so the game you're waiting for has every engine.
                while not self._pending or (any(j.status == "running" and j.priority for j in self._jobs.values())
                                            and not self._jobs[self._pending[0]].priority):
                    self._cv.wait(timeout=1.0)
                job = self._jobs[self._pending.popleft()]
                if job.status != "queued":
                    continue
                job.status = "running"

            def progress(done: int, total: int, fen: str) -> None:
                if job.cancel:
                    raise Cancelled
                job.done, job.total, job.fen = done, total, fen

            try:
                record = analysis.analyse_game(job.pgn, job.limits, progress=progress)
                record["source"] = job.source
                real_url = job.url if job.url and job.url.startswith("http") else None
                record["url"] = real_url or record["headers"].get("Link") or record["headers"].get("Site")
                storage.save(record)
                storage._refresh_me(record)  # usernames may have changed since the analysis started
                job.game_id, job.summary, job.status = record["id"], _summary(record), "done"
            except Cancelled:
                job.status = "cancelled"
            except Exception as e:  # surfaced to the UI
                job.status, job.error = "error", str(e)


def _summary(record: dict | None) -> dict | None:
    if not record:
        return None
    me = record.get("me")
    side = me or "w"
    return {"me": me, "accuracy": record["accuracy"].get(side), "counts": record["counts"].get(side, {}),
            "white": record.get("white"), "black": record.get("black"), "result": record.get("result")}


queue = AnalysisQueue()
