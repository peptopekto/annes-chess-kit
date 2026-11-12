"""You against the players at your rating: the same statistics for your moves and for your opponents' moves.

Every review already holds an engine verdict for every move of BOTH players, so your opponents are a free
reference group: thousands of games by people at, above and below your rating. For each game we measure both
sides the same way (accuracy, errors, mistake types, phases, clock, conversion, opening habits, positional
lessons), then compare you with

* your level – opponents within ±BAND of your rating in that game,
* stronger   – opponents BAND to 400 above you (where you're heading),
* weaker     – opponents BAND to 400 below you.

Rates are pooled over games (sum of counts / sum of moves); their uncertainty is the cluster-robust standard
error of a ratio estimator, so a difference is only called real when it is about twice its standard error.
Bot games (Nightmare) and games without ratings are left out.
"""
from __future__ import annotations

import math
import os
import pickle
import threading
import time
from collections import Counter, defaultdict

import chess

from . import classify as C
from . import concepts as K
from . import insights, positional, storage, tactics
from .config import USERDATA, my_names, write_atomic

BAND = 100            # "your level": opponents within this many points of your rating in that game
FAR = 400             # stronger / weaker: up to this far away
MIN_GAMES = 15        # fewer games in a group: no verdicts for it
Z_REAL = 2.0          # |difference| / standard error needed to call a difference real
WINNING, LOSING = insights.WINNING_PCT, insights.LOSING_PCT
LOW_CLOCK = 30        # seconds left that count as time trouble
PHASES = ("opening", "middlegame", "endgame")
SEVERE = {C.MISTAKE, C.BLUNDER, C.MISS}
ERRORS = {C.INACCURACY, C.MISTAKE, C.BLUNDER, C.MISS}
TOP = {C.BEST, C.GREAT, C.BRILLIANT}
BOT_SOURCES = {"nightmare"}

CACHE_FILE = USERDATA / "cache" / "peers.pkl"
CACHE_VERSION = 1
SAVE_EVERY = 60.0


# --------------------------------------------------------------------------- #
#  Per game: the same facts for both players (cached per review file)
# --------------------------------------------------------------------------- #

def _empty_side() -> dict:
    return {"n": 0, "acc": None, "loss": 0.0, "cls": Counter(), "tags": Counter(), "concepts": Counter(),
            "phase": {p: [0, 0.0, 0, 0.0] for p in PHASES},  # moves, accuracy sum, serious errors, loss sum
            "chances": 0, "punished": 0, "timed": 0, "spent": 0.0, "lowClock": 0, "lowClockErrors": 0,
            "firstError": None, "outcome": None, "winning": False, "losing": False, "onTime": False,
            "habits": None, "elo": None}


def _rating(raw) -> int | None:
    s = str(raw or "").strip()
    return int(s) if s.isdigit() else None


