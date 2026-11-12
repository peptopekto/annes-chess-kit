"""Woodpecker-method puzzle sets.

File format is identical to the old Pygame trainer's woodpecker_sets/*.json so
existing sets and run history keep working.
"""
from __future__ import annotations

import csv
import json
import logging
import os
import random
import threading
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

from . import classify as C
from . import storage

log = logging.getLogger(__name__)
from .config import SETS_DIR, load_settings, write_atomic


def _path(set_id: str) -> Path:
    if not set_id.replace("_", "").replace("-", "").isalnum():
        raise ValueError("bad set id")
    return SETS_DIR / f"{set_id}.json"


def _read(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):  # legacy: bare list of puzzles
        data = {"metadata": {"name": f"Legacy Set ({len(data)} puzzles)", "amount": len(data),
                             "completed_runs": []}, "puzzles": data}
    data.setdefault("metadata", {}).setdefault("completed_runs", [])
    return data


def _write(path: Path, data: dict) -> None:
    write_atomic(path, json.dumps(data, indent=2))


def list_sets() -> list[dict]:
    out = []
    for p in sorted(SETS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = _read(p)
        except (OSError, json.JSONDecodeError):
            continue
        meta = data["metadata"]
        out.append({
            "id": p.stem,
            "meta": {k: v for k, v in meta.items() if k != "active_progress"},
            "count": len(data.get("puzzles", [])),
            "activeIdx": (meta.get("active_progress") or {}).get("current_idx"),
        })
    return out


def get_set(set_id: str) -> dict:
    return {"id": set_id, **_read(_path(set_id))}


def delete_set(set_id: str) -> None:
    _path(set_id).unlink(missing_ok=True)


def save_progress(set_id: str, progress: dict | None) -> None:
    from . import training

    p = _path(set_id)
    data = _read(p)
    old = data["metadata"].get("active_progress")
    data["metadata"]["active_progress"] = progress
    _write(p, data)
    training.woodpecker_progress(data.get("puzzles", []), old, progress)


def complete_run(set_id: str, stats: dict) -> dict:
    from . import training

    p = _path(set_id)
    data = _read(p)
    training.woodpecker_progress(data.get("puzzles", []), data["metadata"].get("active_progress"), stats, final=True)
    data["metadata"]["active_progress"] = None
    data["metadata"]["completed_runs"].append(stats)
    _write(p, data)
    return data["metadata"]


def _new_set(name: str, puzzles: list[dict], extra: dict) -> dict:
    set_id = f"set_{int(time.time())}"
    data = {
        "metadata": {"name": name, "amount": len(puzzles), "created_at": datetime.now().isoformat(),
                     "completed_runs": [], **extra},
        "puzzles": puzzles,
    }
    _write(_path(set_id), data)
    return {"id": set_id, **data}


def create_from_csv(amount: int, min_rating: int, max_rating: int,
                    min_length: int = 2, max_length: int = 50) -> dict:
    """Random sample from the Lichess puzzle DB (ported from puzzle_extractor.py)."""
    csv_path = Path(load_settings()["puzzle_csv"])
    if not csv_path.exists():
        raise ValueError(f"Puzzle database not found at {csv_path}. Set its path in Settings.")

    pool: list[dict] = []
    with csv_path.open("r", encoding="utf-8") as f:
        # The DB is >1 GB: jump to a random offset and scan forward instead of reading it all.
        size = csv_path.stat().st_size
        f.seek(random.randint(0, max(0, size - 15_000_000)))
        f.readline()
        for row in csv.reader(f):
            if len(row) < 4:
                continue
            try:
                rating = int(row[3])
            except ValueError:
                continue
            moves = row[2].split(" ")
            if min_rating <= rating <= max_rating and min_length <= len(moves) <= max_length:
                pool.append({"id": row[0], "fen": row[1], "moves": moves, "rating": rating,
                             "length": len(moves), "themes": row[7].split(" ") if len(row) > 7 else []})
            if len(pool) >= min(50_000, amount * 20):
                break

    if not pool:
        raise ValueError("No puzzles matched those filters.")
    puzzles = random.sample(pool, min(amount, len(pool)))
    return _new_set(f"{len(puzzles)} Puzzles ({min_rating}-{max_rating})", puzzles, {
        "min_rating": min_rating, "max_rating": max_rating,
        "min_length": min_length, "max_length": max_length, "source": "lichess",
    })


# Puzzle quality follows the ideas of Lichess's puzzle generator (github.com/ornicar/lichess-puzzler):
#  * one clearly right move at every step you play: the next-best is at least ONLY_GAP worse.
#    Lichess demands 0.35 expected points – it picks from millions of games and can afford to throw
#    away "win a piece vs. stay equal" positions; from your own games those are exactly the ones to
#    train, so the bar here is "clearly worse" (about a piece vs. a pawn), not "losing";
#  * a mate puzzle is about finding the mate: no non-mating move may also win comfortably
#    (Lichess: at most 0.6 win chances = 0.80 expected points);
#  * an attacking puzzle has to pay off: it wins material (MIN_GAIN, played out) and leaves you better.
# And it must come from a *recurring* pattern of yours (see the "patterns" section below).
MIN_LOSS = 0.15  # only positions where the right move really mattered
ALT_DEPTH = 18   # depth of the search that decides which moves solve a step
ALT_TOL = 0.04   # a move this close to the best one (expected points) solves the step too
MAX_GOOD = 2     # more good moves than this at the first step: no single point to find – not a puzzle
ONLY_GAP = 0.20  # the right move(s) beat every other move by this much (expected points, Lichess curve)
MATE_ALT_MAX = 0.80  # in a mate puzzle, the best non-mating move stays below this
ATTACK_MIN = 0.58    # attacking puzzles: you're better after the right move (about +1, Lichess curve)
MIN_GAIN = 2     # a "win material" puzzle has to win at least this much (pawns), with the captures played out
ALIVE = 0.30     # your winning chance after the right move: below it the position is lost either way
# The move that leads into the puzzle (your opponent's) must not be a real error of theirs. If they
# blundered there – hung a rook, missed the mate you allowed – the position only exists because they
# erred: not a real puzzle, and not the mistake you need to train. (An inaccuracy is a normal move.)
SETUP_MAX_LOSS = 0.10
MATERIAL_THEMES = {"free_piece", "fork", "pin", "skewer", "discovered", "trapped", "promotion", "win_material"}


def _engine_lines(fen: str, multipv: int, depth: int = ALT_DEPTH, max_time: float = 4.0):
    import chess

    from . import analysis, engine

    board = chess.Board(fen)
    with engine.batch.acquire() as eng:
        return board, analysis.analyse_lines(eng, board, depth, multipv=multipv, max_time=max_time)


def _step(fen: str, mate_left: int | None) -> tuple[list[str], bool]:
    """The moves that solve this step, and whether the step has one clear point.

    Mates: every move that still mates as fast solves it; the step is clear if no non-mating move also
    wins comfortably. Otherwise: moves within ALT_TOL of the best solve it; the step is clear if every
    other move is at least ONLY_GAP worse (and there are only a couple of good moves).
    """
    board, lines = _engine_lines(fen, multipv=5)
    if not lines:
        return [], False
    pov = board.turn
    eps = [C.expected_points(ln.score.pov(pov)) for ln in lines]
    if mate_left:
        good = [ln.move.uci() for ln in lines
                if (m := ln.score.pov(pov).mate()) is not None and 0 < m <= mate_left]
        others = [e for ln, e in zip(lines, eps) if (ln.score.pov(pov).mate() or 0) <= 0]
        return good, not others or max(others) < MATE_ALT_MAX
    best = eps[0]
    good = [ln.move.uci() for ln, e in zip(lines, eps) if e >= best - ALT_TOL]
    rest = [e for ln, e in zip(lines, eps) if ln.move.uci() not in good]
    # No worse move among the top five: everything is about as good – nothing to find.
    clear = bool(rest) and best - max(rest) >= ONLY_GAP and len(good) <= MAX_GOOD
    return good, clear


def _reply_ok(fen: str, uci: str) -> bool:
    """Is the opponent's reply in the solution what Stockfish plays here (or just as good)?"""
    board, lines = _engine_lines(fen, multipv=3)
    if not lines:
        return True
    best = C.expected_points(lines[0].score.pov(board.turn))
    return any(ln.move.uci() == uci and C.expected_points(ln.score.pov(board.turn)) >= best - ALT_TOL
               for ln in lines)


def setup_is_sound(prev: dict, sc: float) -> bool:
    """Your opponent's move before the puzzle position wasn't an error of theirs (see SETUP_MAX_LOSS)."""
    if prev.get("cls") in (C.MISTAKE, C.BLUNDER, C.MISS):
        return False
    return (prev.get("loss") or 0.0) < SETUP_MAX_LOSS * sc


def _full_mate_line(fen: str, mate_in: int) -> list[str] | None:
    """Re-search a mate whose stored line stops early; SAN line that ends in checkmate, or None."""
    import chess

    from . import analysis

    board, lines = _engine_lines(fen, multipv=1, depth=22, max_time=6.0)
    if not lines or (lines[0].score.pov(board.turn).mate() or 0) <= 0:
        return None
    sans = analysis.san_line(board, lines[0].pv, 2 * mate_in + 1)
    b = board.copy()
    for san in sans:
        b.push_san(san)
    return sans if b.is_checkmate() else None


def _finish(puzzle: dict) -> dict | None:
    """Precompute acceptable answers for every move you have to find (instant checking).

    None if the puzzle isn't fair: the deeper search doesn't confirm the solution, the opponent's replies
    in it aren't Stockfish's, or the first move has too many equally good answers to have a point.
    """
    import chess

    board = chess.Board(puzzle["fen"])
    board.push_uci(puzzle["moves"][0])
    mate_total = puzzle.pop("_mate")
    steps = []
    for k, uci in enumerate(puzzle["moves"][1:]):
        if k % 2 == 0:  # your move
            left = mate_total - k // 2 if mate_total else None
            good, clear = _step(board.fen(), left)
            if uci not in good and not _mates(board, uci):
                return _no("a deeper search disagrees")
            # One clear point at every step (for a mate: at the first step – later on, any mate will do).
            if not clear and (not mate_total or k == 0):
                return _no("no single clear move")
            steps.append(sorted(set(good) | {uci}))
        elif not _reply_ok(board.fen(), uci):
            return _no("the opponent could defend better")
        board.push_uci(uci)
    puzzle["altSteps"] = steps
    puzzle["alternatives"] = steps[0] if steps else []
    return puzzle


def _mates(board, uci: str) -> bool:
    b = board.copy(stack=False)
    b.push_uci(uci)
    return b.is_checkmate()


def _solver_ep(move: dict, board, k: float) -> float | None:
    """Your expected points after the right move (from the review's evaluation of the best move)."""
    import chess
    import chess.engine

    ev = move.get("bestEval") or {}
    if "mate" in ev:
        score = chess.engine.Mate(ev["mate"]) if ev["mate"] else None
    elif "cp" in ev:
        score = chess.engine.Cp(ev["cp"])
    else:
        score = None
    if score is None:
        return None
    return C.expected_points(chess.engine.PovScore(score, chess.WHITE).pov(board.turn), k)


def pays_off(board, theme: str, ucis: list[str], line: list[str], start=None) -> bool:
    """Does the solution achieve what the puzzle promises? Mates must mate; "win material" themes must
    really come out at least MIN_GAIN ahead once the engine line's captures are played out – counted from
    `start`, the position before the exchange under way (just taking back a piece wins nothing)."""
    from . import tactics

    if theme in ("mate", "back_rank"):
        b = board.copy(stack=False)
        for u in ucis:
            b.push_uci(u)
        return b.is_checkmate()
    if theme in MATERIAL_THEMES:
        gain = tactics._gain(board, line, start or board, plies=max(4, len(ucis) + 1))
        return gain is not None and gain >= MIN_GAIN
    return True  # defensive puzzles (stop the mate, save the piece): holding is the point


CHESSCOM_TO_LICHESS = 350  # rough offset between the two rating pools at club level


def _current_rating() -> float | None:
    """Your *current* level, from the most recent games of each platform (Lichess scale)."""
    by_source: dict[str, list[tuple[float, int]]] = {}
    for r in storage.summaries():
        me = r.get("me")
        raw = str(r.get("whiteElo" if me == "w" else "blackElo") or "") if me else ""
        if raw.isdigit():
            shift = CHESSCOM_TO_LICHESS if r.get("source") == "chess.com" else 0
            by_source.setdefault(r.get("source") or "pgn", []).append((r.get("playedAt") or 0, int(raw) + shift))
    recent = [elo for games in by_source.values() for _, elo in sorted(games, reverse=True)[:30]]
    return sum(recent) / len(recent) if recent else None


_why: "Counter[str]" = Counter()   # why positions were turned down (logged and kept in the set's metadata)
_why_lock = threading.Lock()


def _no(reason: str) -> None:
    with _why_lock:
        _why[reason] += 1


def _build(game_id: str, ply: int, max_mate: int) -> dict | None:
    """A puzzle from the position before your move `ply` in a review – or None if it isn't a good one."""
    import chess

    from . import tactics

    try:
        record = storage.load(game_id)
    except ValueError:
        return None
    if not record or ply < 2 or ply > len(record["moves"]):
        return _no("missing review")
    move, prev = record["moves"][ply - 1], record["moves"][ply - 2]
    sc = ((record.get("ratingModel") or {}).get("k") or C.LICHESS_K) / C.LICHESS_K
    if move["loss"] < MIN_LOSS * sc and move["cls"] != "miss":
        return _no("the right move didn't matter enough")
    if not setup_is_sound(prev, sc):
        return _no("your opponent had just erred")
    board = chess.Board(move["fenBefore"])
    mate = (move.get("bestEval") or {}).get("mate")
    mate_n = abs(mate) if mate is not None and (mate > 0) == (board.turn == chess.WHITE) else None
    if mate_n and mate_n > max_mate:
        return _no("mate too long for your level")
    alive = _solver_ep(move, board, C.LICHESS_K)
    if not mate_n and alive is not None and alive < ALIVE:
        return _no("lost even after the right move")

    start = tactics.exchange_start(record["moves"], ply - 1)
    line = move.get("bestLine") or [move["bestSan"]]
    sol = tactics.puzzle_solution(board, line, max_mate)
    if mate_n and (not sol or sol[0] not in ("mate", "back_rank")):
        # Stored line stops before the mate: search it again so the mate is played to the end.
        full = _full_mate_line(move["fenBefore"], mate_n)
        sol = tactics.puzzle_solution(board, full, max_mate) if full else None
    if not sol and not mate_n:
        # Not an attacking tactic: maybe a defensive puzzle (stop the mate, save the piece) or
        # winning material through exchanges.
        sol = tactics.quiet_solution(board, line)
    if not sol:
        return _no("no tactic: a quiet positional move")
    theme, ucis = sol
    is_mate = theme in ("mate", "back_rank")
    if not is_mate and theme not in DEFENSIVE and alive is not None and alive < ATTACK_MIN:
        return _no("the tactic doesn't leave you better")
    if not pays_off(board, theme, ucis, line, start):
        return _no("the tactic doesn't win enough material")
    return _finish({
        "id": f"{game_id}-{ply}",
        "fen": prev["fenBefore"],
        "moves": [prev["uci"], *ucis],
        "rating": None,
        "length": 1 + len(ucis),
        "themes": [theme, f"mateIn{(len(ucis) + 1) // 2}" if is_mate else move["cls"]],
        "goal": tactics.GOALS[theme],
        "tip": tactics.TIPS[theme],
        "engineCheck": True,
        "gameId": game_id,
        "ply": ply,
        "played": move["san"],
        "_mate": (len(ucis) + 1) // 2 if is_mate else None,
    })


def _build_all(todo: list[tuple[str, int]], max_mate: int, enough) -> list[dict]:
    """Build puzzles from (game id, ply) in order, in parallel chunks, until `enough(puzzles)` says stop."""
    from concurrent.futures import ThreadPoolExecutor

    from . import engine

    puzzles: list[dict] = []
    with ThreadPoolExecutor(max_workers=engine.batch.size) as pool:
        for i in range(0, len(todo), 32):
            chunk = todo[i:i + 32]
            puzzles += [p for p in pool.map(lambda r: _build(r[0], r[1], max_mate), chunk) if p]
            if enough(puzzles):
                break
    return puzzles


def create_from_moves(refs: list[tuple[str, int]], name: str, amount: int = 50) -> dict:
    """A drill set from chosen positions of your games (e.g. one Insights category)."""
    from . import tactics

    rating = _current_rating()
    max_mate = tactics.max_mate_for_rating(rating)
    todo, seen = [], set()
    records = storage.load_many({gid for gid, _ in refs})
    for game_id, ply in refs:
        record = records.get(game_id)
        if not record or ply < 2 or ply > len(record["moves"]):
            continue
        # One puzzle per position: a mistake you repeated is one pattern (the cycles do the repeating).
        epd = " ".join(record["moves"][ply - 1]["fenBefore"].split()[:4])
        if epd not in seen:
            seen.add(epd)
            todo.append((game_id, ply))
    random.shuffle(todo)
    puzzles = _build_all(todo, max_mate, lambda ps: len(ps) >= amount)[:amount]
    if not puzzles:
        raise ValueError("None of these positions has a clear tactic or mate to find – analyse more games and try again.")
    extra = {"source": "games", "maxMate": max_mate, "fromPositions": len(refs)}
    if rating:
        extra["rating"] = round(rating)
    return _new_set(f"{name} ({len(puzzles)})", puzzles, extra)


# --------------------------------------------------------------------------- #
#  Your recurring patterns: what the "My mistakes" set is built from
# --------------------------------------------------------------------------- #

MIN_REPEAT = 4         # mistakes of one kind needed before it counts as a pattern of yours
MIN_PER_PATTERN = 3    # every pattern in the set gets at least this many puzzles…
MAX_SHARE = 0.40       # …and none more than this share of the set
HALF_LIFE_DAYS = 180   # a mistake from half a year ago counts half as much as one from today
DEFENSIVE = {"stop_mate", "save_piece"}

PATTERN_LABELS = {
    "mate": "Missed mates", "fork": "Missed forks", "pin": "Missed pins", "skewer": "Missed skewers",
    "discovered": "Missed discovered attacks", "trapped": "Missed trapped pieces", "free_piece": "Missed free material",
    "promotion": "Missed promotions", "stop_mate": "Walking into mate",
    "save_piece": "Leaving pieces to be taken",
}


def pattern_of_theme(theme: str) -> str | None:
    """The pattern a puzzle theme trains (the key used for counting your mistakes)."""
    if theme in ("mate", "back_rank"):
        return "mate"
    return theme if theme in PATTERN_LABELS else None


def pattern_keys(m: dict) -> list[str]:
    """Which recurring patterns a mistake of yours belongs to: the tactic you missed and/or what you allowed."""
    from . import tactics

    keys = []
    if m.get("missed"):
        k = pattern_of_theme(m["missed"])
        if k:
            keys.append(k)
    allowed = m.get("fellFor")
    if allowed in ("mate", "back_rank"):
        keys.append("stop_mate")
    elif allowed in tactics.WINS_MATERIAL:
        keys.append("save_piece")
    return keys


def patterns(games=None, now: float | None = None) -> tuple[dict[str, dict], dict[tuple[str, str], list]]:
    """Your recurring mistake patterns and the positions where you made the same mistake again.

    patterns: key -> {count, games, weight}; weight = expected points lost, recent mistakes counting more.
    repeats: (position, your move) -> [(game id, ply, played at)] for mistakes made in 2+ different games.
    """
    from . import insights

    games = insights._games() if games is None else games
    now = now or time.time()
    stats: dict[str, dict] = {}
    same: dict[tuple[str, str], list] = {}
    for g in games:
        rec = 0.5 ** (max(0.0, now - g.ts) / 86400 / HALF_LIFE_DAYS)
        for m in g.moves:
            if m["cls"] not in ("mistake", "blunder", "miss") or m["loss"] < 0.08:
                continue
            for k in pattern_keys(m):
                st = stats.setdefault(k, {"count": 0, "games": set(), "weight": 0.0})
                st["count"] += 1
                st["games"].add(g.record["id"])
                st["weight"] += m["loss"] * rec
            epd = " ".join(m["fenBefore"].split()[:4])
            same.setdefault((epd, m["san"]), []).append((g.record["id"], m["ply"], g.ts))
    repeats = {k: v for k, v in same.items() if len({gid for gid, _, _ in v}) >= 2}
    return stats, repeats


def quotas(stats: dict[str, dict], amount: int) -> dict[str, int]:
    """Puzzles per recurring pattern: in proportion to what it costs you, within MIN_PER_PATTERN..MAX_SHARE."""
    mine = {k: v for k, v in stats.items() if v["count"] >= MIN_REPEAT}
    total = sum(v["weight"] for v in mine.values())
    if not total:
        return {}
    cap = max(MIN_PER_PATTERN, round(MAX_SHARE * amount))
    return {k: min(cap, max(MIN_PER_PATTERN, round(amount * v["weight"] / total))) for k, v in mine.items()}


def _interleave(puzzles: list[dict]) -> list[dict]:
    """Mix the themes (round-robin over patterns) so each puzzle has to be recognised, not guessed from the last."""
    groups: dict[str, list[dict]] = {}
    for p in puzzles:
        groups.setdefault(p["pattern"]["key"], []).append(p)
    for g in groups.values():
        random.shuffle(g)
    order = sorted(groups, key=lambda k: -len(groups[k]))
    out = []
    while any(groups.values()):
        for k in order:
            if groups[k]:
                out.append(groups[k].pop())
    return out


def create_from_mistakes(amount: int = 50) -> dict:
    """The "My mistakes" set: puzzles from the patterns you keep getting wrong.

    * Only patterns you repeat (MIN_REPEAT+ costly mistakes of the kind) – one-off accidents teach little.
    * Each pattern gets puzzles in proportion to what it costs you (recent games weigh more), so the set
      drills your real problems; none takes over the whole set.
    * Positions where you made the very same mistake in several games come first.
    * Every puzzle passes the quality checks (one clear move, a real payoff, a sound setup).
    """
    from . import insights, tactics

    games = insights._games()
    stats, repeats = patterns(games)
    quota = quotas(stats, amount)
    if not quota:
        raise ValueError(f"No mistake pattern shows up {MIN_REPEAT}+ times in your reviewed games yet – "
                         "analyse more of your games and try again.")
    rating = _current_rating()
    max_mate = tactics.max_mate_for_rating(rating)
    now = time.time()
    repeat_at = {}
    for (epd, _), occ in repeats.items():
        gid, ply, _ = max(occ, key=lambda o: o[2])  # the latest time you went wrong there
        repeat_at[(gid, ply)] = len({o[0] for o in occ})

    # Candidates: your costly mistakes in a recurring pattern, most telling first.
    total_w = sum(stats[k]["weight"] for k in quota)
    cands, seen = [], set()
    for g in games:
        rec = 0.5 ** (max(0.0, now - g.ts) / 86400 / HALF_LIFE_DAYS)
        for m in g.moves:
            if m["cls"] not in ("mistake", "blunder", "miss") or m["loss"] < 0.08:
                continue
            ref = (g.record["id"], m["ply"])
            keys = [k for k in pattern_keys(m) if k in quota]
            if not keys and ref not in repeat_at:
                continue
            epd = " ".join(m["fenBefore"].split()[:4])
            if epd in seen:
                continue
            seen.add(epd)
            share = max((stats[k]["weight"] / total_w for k in keys), default=0.0)
            prio = (repeat_at.get(ref, 0) * 10) + share * rec * (1 + m["loss"])
            cands.append((prio, ref))
    cands.sort(key=lambda c: -c[0])

    picked: list[dict] = []
    spare: list[dict] = []
    filled: dict[str, int] = {k: 0 for k in quota}

    built_seen: list[dict] = []

    def accept(ps: list[dict]) -> bool:
        for p in ps[len(built_seen):]:
            built_seen.append(p)
            key = pattern_of_theme(p["themes"][0])
            times = repeat_at.get((p["gameId"], p["ply"]))
            if key not in quota and not times:
                _no("trains something that isn't a recurring pattern of yours")
                continue
            st = stats.get(key or "", {"count": 0, "games": set()})
            p["pattern"] = {"key": key or p["themes"][0],
                            "label": PATTERN_LABELS.get(key or "", tactics.THEMES.get(p["themes"][0], "")),
                            "count": st["count"], "games": len(st["games"])}
            if times:
                p["repeat"] = times
            if times or filled.get(key, 0) < quota.get(key, 0):
                picked.append(p)
                if key in filled:
                    filled[key] += 1
            else:
                spare.append(p)
        return len(picked) >= amount or all(filled[k] >= quota[k] for k in quota)

    with _why_lock:
        _why.clear()
    _build_all([ref for _, ref in cands], max_mate, accept)
    with _why_lock:
        funnel = dict(_why.most_common())
    log.info("my-mistakes set: %d candidates, %d puzzles, turned down: %s", len(cands), len(picked) + len(spare), funnel)
    # Patterns that couldn't fill their share: top up with the other recurring patterns' puzzles.
    puzzles = picked[:amount] + spare[:max(0, amount - len(picked))]
    if not puzzles:
        raise ValueError("None of your recurring mistakes gave a clear puzzle yet – analyse more games and try again.")
    puzzles = _interleave(puzzles)
    counts: dict[str, int] = {}
    for p in puzzles:
        counts[p["pattern"]["key"]] = counts.get(p["pattern"]["key"], 0) + 1
    extra = {"source": "games", "maxMate": max_mate, "kind": "patterns", "candidates": len(cands),
             "turnedDown": funnel,
             "patterns": [{"key": k, "label": PATTERN_LABELS.get(k, k), "puzzles": n,
                           "mistakes": stats.get(k, {}).get("count", 0)}
                          for k, n in sorted(counts.items(), key=lambda x: -x[1])]}
    if rating:
        extra["rating"] = round(rating)
    return _new_set(f"My recurring mistakes ({len(puzzles)})", puzzles, extra)


def create_from_pattern(key: str, amount: int = 30) -> dict:
    """A drill set for one of your recurring patterns (from the Training card's "Train" button)."""
    from . import insights

    if key not in PATTERN_LABELS:
        raise ValueError("Unknown pattern.")
    games = insights._games()
    refs, now = [], time.time()
    for g in games:
        rec = 0.5 ** (max(0.0, now - g.ts) / 86400 / HALF_LIFE_DAYS)
        for m in g.moves:
            if m["cls"] in ("mistake", "blunder", "miss") and m["loss"] >= 0.08 and key in pattern_keys(m):
                refs.append((rec * (1 + m["loss"]), (g.record["id"], m["ply"])))
    refs.sort(key=lambda r: -r[0])
    if not refs:
        raise ValueError("No mistakes of that kind in your reviewed games.")
    from . import tactics

    rating = _current_rating()
    max_mate = tactics.max_mate_for_rating(rating)
    todo = list(dict.fromkeys(ref for _, ref in refs))  # most telling first, each position once
    st = patterns(games)[0].get(key, {"count": 0, "games": set()})

    def keep(p: dict) -> bool:
        return pattern_of_theme(p["themes"][0]) == key

    picked: list[dict] = []
    checked = [0]

    def enough(ps: list[dict]) -> bool:
        for p in ps[checked[0]:]:
            checked[0] += 1
            if keep(p):
                p["pattern"] = {"key": key, "label": PATTERN_LABELS[key], "count": st["count"], "games": len(st["games"])}
                picked.append(p)
        return len(picked) >= amount

    _build_all(todo, max_mate, enough)
    if not picked:
        raise ValueError("None of these mistakes gave a clear puzzle yet – analyse more games and try again.")
    random.shuffle(picked)
    extra = {"source": "games", "maxMate": max_mate, "kind": "pattern", "pattern": key}
    if rating:
        extra["rating"] = round(rating)
    return _new_set(f"{PATTERN_LABELS[key]} ({len(picked[:amount])})", picked[:amount], extra)
