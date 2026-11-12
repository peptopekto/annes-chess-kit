"""Instructive bot: XP, levels, statistics and a collection of your best moves – a benchmark you can reset.

Every finished (non-practice) game against the bot is scored: the result against the bot's strength gives XP,
your moves (rated live, or quickly at the end) give the statistics, and your Brilliant and Great moves go into
the collection. Everything lives in userdata/bot_progress.json; "Reset" deletes only that file – the games
themselves (Bot games list, reviews) stay.
"""
from __future__ import annotations

import json
import math
import threading
import time
from collections import Counter

import chess

from . import analysis
from . import classify as C
from .config import USERDATA, write_atomic

FILE = USERDATA / "bot_progress.json"
COLLECT = (C.BRILLIANT, C.GREAT)       # moves that go into the collection
GOOD = {C.BRILLIANT, C.GREAT, C.BEST, C.EXCELLENT, C.GOOD, C.BOOK, C.FORCED}
BAD = {C.INACCURACY, C.MISTAKE, C.MISS, C.BLUNDER}
SCORE_DEPTH = 10                       # quick search for moves that weren't rated during the game
MAX_GAMES, MAX_COLLECTION = 2000, 500

# XP: the result, scaled by how strong the bot was compared with you.
BASE_XP = {"win": 100, "draw": 40, "loss": 10}
MOVE_XP = {C.BRILLIANT: 25, C.GREAT: 10}
CLEAN_XP = 20                          # no mistake, miss or blunder in the whole game
TAKEBACK_FACTOR = 0.5                  # games with takebacks or engine exploring count half

TITLES = ["Beginner", "Novice", "Apprentice", "Learner", "Club player", "Tournament player", "Expert",
          "Candidate master", "Master", "International master", "Grandmaster"]

_lock = threading.Lock()


def _empty() -> dict:
    return {"xp": 0, "games": [], "collection": [], "since": int(time.time())}


def _read() -> dict:
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
        data = {**_empty(), **data}
        data["collection"] = _unique(data["collection"])
        return data
    except (OSError, ValueError):
        return _empty()


def _unique(collection: list[dict]) -> list[dict]:
    """The same move in the same position once (the first time you found it) – also cleans older files."""
    seen, out = set(), []
    for c in collection:
        k = (c.get("fen"), c.get("uci"))
        if k not in seen:
            seen.add(k)
            out.append(c)
    return out


def _write(data: dict) -> None:
    write_atomic(FILE, json.dumps(data))


# --------------------------------------------------------------------------- #
#  Levels
# --------------------------------------------------------------------------- #

def xp_for_level(level: int) -> int:
    """Total XP needed to reach `level` (1 → 0, 2 → 100, 3 → 300, 4 → 600, …: each level 100 XP more)."""
    return 50 * level * (level - 1)


def level_of(xp: int) -> int:
    return int((1 + math.sqrt(1 + 8 * max(0, xp) / 100)) / 2)


def level_info(xp: int) -> dict:
    lv = level_of(xp)
    lo, hi = xp_for_level(lv), xp_for_level(lv + 1)
    return {"level": lv, "title": TITLES[min(lv - 1, len(TITLES) - 1)], "xp": xp,
            "into": xp - lo, "needed": hi - lo, "next": hi}


def difficulty(strength: int) -> float:
    """How much a result against this bot is worth: ×0.5 at 200 below your level, ×1 at your level, ×2 at +400."""
    return round(max(0.4, min(2.5, 1 + strength / 400)), 2)


def game_xp(result: str, strength: int, counts: dict[str, int], takebacks: int, explored: bool = False) -> int:
    xp = BASE_XP[result] * difficulty(strength)
    xp += sum(MOVE_XP.get(c, 0) * n for c, n in counts.items())
    if counts and not any(counts.get(c, 0) for c in (C.MISTAKE, C.MISS, C.BLUNDER)):
        xp += CLEAN_XP
    if takebacks or explored:   # one help or several: half either way
        xp *= TAKEBACK_FACTOR
    return int(round(xp))


def _accuracy(losses: list[float]) -> float | None:
    """Average per-move accuracy from the expected points each move lost (same curve as the reviews)."""
    if not losses:
        return None
    return round(sum(C.move_accuracy(100.0, 100.0 - 100 * max(0.0, x)) for x in losses) / len(losses), 1)


# --------------------------------------------------------------------------- #
#  Recording a game
# --------------------------------------------------------------------------- #