def facts(record: dict) -> dict | None:
    """Both players' numbers for one review (None for bot games and games without moves)."""
    moves = record.get("moves") or []
    if not moves or record.get("source") in BOT_SOURCES or not record.get("winPct"):
        return None
    headers = record.get("headers", {})
    tc_raw = headers.get("TimeControl", record.get("timeControl", "")) or ""
    inc = insights._increment(tc_raw)
    try:
        base = float(tc_raw.split("+")[0]) if tc_raw and "/" not in tc_raw else None
    except ValueError:
        base = None
    clocks = insights._clocks(record.get("pgn", "")) if record.get("pgn") else []
    wins = record["winPct"]  # White's win chance before each ply (and after the last)
    result = record.get("result", "*")
    end = insights._end_reason(record)

    # The positional lessons need the tactic marks first (a tactic explains a move better than a principle).
    tactics.enrich(record)

    sides = {"w": _empty_side(), "b": _empty_side()}
    for color in ("w", "b"):
        s = sides[color]
        white = color == "w"
        s["elo"] = _rating(record.get("whiteElo" if white else "blackElo"))
        s["acc"] = (record.get("accuracy") or {}).get(color)
        mine = [wn if white else 100 - wn for wn in wins]
        s["winning"] = max(mine) >= WINNING
        s["losing"] = min(mine) <= LOSING
        s["outcome"] = ("draw" if result == "1/2-1/2" else
                        "win" if result == ("1-0" if white else "0-1") else
                        "loss" if result in ("1-0", "0-1") else None)
        s["onTime"] = s["outcome"] == "loss" and end == "time"
        s["habits"] = insights._habits(record, color)

    for i, m in enumerate(moves):
        s = sides[m["color"]]
        board = chess.Board(m["fenBefore"])
        white = m["color"] == "w"
        before = wins[i] if white else 100 - wins[i]
        after = wins[i + 1] if white else 100 - wins[i + 1]
        acc = 100.0 if m["cls"] in (C.BEST, C.BRILLIANT, C.GREAT, C.BOOK, C.FORCED) else C.move_accuracy(before, after)
        phase = insights._phase(board, board.fullmove_number, m["cls"])
        s["n"] += 1
        s["loss"] += m["loss"]
        s["cls"][m["cls"]] += 1
        ph = s["phase"][phase]
        ph[0] += 1
        ph[1] += acc
        ph[3] += m["loss"]
        if m["cls"] in SEVERE:
            ph[2] += 1
            if s["firstError"] is None:
                s["firstError"] = board.fullmove_number
        if m["cls"] in ERRORS:
            s["tags"][insights._tag(m, board, board.turn)] += 1
            try:
                p = positional.explain(moves, i)
            except (ValueError, KeyError, AssertionError):
                p = None
            for c in (p or {}).get("concepts", []):
                s["concepts"][c["concept"]] += 1
        # A chance to punish: the opponent's last move was a mistake or blunder.
        if i > 0 and moves[i - 1]["cls"] in (C.MISTAKE, C.BLUNDER):
            s["chances"] += 1
            s["punished"] += m["cls"] not in SEVERE
        # Clock: what was left before this move, and what it took.
        if len(clocks) > i and clocks[i] is not None:
            prev = clocks[i - 2] if i >= 2 else base
            if prev is not None:
                s["timed"] += 1
                s["spent"] += max(0.0, prev - clocks[i] + inc)
                if prev < LOW_CLOCK:
                    s["lowClock"] += 1
                    s["lowClockErrors"] += m["cls"] in SEVERE
    return {"id": record.get("id"), "ts": storage.played_at(record), "tc": insights.time_class(tc_raw),
            "white": (record.get("white") or "").lower(), "black": (record.get("black") or "").lower(),
            "source": record.get("source"), "w": sides["w"], "b": sides["b"]}


_cache: dict[str, tuple[float, dict | None]] = {}
_lock = threading.Lock()
_loaded = False
_saved_at = 0.0
_memo: dict = {}


def _load_disk() -> None:
    global _loaded
    _loaded = True
    try:
        with CACHE_FILE.open("rb") as f:
            version, data = pickle.load(f)
        if version == CACHE_VERSION:
            _cache.update(data)
    except (OSError, pickle.PickleError, EOFError, ValueError, AttributeError):
        pass


def save_disk() -> None:
    try:
        write_atomic(CACHE_FILE, pickle.dumps((CACHE_VERSION, dict(_cache)), protocol=pickle.HIGHEST_PROTOCOL))
    except OSError:
        pass


def _all_facts() -> list[dict]:
    global _saved_at
    with _lock:
        if not _loaded:
            _load_disk()
        out, live, dirty = [], set(), False
        for gid, mtime in storage.index():
            live.add(gid)
            hit = _cache.get(gid)
            if hit and hit[0] == mtime:
                f = hit[1]
            else:
                try:
                    record = storage.load(gid)
                    f = facts(record) if record else None
                except Exception:  # one odd review must not take the page down
                    f = None
                _cache[gid] = (mtime, f)
                dirty = True
            if f:
                out.append(f)
        for gone in set(_cache) - live:
            del _cache[gone]
            dirty = True
        if dirty and time.monotonic() - _saved_at >= SAVE_EVERY:
            save_disk()
            _saved_at = time.monotonic()
        return out


# --------------------------------------------------------------------------- #
#  Metrics: each is a ratio (sum over games of a numerator / of a denominator)
# --------------------------------------------------------------------------- #

def _phase_acc(p):
    return lambda s: (s["phase"][p][1], s["phase"][p][0])


def _phase_err(p):
    return lambda s: (s["phase"][p][2] * 40, s["phase"][p][0])


def _per100(key):
    return lambda s: (s["cls"][key] * 100, s["n"])


def _tag100(tag):
    return lambda s: (s["tags"][tag] * 100, s["n"])


def _habit(fn):
    def get(s):
        h = s["habits"] or {}
        v = fn(h)
        return (0, 0) if v is None else (v, 1)
    return get


