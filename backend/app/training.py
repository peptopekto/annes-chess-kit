"""Training log: what you practised each day, your daily goal and streak, and pattern mastery.

Every trainer reports here (puzzles, blunder-check cards, opening positions, endgame drills, Nightmare
games), so one daily goal and one streak cover all practice. Points are a rough measure of effort:

    puzzle solved 1 (+1 on the first try) · blunder-check card 1 · opening position 1
    endgame drill 3 (+2 when won) · Nightmare game 5

"Mastery" connects practice with your games: for each recurring pattern (see woodpecker.patterns)
it shows how well you solve its puzzles *and* how often the mistake still happens in your games –
practice only counts if the second number goes down.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import date, timedelta

from .config import USERDATA, write_atomic

FILE = USERDATA / "training.json"
GOALS = (10, 20, 40, 60)
DEFAULT_GOAL = 20
STREAK_MILESTONES = (3, 7, 14, 30, 60, 100, 200, 365)
POINTS = {"puzzle": 1, "puzzle_first": 1, "safety": 1, "opening": 1, "endgame": 3, "endgame_won": 2, "nightmare": 5}
RECENT_GAMES = 50      # "lately" in your games, for the pattern trend
BEFORE_GAMES = 200     # compared with the games before that

_lock = threading.Lock()


def _today() -> str:
    return date.today().isoformat()


def _read() -> dict:
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    data.setdefault("goal", DEFAULT_GOAL)
    data.setdefault("days", {})
    data.setdefault("bestStreak", 0)
    return data


def _write(data: dict) -> None:
    write_atomic(FILE, json.dumps(data))


def log(kind: str, n: int = 1, *, first: int = 0, won: int = 0, seconds: float = 0.0,
        patterns: dict[str, tuple[int, int]] | None = None) -> None:
    """Record practice. `patterns`: pattern key -> (puzzles solved, solved on the first try)."""
    if n <= 0:
        return
    with _lock:
        data = _read()
        day = data["days"].setdefault(_today(), {"points": 0, "counts": {}, "seconds": 0, "patterns": {}})
        day["counts"][kind] = day["counts"].get(kind, 0) + n
        day["points"] += n * POINTS.get(kind, 1) + first * POINTS["puzzle_first"] + won * POINTS["endgame_won"]
        day["seconds"] = round(day.get("seconds", 0) + max(0.0, seconds))
        for key, (solved, clean) in (patterns or {}).items():
            pt = day["patterns"].setdefault(key, [0, 0])
            pt[0] += solved
            pt[1] += clean
        data["bestStreak"] = max(data["bestStreak"], _streak(data)[0])
        _write(data)


def set_goal(goal: int) -> dict:
    with _lock:
        data = _read()
        data["goal"] = goal if goal in GOALS else DEFAULT_GOAL
        _write(data)
    return summary()


def _streak(data: dict) -> tuple[int, bool]:
    """(days in a row the goal was met, whether today is one of them). Today still open doesn't break it."""
    goal = data["goal"]
    met = lambda d: data["days"].get(d.isoformat(), {}).get("points", 0) >= goal  # noqa: E731
    today = date.today()
    done_today = met(today)
    d = today if done_today else today - timedelta(days=1)
    n = 0
    while met(d):
        n += 1
        d -= timedelta(days=1)
    return n, done_today


def summary(games=None) -> dict:
    data = _read()
    goal = data["goal"]
    streak, done_today = _streak(data)
    today = data["days"].get(_today(), {"points": 0, "counts": {}, "seconds": 0})
    start = date.today() - timedelta(days=7 * 12 - 1)
    calendar = [{"day": (start + timedelta(days=i)).isoformat(),
                 "points": data["days"].get((start + timedelta(days=i)).isoformat(), {}).get("points", 0)}
                for i in range(7 * 12)]
    week = sum(c["points"] for c in calendar[-7:])
    next_milestone = next((m for m in STREAK_MILESTONES if m > streak), None)
    return {
        "goal": goal, "goals": list(GOALS),
        "today": {"points": today.get("points", 0), "counts": today.get("counts", {}),
                  "minutes": round(today.get("seconds", 0) / 60)},
        "goalMet": done_today, "streak": streak, "bestStreak": max(data["bestStreak"], streak),
        "nextMilestone": next_milestone, "week": week,
        "daysTrained": sum(1 for d in data["days"].values() if d.get("points", 0) > 0),
        "calendar": calendar,
        "mastery": mastery(data, games),
    }


def mastery(data: dict | None = None, games=None) -> list[dict]:
    """Per recurring pattern: how you do in its puzzles, and how often it still happens in your games."""
    from . import insights, woodpecker

    data = data or _read()
    games = sorted(insights._games() if games is None else games, key=lambda g: g.ts)
    if not games:
        return []
    stats, _ = woodpecker.patterns(games)
    recent, before = games[-RECENT_GAMES:], games[-(RECENT_GAMES + BEFORE_GAMES):-RECENT_GAMES]

    def per_game(gs) -> dict[str, float]:
        counts: dict[str, int] = {}
        for g in gs:
            for m in g.moves:
                if m["cls"] in ("mistake", "blunder", "miss") and m["loss"] >= 0.08:
                    for k in woodpecker.pattern_keys(m):
                        counts[k] = counts.get(k, 0) + 1
        return {k: v / len(gs) for k, v in counts.items()} if gs else {}

    now_rate, before_rate = per_game(recent), per_game(before)
    practised: dict[str, list[int]] = {}
    for day in data["days"].values():
        for k, (solved, clean) in (day.get("patterns") or {}).items():
            p = practised.setdefault(k, [0, 0])
            p[0] += solved
            p[1] += clean
    out = []
    for key, st in stats.items():
        if st["count"] < woodpecker.MIN_REPEAT:
            continue
        solved, clean = practised.get(key, [0, 0])
        now, prev = now_rate.get(key, 0.0), before_rate.get(key)
        out.append({
            "key": key, "label": woodpecker.PATTERN_LABELS.get(key, key),
            "mistakes": st["count"], "weight": round(st["weight"], 3),
            "solved": solved, "firstTry": round(clean / solved * 100) if solved else None,
            "perGame": round(now, 2), "perGameBefore": round(prev, 2) if prev is not None and before else None,
        })
    out.sort(key=lambda m: -m["weight"])
    return out


# --------------------------------------------------------------------------- #
#  Hooks for the trainers
# --------------------------------------------------------------------------- #

def woodpecker_progress(puzzles: list[dict], old: dict | None, new: dict | None, final: bool = False) -> None:
    """A Woodpecker run moved on: log the puzzles finished since the last save (with their patterns)."""
    old_data = ((old or {}).get("stats") or {}).get("puzzles_data") or {}
    new_stats = new if final else (new or {}).get("stats")  # a finished run sends its stats directly
    new_data = (new_stats or {}).get("puzzles_data") or {}
    fresh = [pid for pid in new_data if pid not in old_data]
    if not fresh:
        return
    by_id = {p.get("id"): p for p in puzzles}
    first = sum(1 for pid in fresh if new_data[pid].get("correct_first"))
    pats: dict[str, tuple[int, int]] = {}
    for pid in fresh:
        key = ((by_id.get(pid) or {}).get("pattern") or {}).get("key")
        if key:
            s, c = pats.get(key, (0, 0))
            pats[key] = (s + 1, c + (1 if new_data[pid].get("correct_first") else 0))
    seconds = sum(float(new_data[pid].get("time") or 0) for pid in fresh)
    log("puzzle", len(fresh), first=first, seconds=seconds, patterns=pats)