def _rate_missing(pgn: str, color: str, marks: dict[int, dict]) -> dict[int, dict]:
    """Your moves without a live rating get a quick one now (so every game has full statistics)."""
    games = analysis.read_games(pgn, limit=1)
    if not games:
        return marks
    board = games[0].board()
    me = chess.WHITE if color == "w" else chess.BLACK
    out = dict(marks)
    prev_uci = None
    for ply, move in enumerate(games[0].mainline_moves(), 1):
        if board.turn == me:
            m = out.get(ply)
            if not m or m.get("uci") != move.uci():
                prev_loss = (out.get(ply - 1) or {}).get("loss")  # the bot's last move, if it was rated (for "Miss")
                try:
                    r = analysis.check_move(board.fen(), move.uci(), SCORE_DEPTH, None, prev_uci, prev_loss, book=True)
                    m = out[ply] = {"uci": move.uci(), "cls": r["cls"], "loss": r["loss"]}
                except Exception:  # no engine, odd position: the move just isn't counted
                    out.pop(ply, None)
                    m = None
            if m:
                m["san"], m["fen"] = board.san(move), board.fen()
        prev_uci = move.uci()
        board.push(move)
    return out


def record(result: str, color: str, maia_level: int, strength: int, focus: float, pgn: str | None,
           marks: dict[int, dict] | None, takebacks: int = 0, mode: str = "game", spot: str | None = None,
           explored: bool = False) -> dict:
    """Score a finished game: XP, statistics, new collection entries. Returns what changed (for the debrief).

    A Convert-your-wins position pays its XP once: playing it again only pays what you earn above your best
    result there so far (a clean win after a win with takebacks pays the difference, the same win again nothing).
    """
    marks = {int(k): v for k, v in (marks or {}).items()}
    first = _first_mover(pgn) if pgn else "w"   # a game from a set-up position may start with Black to move
    if pgn:
        marks = _rate_missing(pgn, color, marks)
    mine = {p: m for p, m in marks.items() if (p % 2 == 1) == (color == first) and m.get("cls")}
    counts = Counter(m["cls"] for m in mine.values())
    losses = [float(m.get("loss") or 0) for m in mine.values() if m["cls"] not in (C.BOOK, C.FORCED)]
    earned = game_xp(result, strength, counts, takebacks, explored)
    now = int(time.time())
    spot = spot if mode == "convert" and spot else None
    with _lock:
        data = _read()
        before = level_info(data["xp"])
        best = data.setdefault("convertBest", {})
        previous = int(best.get(spot, 0)) if spot else 0
        xp = max(0, earned - previous)
        if spot:
            best[spot] = max(previous, earned)
        data["xp"] += xp
        game = {"at": now, "mode": mode, "result": result, "color": color, "maia": maia_level, "strength": strength,
                "focus": focus, "takebacks": takebacks, "explored": explored, "moves": len(mine), "counts": dict(counts),
                "accuracy": _accuracy(losses), "xp": xp, "earned": earned}
        if spot:
            game["spot"] = spot
        data["games"] = (data["games"] + [game])[-MAX_GAMES:]
        have = {(c.get("fen"), c.get("uci")) for c in data["collection"]}
        new = []
        for p, m in sorted(mine.items()):
            if m["cls"] in COLLECT and m.get("fen") and (m["fen"], m["uci"]) not in have:  # the same move twice: once
                have.add((m["fen"], m["uci"]))
                new.append({"at": now, "ply": p, "fen": m["fen"], "san": m.get("san"), "uci": m["uci"],
                            "cls": m["cls"], "maia": maia_level, "color": color})
        data["collection"] = (data["collection"] + new)[-MAX_COLLECTION:]
        _write(data)
        after = level_info(data["xp"])
    return {"gained": xp, "earned": earned, "previous": previous if spot else None, "repeat": bool(spot and previous),
            "before": before, "after": after, "levelUp": after["level"] > before["level"],
            "game": game, "collected": new, "difficulty": difficulty(strength)}


def convert_status() -> dict[str, dict]:
    """Per Convert-your-wins position you played: attempts, best result and the XP it has paid so far."""
    data = _read()
    out: dict[str, dict] = {}
    rank = {"loss": 0, "draw": 1, "win": 2}
    for g in data["games"]:
        s = g.get("spot")
        if g.get("mode") != "convert" or not s:
            continue
        o = out.setdefault(s, {"tries": 0, "best": None, "xp": 0})
        o["tries"] += 1
        if o["best"] is None or rank[g["result"]] > rank[o["best"]]:
            o["best"] = g["result"]
    for s, xp in (data.get("convertBest") or {}).items():
        out.setdefault(s, {"tries": 0, "best": None, "xp": 0})["xp"] = xp
    return out


def _first_mover(pgn: str) -> str:
    games = analysis.read_games(pgn, limit=1)
    return "w" if not games or games[0].board().turn == chess.WHITE else "b"


def reset() -> dict:
    with _lock:
        try:
            FILE.unlink()
        except FileNotFoundError:
            pass
    return summary()