# key, label, section, (numerator, denominator) per side, better ("higher" | "lower" | None), unit, decimals
METRICS = [
    ("accuracy", "Accuracy", "Overall", lambda s: (s["acc"] * s["n"], s["n"]) if s["acc"] is not None else (0, 0),
     "higher", "%", 1),
    ("loss", "Expected points lost per move", "Overall", lambda s: (s["loss"] * 100, s["n"]), "lower", "%", 2),
    ("top", "Best moves", "Overall", lambda s: (sum(s["cls"][c] for c in TOP) * 100, s["n"]), "higher", "%", 1),
    ("blunders", "Blunders per 100 moves", "Overall", _per100(C.BLUNDER), "lower", "", 2),
    ("mistakes", "Mistakes per 100 moves", "Overall", _per100(C.MISTAKE), "lower", "", 2),
    ("misses", "Misses per 100 moves", "Overall", _per100(C.MISS), "lower", "", 2),
    ("inaccuracies", "Inaccuracies per 100 moves", "Overall", _per100(C.INACCURACY), "lower", "", 2),
    ("clean", "Games without a mistake or blunder", "Overall",
     lambda s: ((s["firstError"] is None) * 100, 1 if s["n"] >= 10 else 0), "higher", "%", 1),
    *[(f"acc_{p}", f"Accuracy in the {p}", "Phases", _phase_acc(p), "higher", "%", 1) for p in PHASES],
    *[(f"err_{p}", f"Serious errors per 40 moves in the {p}", "Phases", _phase_err(p), "lower", "", 2) for p in PHASES],
    *[(f"tag_{t}", f"{label} (per 100 moves)", "Mistake types", _tag100(t), "lower", "", 2)
      for t, label in insights.TAGS.items()],
    ("punish", "Punished the opponent's mistakes", "Using chances", lambda s: (s["punished"] * 100, s["chances"]),
     "higher", "%", 1),
    ("convert", "Won when clearly winning", "Using chances",
     lambda s: ((s["outcome"] == "win") * 100, 1 if s["winning"] else 0), "higher", "%", 1),
    ("save", "Saved when clearly lost (draw or win)", "Using chances",
     lambda s: ((s["outcome"] in ("win", "draw")) * 100, 1 if s["losing"] else 0), "higher", "%", 1),
    ("spent", "Seconds per move", "Clock", lambda s: (s["spent"], s["timed"]), None, "s", 1),
    ("lowclock", "Moves played with under 30 s left", "Clock", lambda s: (s["lowClock"] * 100, s["timed"]),
     "lower", "%", 1),
    ("lowclock_err", "Serious errors with under 30 s left (per game)", "Clock",
     lambda s: (s["lowClockErrors"], 1 if s["timed"] else 0), "lower", "", 2),
    ("ontime", "Games lost on time", "Clock", lambda s: (s["onTime"] * 100, 1 if s["outcome"] else 0),
     "lower", "%", 1),
    ("castled", "Castled by move 10", "Opening habits",
     _habit(lambda h: (h.get("castleMove") is not None and h["castleMove"] <= 10) * 100), "higher", "%", 1),
    ("early_queen", "Queen out in the first 5 moves", "Opening habits",
     _habit(lambda h: h.get("earlyQueen", False) * 100), "lower", "%", 1),
    ("undeveloped", "Minor pieces still at home on move 10", "Opening habits",
     _habit(lambda h: h.get("undevelopedAt10")), "lower", "", 2),
    ("book", "Last book move (move number)", "Opening habits", _habit(lambda h: h.get("bookExit")), "higher", "", 1),
    ("positional", "Positional mistakes per 100 moves", "Positional",
     lambda s: (sum(s["concepts"].values()) * 100, s["n"]), "lower", "", 2),
]


def _stat(sides: list[dict], fn) -> dict | None:
    """Pooled ratio Σnum/Σden with its cluster-robust standard error (games are the clusters)."""
    pairs = [fn(s) for s in sides]
    pairs = [(a, b) for a, b in pairs if b]
    g = len(pairs)
    if not g:
        return None
    num, den = sum(a for a, _ in pairs), sum(b for _, b in pairs)
    r = num / den
    se = None
    if g >= 2:
        mean_den = den / g
        var = sum((a - r * b) ** 2 for a, b in pairs) / (g * (g - 1)) / mean_den ** 2
        se = math.sqrt(var)
    return {"value": r, "se": se, "games": g}