# --------------------------------------------------------------------------- #
#  The benchmark
# --------------------------------------------------------------------------- #

ACHIEVEMENTS = [
    ("first-win", "First win", "Beat the bot once"),
    ("clean", "Clean game", "A game without a mistake, miss or blunder"),
    ("brilliant", "Brilliant!", "Find a Brilliant move against the bot"),
    ("streak-3", "On a roll", "Win 3 games in a row"),
    ("streak-5", "Unstoppable", "Win 5 games in a row"),
    ("above", "Giant killer", "Beat the bot set 200 or more above your level"),
    ("no-takebacks-10", "No second chances", "10 games without a takeback"),
    ("games-50", "Regular", "Play 50 games against the bot"),
    ("convert-1", "Converted", "Win a position you once lost from (Convert your wins)"),
    ("convert-10", "Closer", "Convert 10 won positions"),
]


def summary() -> dict:
    data = _read()
    games = data["games"]
    wins = [g for g in games if g["result"] == "win"]
    record_ = {"played": len(games), "won": len(wins), "drawn": sum(g["result"] == "draw" for g in games),
               "lost": sum(g["result"] == "loss" for g in games)}
    # streaks
    cur = best = 0
    for g in games:
        cur = cur + 1 if g["result"] == "win" else 0
        best = max(best, cur)
    totals = Counter()
    for g in games:
        totals.update(g.get("counts") or {})
    moves = sum(totals.values())
    accs = [g["accuracy"] for g in games if g.get("accuracy") is not None]
    by_level: dict[int, dict] = {}
    for g in games:
        b = by_level.setdefault(g["maia"], {"maia": g["maia"], "games": 0, "points": 0.0, "acc": []})
        b["games"] += 1
        b["points"] += {"win": 1, "draw": 0.5, "loss": 0}[g["result"]]
        if g.get("accuracy") is not None:
            b["acc"].append(g["accuracy"])
    levels = [{"maia": b["maia"], "games": b["games"], "score": round(100 * b["points"] / b["games"], 1),
               "accuracy": round(sum(b["acc"]) / len(b["acc"]), 1) if b["acc"] else None}
              for b in sorted(by_level.values(), key=lambda b: b["maia"])]
    clean = [g for g in games if g.get("counts") and not any(g["counts"].get(c, 0) for c in (C.MISTAKE, C.MISS, C.BLUNDER))]
    conv = [g for g in games if g.get("mode") == "convert"]
    # Positions, not attempts: winning the same position again doesn't make it two conversions.
    key = lambda i, g: g.get("spot") or f"#{i}"
    won_spots = {key(i, g) for i, g in enumerate(conv) if g["result"] == "win"}
    convert = {"tried": len(conv), "positions": len({key(i, g) for i, g in enumerate(conv)}), "won": len(won_spots),
               "drawn": sum(g["result"] == "draw" for g in conv), "lost": sum(g["result"] == "loss" for g in conv)}
    earned = {
        "first-win": bool(wins),
        "clean": bool(clean),
        "brilliant": totals.get(C.BRILLIANT, 0) > 0,
        "streak-3": best >= 3,
        "streak-5": best >= 5,
        "above": any(g["strength"] >= 200 for g in wins),
        "no-takebacks-10": sum(not g.get("takebacks") for g in games) >= 10,
        "games-50": len(games) >= 50,
        "convert-1": convert["won"] >= 1,
        "convert-10": convert["won"] >= 10,
    }
    per_game = (lambda c: round(sum(g.get("counts", {}).get(c, 0) for g in games) / len(games), 2)) if games else (lambda c: None)
    return {
        **level_info(data["xp"]),
        "since": data.get("since"),
        "record": record_,
        "convert": convert,
        "streak": cur, "bestStreak": best,
        "bestWin": max((g["maia"] for g in wins), default=None),
        "accuracy": round(sum(accs) / len(accs), 1) if accs else None,
        "recentAccuracy": round(sum(accs[-10:]) / len(accs[-10:]), 1) if accs else None,
        "moves": moves,
        "counts": dict(totals),
        "goodShare": round(100 * sum(totals[c] for c in GOOD) / moves, 1) if moves else None,
        "badShare": round(100 * sum(totals[c] for c in BAD) / moves, 1) if moves else None,
        "perGame": {c: per_game(c) for c in (C.BRILLIANT, C.GREAT, C.INACCURACY, C.MISTAKE, C.MISS, C.BLUNDER)},
        "levels": levels,
        "recent": list(reversed(games[-15:])),
        "collection": list(reversed(data["collection"]))[:120],
        "collectionSize": len(data["collection"]),
        "achievements": [{"id": a, "name": n, "desc": d, "earned": earned[a]} for a, n, d in ACHIEVEMENTS],
    }