def _block(sides: list[dict]) -> dict:
    out = {}
    for key, _label, _section, fn, *_ in METRICS:
        out[key] = _stat(sides, fn)
    return out


def _concepts(you: list[dict], level: list[dict]) -> list[dict]:
    """Positional lessons per 100 moves, you vs your level – the ones that come up often enough to compare."""
    rows = []
    keys = set().union(*(s["concepts"] for s in you + level)) if you or level else set()
    for cid in keys:
        fn = (lambda c: lambda s: (s["concepts"][c] * 100, s["n"]))(cid)
        a, b = _stat(you, fn), _stat(level, fn)
        total = sum(s["concepts"][cid] for s in you + level)
        if not a or not b or total < 8:
            continue
        rows.append({"concept": cid, "title": K.CONCEPTS[cid].title, "you": _r(a["value"], 2), "level": _r(b["value"], 2),
                     "z": _z(a, b, "lower")})
    rows.sort(key=lambda r: -(r["you"] - r["level"]))
    return rows


def _r(v, d):
    return None if v is None else round(v, d)


def _z(a: dict | None, b: dict | None, better: str | None) -> float | None:
    """How many standard errors `a` is better than `b` (negative: worse)."""
    if not a or not b or a["se"] is None or b["se"] is None or better is None:
        return None
    se = math.sqrt(a["se"] ** 2 + b["se"] ** 2)
    if se == 0:
        return None
    d = (a["value"] - b["value"]) / se
    return round(d if better == "higher" else -d, 2)


def _expected(me: int, opp: int) -> float:
    return 1 / (1 + 10 ** ((opp - me) / 400))


def _results(pairs: list[tuple[dict, dict]]) -> dict | None:
    """Your score against a group, next to what the rating difference predicts."""
    scored = [(m, o) for m, o in pairs if m["outcome"]]
    if not scored:
        return None
    score = sum({"win": 1, "draw": 0.5, "loss": 0}[m["outcome"]] for m, _ in scored) / len(scored)
    exp = sum(_expected(m["elo"], o["elo"]) for m, o in scored) / len(scored)
    return {"games": len(scored), "score": round(score * 100, 1), "expected": round(exp * 100, 1),
            "diff": round(sum(o["elo"] - m["elo"] for m, o in scored) / len(scored))}


# --------------------------------------------------------------------------- #
#  The report
# --------------------------------------------------------------------------- #

def compute(tc: str = "all", last: int = 0, band: int = BAND, platform: str = "all") -> dict:
    key = (tc, last, band, platform)
    sig = hash((tuple(sorted(storage.index())), frozenset(my_names())))
    hit = _memo.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    report = _compute(tc, last, band, platform)
    if len(_memo) > 12:
        _memo.clear()
    _memo[key] = (sig, report)
    return report


def _compute(tc: str, last: int, band: int, platform: str = "all") -> dict:
    band = max(25, min(300, int(band)))
    names = my_names()
    games = []
    for f in _all_facts():
        me = "w" if f["white"] in names else "b" if f["black"] in names else None
        if not me:
            continue
        mine, theirs = f[me], f["b" if me == "w" else "w"]
        if mine["elo"] is None or theirs["elo"] is None:
            continue
        games.append((f, mine, theirs))
    platforms = sorted({f["source"] for f, _, _ in games if f["source"]})
    if platform != "all":
        games = [g for g in games if g[0]["source"] == platform]
    tcs = sorted({f["tc"] for f, _, _ in games})
    if tc != "all":
        games = [g for g in games if g[0]["tc"] == tc]
    games.sort(key=lambda g: -g[0]["ts"])
    if last:
        games = games[:last]

    groups = {"level": [], "stronger": [], "weaker": []}
    for f, mine, theirs in games:
        d = theirs["elo"] - mine["elo"]
        if abs(d) <= band:
            groups["level"].append((mine, theirs))
        elif band < d <= FAR:
            groups["stronger"].append((mine, theirs))
        elif -FAR <= d < -band:
            groups["weaker"].append((mine, theirs))

    you = [m for _, m, _ in games]
    blocks = {"you": _block(you), **{k: _block([o for _, o in v]) for k, v in groups.items()}}
    ratings = sorted(m["elo"] for m in you)

    metrics = []
    for key, label, section, _fn, better, unit, dec in METRICS:
        row = {"key": key, "label": label, "section": section, "better": better, "unit": unit}
        for g, b in blocks.items():
            s = b[key]
            row[g] = _r(s["value"], dec) if s else None
            row[f"{g}Games"] = s["games"] if s else 0
        row["vsLevel"] = _z(blocks["you"][key], blocks["level"][key], better)
        row["levelVsStronger"] = _z(blocks["stronger"][key], blocks["level"][key], better)
        metrics.append(row)

    report = {
        "games": len(games), "band": band, "far": FAR, "minGames": MIN_GAMES, "zReal": Z_REAL,
        "timeClasses": tcs, "platforms": platforms,
        "rating": {"now": you[0]["elo"] if you else None, "median": ratings[len(ratings) // 2] if ratings else None,
                   "min": ratings[0] if ratings else None, "max": ratings[-1] if ratings else None},
        "groups": {k: {"games": len(v), "results": _results(v)} for k, v in groups.items()},
        "metrics": metrics,
        "concepts": _concepts(you, [o for _, o in groups["level"]]),
        # Ratings on Chess.com and Lichess aren't on the same scale: one curve per site.
        "curve": {p: _curve([g for g in games if g[0]["source"] == p]) for p in platforms},
    }
    report["findings"] = _findings(metrics, report["groups"])
    return report


def _curve(games: list[tuple[dict, dict, dict]], width: int = 100) -> list[dict]:
    """Accuracy and blunder rate by rating (100-point buckets): your opponents', and yours."""
    opp, me = defaultdict(list), defaultdict(list)
    for _, mine, theirs in games:
        opp[theirs["elo"] // width * width].append(theirs)
        me[mine["elo"] // width * width].append(mine)
    rows = []
    acc_fn = METRICS[0][3]
    bl_fn = _per100(C.BLUNDER)
    for lo in sorted(set(opp) | set(me)):
        o, y = opp.get(lo, []), me.get(lo, [])
        if len(o) < 5 and len(y) < 5:
            continue
        rows.append({"from": lo, "to": lo + width - 1,
                     "opponents": len(o), "oppAccuracy": _r((_stat(o, acc_fn) or {}).get("value"), 1) if len(o) >= 5 else None,
                     "oppBlunders": _r((_stat(o, bl_fn) or {}).get("value"), 2) if len(o) >= 5 else None,
                     "you": len(y), "accuracy": _r((_stat(y, acc_fn) or {}).get("value"), 1) if len(y) >= 5 else None,
                     "blunders": _r((_stat(y, bl_fn) or {}).get("value"), 2) if len(y) >= 5 else None})
    return rows


def _fmt(v, unit: str) -> str:
    if v is None:
        return "–"
    return f"{v:g}{unit}" if unit in ("%", "s") else f"{v:g}"


def _findings(metrics: list[dict], groups: dict) -> dict:
    """What stands out: where you're clearly behind or ahead of your level, and what stronger players do better."""
    enough_level = groups["level"]["games"] >= MIN_GAMES
    enough_strong = groups["stronger"]["games"] >= MIN_GAMES
    weak, strong, climb = [], [], []
    for m in metrics:
        z = m["vsLevel"]
        if enough_level and z is not None and abs(z) >= Z_REAL:
            item = {"key": m["key"], "label": m["label"], "you": m["you"], "level": m["level"], "z": z,
                    "text": f"{m['label']}: you {_fmt(m['you'], m['unit'])}, players at your level {_fmt(m['level'], m['unit'])}."}
            (strong if z > 0 else weak).append(item)
        # Things stronger players clearly do better than your level – and you don't do better either.
        zs = m["levelVsStronger"]
        if enough_strong and enough_level and zs is not None and zs >= Z_REAL and (z is None or z < Z_REAL):
            climb.append({"key": m["key"], "label": m["label"], "you": m["you"], "level": m["level"],
                          "stronger": m["stronger"], "z": zs,
                          "text": f"{m['label']}: you {_fmt(m['you'], m['unit'])}, your level {_fmt(m['level'], m['unit'])}, "
                                  f"stronger players {_fmt(m['stronger'], m['unit'])}."})
    weak.sort(key=lambda x: x["z"])
    strong.sort(key=lambda x: -x["z"])
    climb.sort(key=lambda x: -x["z"])
    return {"weaknesses": weak[:6], "strengths": strong[:6], "climb": climb[:6]}
