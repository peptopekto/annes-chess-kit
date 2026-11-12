"""Patterns across all your reviewed games: where, when and how you lose points.

Everything is derived from stored reviews (no re-analysis): game phase from the
material on the board, clocks from the PGN's [%clk] comments, mistake types from
the position and engine evals.
"""
from __future__ import annotations

import io
import os
import pickle
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import chess
import chess.pgn

from . import classify as C
from . import habits, tactics
from . import storage
from .config import USERDATA, my_names, write_atomic

ERRORS = {C.INACCURACY, C.MISTAKE, C.MISS, C.BLUNDER}
SEVERE = {C.MISTAKE, C.MISS, C.BLUNDER}
SHORT_GAME_MOVES = 10  # your own moves; shorter games say little about accuracy

TAGS = {
    "hung_piece": "Hung a piece",
    "allowed_mate": "Allowed a mate",
    "missed_mate": "Missed a mate",
    "missed_punish": "Didn't punish a mistake",
    "missed_tactic": "Missed a winning shot",
    "positional": "Lost the thread",
}

CLOCK_BUCKETS = [(10, "< 10s"), (30, "10–30s"), (60, "30–60s"), (180, "1–3 min"), (float("inf"), "3+ min")]
SPENT_BUCKETS = [(2, "< 2s"), (5, "2–5s"), (15, "5–15s"), (60, "15–60s"), (float("inf"), "60s+")]


# --------------------------------------------------------------------------- #
#  Per-game feature extraction (cached per review)
# --------------------------------------------------------------------------- #

def time_class(tc: str) -> str:
    """Lichess's classification: estimated duration = base + 40 * increment."""
    if not tc or tc in ("-", "?"):
        return "unknown"
    if "/" in tc:
        return "daily"
    try:
        base, _, inc = tc.partition("+")
        est = int(base) + 40 * int(inc or 0)
    except ValueError:
        return "unknown"
    if est < 180:
        return "bullet"
    if est < 480:
        return "blitz"
    if est < 1500:
        return "rapid"
    return "classical"


def _increment(tc: str) -> float:
    try:
        return float(tc.split("+")[1]) if "+" in tc else 0.0
    except ValueError:
        return 0.0


def _clocks(pgn: str) -> list[float | None]:
    """Clock (seconds) after each ply, if the PGN has [%clk] comments."""
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return []
    return [node.clock() for node in game.mainline()]


def _phase(board: chess.Board, fullmove: int, cls: str) -> str:
    pieces = sum(len(board.pieces(pt, c)) for pt in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
                 for c in chess.COLORS)
    if pieces <= 6:
        return "endgame"
    if cls == C.BOOK or fullmove <= 10:
        return "opening"
    return "middlegame"


def _tag(m: dict, board: chess.Board, mover: chess.Color) -> str:
    best, after = m["bestEval"], m["eval"]
    sign = 1 if mover == chess.WHITE else -1
    if "mate" in after and after["mate"] * sign < 0:
        return "allowed_mate"
    if "mate" in best and best["mate"] * sign > 0:
        return "missed_mate"
    if m["cls"] == C.MISS:
        return "missed_punish"
    sac, _ = C.sacrifice(board, chess.Move.from_uci(m["uci"]))
    if sac >= 2:
        return "hung_piece"
    # The engine's move was a capture/check that won a lot: you missed a tactic.
    best_move = chess.Move.from_uci(m["bestUci"])
    if m["loss"] >= 0.2 and (board.is_capture(best_move) or board.gives_check(best_move)):
        return "missed_tactic"
    return "positional"


@dataclass
class Game:
    record: dict
    me: str
    tc: str
    moves: list[dict]  # my moves with features
    my_wins: list[float]  # my win% (0..100) for every position
    outcome: str  # win | draw | loss
    ts: float  # when the game was played (epoch seconds)
    elo: int | None  # your rating in that game
    opp_elo: int | None = None
    end: str = "other"  # how the game ended (checkmate, resignation, time, …)
    habits: dict | None = None  # opening habits (castling, early queen, development)


# id -> ((mtime, your names), Game). Only slim per-game data is kept in memory.
_cache: dict[str, tuple[tuple, "Game | None"]] = {}
SLIM_KEYS = ("id", "white", "black", "date", "accuracy", "opening", "plies")
EXAMPLE_CAP = 150  # example positions per category sent to the UI (drills use up to 60)
# "Clearly winning / clearly lost": your win chance reached this at some point (shared with stats.py,
# so Insights and Progress count the same games).
WINNING_PCT, LOSING_PCT = 85, 15


CACHE_FILE = USERDATA / "cache" / "insights.pkl"
CACHE_VERSION = 8  # bump when per-game features change
_loaded_from_disk = False


def _load_disk_cache() -> None:
    """Per-game features survive restarts, so the first Insights load stays fast."""
    global _loaded_from_disk
    _loaded_from_disk = True
    try:
        with CACHE_FILE.open("rb") as f:
            version, data = pickle.load(f)
        if version == CACHE_VERSION:
            _cache.update(data)
    except (OSError, pickle.PickleError, EOFError, ValueError, AttributeError):
        pass


def _save_disk_cache() -> None:
    try:
        write_atomic(CACHE_FILE, pickle.dumps((CACHE_VERSION, dict(_cache)), protocol=pickle.HIGHEST_PROTOCOL))
    except OSError:
        pass


def _fell_for(moves: list[dict], i: int) -> str | None:
    """Theme of the opponent's best reply after my move i (what my mistake allowed)."""
    if i + 1 >= len(moves):
        return None
    nxt = moves[i + 1]
    return tactics.theme_of_line(chess.Board(moves[i]["fen"]), nxt.get("bestLine") or [nxt["bestSan"]],
                                 chess.Board(moves[i]["fenBefore"]))


END_REASONS = {
    "checkmate": "Checkmate", "resignation": "Resignation", "time": "On time", "abandoned": "Abandoned",
    "stalemate": "Stalemate", "repetition": "Repetition", "agreement": "Agreement",
    "insufficient": "Insufficient material", "fifty": "50-move rule", "other": "Other",
}


def _end_reason(record: dict) -> str:
    term = (record.get("headers", {}).get("Termination") or "").lower()
    # Chess.com: "<user> won by resignation" – only look past the username (which may contain "50", "time", …).
    for marker in (" won ", "drawn "):
        if marker in term:
            term = term.split(marker, 1)[1]
            break
    last = record["moves"][-1] if record.get("moves") else None
    final = chess.Board(last["fen"]) if last else None
    for key, words in (("checkmate", ("checkmate",)), ("time", ("on time", "time forfeit", "timeout")),
                       ("abandoned", ("abandon",)), ("repetition", ("repetition",)), ("stalemate", ("stalemate",)),
                       ("agreement", ("agreement",)), ("insufficient", ("insufficient",)), ("fifty", ("50-move", "50 move", "fifty")),
                       ("resignation", ("resignation",))):
        if any(w in term for w in words):
            return key
    if final is not None:
        if final.is_checkmate():
            return "checkmate"
        if final.is_stalemate():
            return "stalemate"
        if final.is_insufficient_material():
            return "insufficient"
    result = record.get("result")
    if result in ("1-0", "0-1"):
        return "resignation"  # Lichess "Normal" decisive games that didn't end in mate
    if result == "1/2-1/2":
        return "agreement"
    return "other"


def _habits(record: dict, me: str) -> dict:
    """Opening habits that matter most for improving players."""
    color = chess.WHITE if me == "w" else chess.BLACK
    start_minors = ([chess.B1, chess.G1, chess.C1, chess.F1] if color == chess.WHITE
                    else [chess.B8, chess.G8, chess.C8, chess.F8])
    castle_move = castle_side = None
    early_queen = False
    undeveloped = None
    book_exit = None
    for m in record["moves"]:
        if m["color"] != me:
            continue
        board = chess.Board(m["fenBefore"])
        n = board.fullmove_number
        if m["san"].startswith("O-O") and castle_move is None:
            castle_move, castle_side = n, ("queenside" if m["san"].startswith("O-O-O") else "kingside")
        piece = board.piece_type_at(chess.Move.from_uci(m["uci"]).from_square)
        if piece == chess.QUEEN and n <= 5:
            early_queen = True
        if m["cls"] == C.BOOK:
            book_exit = n
        if n <= 10:
            after = chess.Board(m["fen"])
            undeveloped = sum(1 for sq in start_minors if (p := after.piece_at(sq)) and p.color == color
                              and p.piece_type in (chess.KNIGHT, chess.BISHOP))
    return {"castleMove": castle_move, "castleSide": castle_side, "earlyQueen": early_queen,
            "undevelopedAt10": undeveloped if len(record["moves"]) >= 20 else None, "bookExit": book_exit}


_games_lock = threading.Lock()  # one builder at a time (stats, coach and insights may ask together)
_saved_at = 0.0
SAVE_EVERY = 60.0  # during a batch a review changes every few seconds: don't rewrite the 14 MB cache each time


def _games() -> list["Game"]:
    """Every review as a Game, loading a file only when it changed since last time."""
    with _games_lock:
        return _games_locked()


def _games_locked() -> list["Game"]:
    global _saved_at
    if not _loaded_from_disk:
        _load_disk_cache()
    names = frozenset(my_names())
    out, live, dirty = [], set(), False
    for gid, mtime in storage.index():
        live.add(gid)
        cached = _cache.get(gid)
        if cached and cached[0] == (mtime, names):
            g = cached[1]
        else:
            try:
                record = storage.load(gid)
            except ValueError:
                record = None
            g = _build(record) if record else None
            _cache[gid] = ((mtime, names), g)
            dirty = True
        if g:
            out.append(g)
    for gone in set(_cache) - live:
        del _cache[gone]
        dirty = True
    if dirty and time.monotonic() - _saved_at >= SAVE_EVERY:
        # Throttled: a missed save only means the few changed games are rebuilt on the next start.
        _save_disk_cache()
        _saved_at = time.monotonic()
    return out


def _build(record: dict) -> Game | None:
    me = record.get("me")
    if not me or not record.get("moves"):
        return None
    headers = record.get("headers", {})
    tc_raw = headers.get("TimeControl", record.get("timeControl", ""))
    inc = _increment(tc_raw)
    clocks = _clocks(record.get("pgn", ""))
    base = None
    try:
        base = float(tc_raw.split("+")[0]) if tc_raw and "/" not in tc_raw else None
    except ValueError:
        pass

    mover_white = me == "w"
    wins = [w if mover_white else 100 - w for w in record["winPct"]]
    result = record.get("result", "*")
    outcome = "draw" if result == "1/2-1/2" else ("win" if result == ("1-0" if mover_white else "0-1") else
                                                   "loss" if result in ("1-0", "0-1") else "unknown")

    mine = []
    for i, m in enumerate(record["moves"]):
        if m["color"] != me:
            continue
        board = chess.Board(m["fenBefore"])
        before, after = wins[i], wins[i + 1]
        acc = C.move_accuracy(before, after) if m["cls"] not in (C.BEST, C.BRILLIANT, C.GREAT, C.BOOK, C.FORCED) else 100.0
        # Clock: remaining before this move = my clock after my previous move.
        remaining = spent = None
        if len(clocks) > i and clocks[i] is not None:
            prev = clocks[i - 2] if i >= 2 else base
            if prev is not None:
                remaining = prev
                spent = max(0.0, prev - clocks[i] + inc)
        piece = board.piece_type_at(chess.Move.from_uci(m["uci"]).from_square)
        mine.append({
            "ply": m["ply"], "san": m["san"], "cls": m["cls"], "loss": m["loss"], "acc": acc,
            "phase": _phase(board, board.fullmove_number, m["cls"]),
            "piece": chess.piece_name(piece) if piece else "?",
            "remaining": remaining, "spent": spent,
            "tag": _tag(m, board, board.turn) if m["cls"] in ERRORS else None,
            "fenBefore": m["fenBefore"], "bestSan": m["bestSan"], "uci": m["uci"], "bestUci": m.get("bestUci"),
            # Coaching: which bad habits this mistake shows (see habits.py).
            "habits": habits.tags(record["moves"], i) if m["cls"] in ERRORS else None,
            # Tactic themes: what the opponent punished you with / what you missed.
            "fellFor": _fell_for(record["moves"], i) if m["cls"] in SEVERE else None,
            "missed": (tactics.theme_of_line(board, m.get("bestLine") or [m["bestSan"]],
                                             tactics.exchange_start(record["moves"], i))
                       if m["cls"] in SEVERE and (m["loss"] >= 0.10 or m["cls"] == C.MISS) else None),
        })

    elo_raw = str(record.get("whiteElo" if mover_white else "blackElo") or "")
    opp_raw = str(record.get("blackElo" if mover_white else "whiteElo") or "")
    slim = {k: record.get(k) for k in SLIM_KEYS}
    slim["plies"] = len(record["moves"])
    return Game(record=slim, me=me, tc=time_class(tc_raw), moves=mine, my_wins=wins, outcome=outcome,
                ts=storage.played_at(record), elo=int(elo_raw) if elo_raw.isdigit() else None,
                opp_elo=int(opp_raw) if opp_raw.isdigit() else None,
                end=_end_reason(record), habits=_habits(record, me))


# --------------------------------------------------------------------------- #
#  Aggregation
# --------------------------------------------------------------------------- #

def _rate(n: int, d: int) -> float | None:
    return round(n / d, 4) if d else None


def _bucket(value: float, buckets) -> str:
    return next(label for limit, label in buckets if value < limit)


def _ref(g: Game, m: dict) -> dict:
    r = g.record
    return {"gameId": r["id"], "ply": m["ply"], "san": m["san"], "cls": m["cls"], "bestSan": m["bestSan"],
            "fenBefore": m["fenBefore"], "white": r.get("white"), "black": r.get("black"), "date": r.get("date")}


def _newest(pairs: list[tuple["Game", dict]]) -> list[tuple["Game", dict]]:
    """Most recent games first, capped – the UI shows a sample and drills a subset anyway."""
    return sorted(pairs, key=lambda gm: (-gm[0].ts, gm[1]["ply"]))[:EXAMPLE_CAP]


def _opening_family(name: str | None) -> str:
    return (name or "Unknown").split(":")[0].strip()


def _parse_day(day: str | None) -> float | None:
    if not day:
        return None
    return datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()


def _selection(tc: str, color: str, games: list[Game] | None = None) -> list[Game]:
    games = list(games if games is not None else _games())
    if tc != "all":
        games = [g for g in games if g.tc == tc]
    if color in ("w", "b"):
        games = [g for g in games if g.me == color]
    return sorted(games, key=lambda g: g.ts, reverse=True)  # newest first


_memo: dict = {}  # (args, reviews signature) -> report


def _signature():
    return hash((tuple(sorted(storage.index())), frozenset(my_names())))


def compute(*args, **kwargs) -> dict:
    """Insights for a selection – remembered until a review changes, so revisits and filter flips are instant."""
    key = (args, tuple(sorted(kwargs.items())))
    sig = _signature()
    hit = _memo.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    report = _compute(*args, **kwargs)
    if len(_memo) > 16:  # each report is ~0.5 MB
        _memo.clear()
    _memo[key] = (sig, report)
    return report


def _compute(tc: str = "all", color: str = "all", last: int = 0,
            since: str | None = None, until: str | None = None, compare: bool = True) -> dict:
    all_games = _games()
    available_tcs = sorted({g.tc for g in all_games})
    selection = _selection(tc, color, all_games)
    lo, hi = _parse_day(since), _parse_day(until)
    games = [g for g in selection if (lo is None or g.ts >= lo) and (hi is None or g.ts < hi + 86400)]
    if last:
        games = games[:last]
    # "Before this period" baseline, so recent form can be told apart from old games.
    baseline = None
    earlier: list[Game] = []
    if compare and lo is not None:
        earlier = [g for g in selection if g.ts < lo]
    elif compare and last and len(selection) > last:
        earlier = selection[last:]
    if len(earlier) >= 3:
        baseline = core(earlier)

    moves = [(g, m) for g in games for m in g.moves]
    out: dict = {"games": len(games), "moves": len(moves), "timeClasses": available_tcs,
                 "span": [games[-1].ts, games[0].ts] if games else None,
                 "allSpan": [selection[-1].ts, selection[0].ts] if selection else None,
                 "core": core(games) if games else None, "baseline": baseline}
    if not moves:
        out["summary"] = []
        return out

    # ---- headline ----------------------------------------------------------
    long_games = [g for g in games if len(g.moves) >= SHORT_GAME_MOVES]
    weighted = [(g.record["accuracy"][g.me], len(g.moves)) for g in long_games if g.record["accuracy"].get(g.me) is not None]
    out["accuracy"] = round(sum(a * n for a, n in weighted) / sum(n for _, n in weighted), 1) if weighted else None
    out["blundersPerGame"] = round(sum(1 for _, m in moves if m["cls"] == C.BLUNDER) / len(games), 2)
    out["errorsPer40"] = round(sum(1 for _, m in moves if m["cls"] in SEVERE) / len(moves) * 40, 2)
    out["record"] = {k: sum(1 for g in games if g.outcome == k) for k in ("win", "draw", "loss")}

    # ---- phases -------------------------------------------------------------
    phases = []
    for ph in ("opening", "middlegame", "endgame"):
        ms = [m for _, m in moves if m["phase"] == ph]
        errs = [(g, m) for g, m in moves if m["phase"] == ph and m["cls"] in SEVERE]
        phases.append({
            "examples": [_ref(g, m) for g, m in _newest(errs)], "count": len(errs),
            "phase": ph, "moves": len(ms),
            "accuracy": round(sum(m["acc"] for m in ms) / len(ms), 1) if ms else None,
            "errorRate": _rate(sum(1 for m in ms if m["cls"] in SEVERE), len(ms)),
            "blunders": sum(1 for m in ms if m["cls"] == C.BLUNDER),
            "lossPerMove": round(sum(m["loss"] for m in ms) / len(ms) * 100, 2) if ms else None,
        })
    out["phases"] = phases

    # ---- clock --------------------------------------------------------------
    timed = [(g, m) for g, m in moves if m["remaining"] is not None]

    def by(buckets, field):
        # One pass: each move goes into its bucket once (was: every bucket scanned every move).
        groups: dict[str, list[int]] = {label: [0, 0, 0] for _, label in buckets}  # moves, errors, blunders
        for _, m in timed:
            v = m[field]
            if v is None:
                continue
            g = groups[_bucket(v, buckets)]
            g[0] += 1
            g[1] += m["cls"] in SEVERE
            g[2] += m["cls"] == C.BLUNDER
        return [{"bucket": label, "moves": groups[label][0], "errorRate": _rate(groups[label][1], groups[label][0]),
                 "blunderRate": _rate(groups[label][2], groups[label][0])} for _, label in buckets]

    out["clock"] = {"moves": len(timed), "remaining": by(CLOCK_BUCKETS, "remaining"), "spent": by(SPENT_BUCKETS, "spent")}

    # ---- mistake types ------------------------------------------------------
    tags = []
    for tag, label in TAGS.items():
        hits = [(g, m) for g, m in moves if m["tag"] == tag and m["cls"] in SEVERE]
        tags.append({"tag": tag, "label": label, "count": len(hits),
                     "games": len({g.record["id"] for g, _ in hits}),
                     "examples": [_ref(g, m) for g, m in _newest(hits)]})
    out["tags"] = sorted(tags, key=lambda t: -t["count"])

    # ---- pieces -------------------------------------------------------------
    pieces = defaultdict(lambda: [0, 0, 0])
    for _, m in moves:
        p = pieces[m["piece"]]
        p[0] += 1
        p[1] += m["cls"] in SEVERE
        p[2] += m["cls"] == C.BLUNDER
    out["pieces"] = sorted(({"piece": k, "moves": v[0], "errors": v[1], "blunders": v[2], "errorRate": _rate(v[1], v[0])}
                            for k, v in pieces.items() if k != "?"), key=lambda r: -(r["errorRate"] or 0))

    # ---- openings -----------------------------------------------------------
    op = defaultdict(list)
    for g in games:
        op[(_opening_family((g.record.get("opening") or {}).get("name")), g.me)].append(g)
    openings = []
    for (name, col), gs in op.items():
        score = sum(1 if g.outcome == "win" else 0.5 if g.outcome == "draw" else 0 for g in gs) / len(gs)
        accs = [g.record["accuracy"][g.me] for g in gs if g.record["accuracy"].get(g.me) is not None]
        open_moves = [m for g in gs for m in g.moves if m["phase"] == "opening"]
        openings.append({"name": name, "color": col, "games": len(gs), "score": round(score * 100),
                         "accuracy": round(sum(accs) / len(accs), 1) if accs else None,
                         "openingAccuracy": round(sum(m["acc"] for m in open_moves) / len(open_moves), 1) if open_moves else None})
    out["openings"] = sorted(openings, key=lambda o: (-o["games"], o["score"]))

    # ---- thrown wins & comebacks -------------------------------------------
    thrown, comebacks = [], []
    for g in games:
        w = g.my_wins
        peak_i = max(range(len(w)), key=lambda i: w[i])
        if w[peak_i] >= WINNING_PCT and g.outcome in ("draw", "loss"):
            after_peak = [m for m in g.moves if m["ply"] > peak_i]
            worst = max(after_peak, key=lambda m: m["loss"], default=None)
            if worst:
                thrown.append({**_ref(g, worst), "peak": round(w[peak_i]), "outcome": g.outcome, "playedAt": g.ts,
                               "moves": g.record["plies"]})
        low = min(w)
        if low <= LOSING_PCT and g.outcome in ("win", "draw"):
            comebacks.append({"gameId": g.record["id"], "white": g.record.get("white"), "black": g.record.get("black"),
                              "date": g.record.get("date"), "low": round(low), "outcome": g.outcome, "playedAt": g.ts})
    out["thrownCount"], out["comebackCount"] = len(thrown), len(comebacks)
    out.update(_beginner_sections(games, moves))
    out["thrown"] = sorted(thrown, key=lambda t: -t["playedAt"])[:EXAMPLE_CAP]
    out["comebacks"] = sorted(comebacks, key=lambda t: -t["playedAt"])[:EXAMPLE_CAP]
    out["summary"] = _trend_tips(out["core"], baseline) + _summary(out, games) + _habit_tips(out)
    out["focus"] = _focus(out)
    return out


OPENING_MIN_GAMES = 8  # fewer games say more about luck than about the opening


def _summary(o: dict, games: list[Game]) -> list[dict]:
    """A few plain-language takeaways, strongest signal first."""
    tips: list[dict] = []

    ph = [p for p in o["phases"] if p["moves"] >= 30 and p["accuracy"] is not None]
    if len(ph) >= 2:
        worst = min(ph, key=lambda p: p["accuracy"])
        best = max(ph, key=lambda p: p["accuracy"])
        if best["accuracy"] - worst["accuracy"] >= 4:
            tips.append({"kind": "phase", "tone": "bad",
                         "text": f"Your {worst['phase']} is your weak spot: your moves there average {worst['accuracy']}% "
                                 f"accuracy, vs {best['accuracy']}% in the {best['phase']}."})

    rem = {r["bucket"]: r for r in o["clock"]["remaining"]}
    low = [rem[b] for b in ("< 10s", "10–30s") if rem[b]["moves"]]
    high = [r for r in o["clock"]["remaining"] if r["bucket"] not in ("< 10s", "10–30s") and r["moves"]]
    lm, hm = sum(r["moves"] for r in low), sum(r["moves"] for r in high)
    if lm >= 15 and hm >= 30:
        le = sum(r["errorRate"] * r["moves"] for r in low) / lm
        he = sum(r["errorRate"] * r["moves"] for r in high) / hm
        if he > 0 and le / he >= 1.5:
            tips.append({"kind": "clock", "tone": "bad",
                         "text": f"Time trouble hurts: under 30 seconds you make a mistake every {1 / le:.0f} moves, "
                                 f"vs every {1 / he:.0f} with more time. Save clock for the critical moments."})

    sp = {r["bucket"]: r for r in o["clock"]["spent"]}
    fast = sp["< 2s"]
    slow = [r for k, r in sp.items() if k not in ("< 2s", "2–5s") and r["moves"]]
    sm = sum(r["moves"] for r in slow)
    if fast["moves"] >= 20 and sm >= 20 and fast["errorRate"]:
        se = sum(r["errorRate"] * r["moves"] for r in slow) / sm
        if se and fast["errorRate"] / se >= 1.5:
            tips.append({"kind": "speed", "tone": "bad",
                         "text": f"Your instant moves (< 2s) go wrong {fast['errorRate'] * 100:.0f}% of the time – "
                                 f"{fast['errorRate'] / se:.1f}× more than when you take a moment."})

    top = next((t for t in o["tags"] if t["count"] and t["tag"] != "positional"), None)
    if top and o["games"] >= 3:
        tips.append({"kind": "tag", "tone": "bad", "tag": top["tag"],
                     "text": f"Most common costly mistake: {top['label'].lower()} – {top['count']}× in "
                             f"{top['games']} of {o['games']} games."})

    pieces = [p for p in o["pieces"] if p["moves"] >= 15]
    if len(pieces) >= 3:
        p = pieces[0]
        avg = sum(x["errors"] for x in pieces) / sum(x["moves"] for x in pieces)
        if avg and (p["errorRate"] or 0) / avg >= 1.4:
            tips.append({"kind": "piece", "tone": "bad",
                         "text": f"Careful with your {p['piece']}: {p['errorRate'] * 100:.0f}% of your {p['piece']} "
                                 f"moves are mistakes (average {avg * 100:.0f}%)."})

    # Openings: only with enough games to mean something, and judged against your overall score.
    overall = _score(games)
    ops = [x for x in o["openings"] if x["games"] >= OPENING_MIN_GAMES]
    if ops and overall is not None:
        w = min(ops, key=lambda x: x["score"])
        if w["score"] <= min(40, overall - 15):
            side = "White" if w["color"] == "w" else "Black"
            tips.append({"kind": "opening", "tone": "bad",
                         "text": f"{w['name']} (you with {side}) is costing you: {w['score']}% score over {w['games']} games "
                                 f"(you score {overall:.0f}% overall)."})
        b = max(ops, key=lambda x: x["score"])
        if b["score"] >= max(60, overall + 15) and b is not w:
            side = "White" if b["color"] == "w" else "Black"
            tips.append({"kind": "opening", "tone": "good",
                         "text": f"{b['name']} (you with {side}) works for you: {b['score']}% score in {b['games']} games "
                                 f"(you score {overall:.0f}% overall)."})

    if o["thrown"]:
        tips.append({"kind": "thrown", "tone": "bad",
                     "text": f"You let {o['thrownCount']} winning position{'s' if o['thrownCount'] > 1 else ''} slip "
                             f"({WINNING_PCT}%+ to win, then didn't). Converting is free rating."})
    if o["comebacks"]:
        tips.append({"kind": "comeback", "tone": "good",
                     "text": f"{o['comebackCount']} comeback{'s' if o['comebackCount'] > 1 else ''} from a lost "
                             f"position. You don't give up."})
    return tips


# --------------------------------------------------------------------------- #
#  Over time
# --------------------------------------------------------------------------- #

def core(games: list[Game]) -> dict:
    """The handful of headline numbers used for comparisons and trend lines."""
    moves = [m for g in games for m in g.moves]
    long_games = [g for g in games if len(g.moves) >= SHORT_GAME_MOVES]
    w = [(g.record["accuracy"][g.me], len(g.moves)) for g in long_games if g.record["accuracy"].get(g.me) is not None]
    scored = [g for g in games if g.outcome != "unknown"]
    rated = [g.elo for g in games if g.elo]
    out = {
        "games": len(games),
        "accuracy": round(sum(a * n for a, n in w) / sum(n for _, n in w), 1) if w else None,
        "blundersPerGame": round(sum(m["cls"] == C.BLUNDER for m in moves) / len(games), 2) if games else None,
        "errorsPer40": round(sum(m["cls"] in SEVERE for m in moves) / len(moves) * 40, 2) if moves else None,
        "winRate": round(sum(1 if g.outcome == "win" else 0.5 if g.outcome == "draw" else 0 for g in scored)
                         / len(scored) * 100, 1) if scored else None,
        "rating": round(sum(rated) / len(rated)) if rated else None,
    }
    for ph in ("opening", "middlegame", "endgame"):
        ms = [m for m in moves if m["phase"] == ph]
        out[ph] = round(sum(m["acc"] for m in ms) / len(ms), 1) if len(ms) >= 10 else None
    for tag in TAGS:
        if tag != "positional":
            out[tag] = round(sum(m["tag"] == tag and m["cls"] in SEVERE for m in moves) / len(games), 2) if games else None
    return out


def trend(tc: str = "all", color: str = "all", bucket: str = "auto") -> dict:
    games = sorted(_selection(tc, color), key=lambda g: g.ts)
    if not games:
        return {"bucket": bucket, "points": []}
    if bucket == "auto":
        bucket = "week" if games[-1].ts - games[0].ts < 120 * 86400 else "month"

    groups: list[tuple[str, float, list[Game]]] = []
    if bucket == "games":
        size = 20
        for i in range(0, len(games), size):
            chunk = games[i:i + size]
            groups.append((f"#{i + 1}-{i + len(chunk)}", chunk[0].ts, chunk))
    else:
        by: dict[str, list[Game]] = {}
        starts: dict[str, float] = {}
        for g in games:
            d = datetime.fromtimestamp(g.ts, tz=timezone.utc)
            if bucket == "week":
                start = (d - timedelta(days=d.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
                label = start.strftime("%d %b")
            else:
                start = d.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                label = start.strftime("%b %Y")
            by.setdefault(label, []).append(g)
            starts[label] = start.timestamp()
        groups = sorted(((label, starts[label], gs) for label, gs in by.items()), key=lambda x: x[1])

    points = [{"label": label, "start": start, "end": gs[-1].ts, **core(gs)} for label, start, gs in groups]
    return {"bucket": bucket, "points": points}


def _trend_tips(now: dict | None, before: dict | None) -> list[dict]:
    """How this period compares with your earlier games - the "am I improving?" answer."""
    if not now or not before or now["games"] < 3:
        return []
    tips = []
    a, b = now.get("accuracy"), before.get("accuracy")
    if a is not None and b is not None and abs(a - b) >= 1.5:
        up = a > b
        tips.append({"kind": "trend", "tone": "good" if up else "bad",
                     "text": f"Accuracy {'up' if up else 'down'} to {a}% from {b}% in your earlier games."})
    bn, bb = now.get("blundersPerGame"), before.get("blundersPerGame")
    if bn is not None and bb and abs(bn - bb) / bb >= 0.2:
        fewer = bn < bb
        tips.append({"kind": "trend", "tone": "good" if fewer else "bad",
                     "text": f"{'Fewer' if fewer else 'More'} blunders: {bn} per game now vs {bb} before "
                             f"({abs(bn - bb) / bb * 100:.0f}% {'less' if fewer else 'more'})."})
    deltas = [(ph, now[ph] - before[ph]) for ph in ("opening", "middlegame", "endgame")
              if now.get(ph) is not None and before.get(ph) is not None]
    if deltas:
        ph, d = max(deltas, key=lambda x: x[1])
        if d >= 2:
            tips.append({"kind": "trend", "tone": "good", "text": f"Your {ph} improved the most: +{d:.1f}% accuracy vs earlier games."})
        ph, d = min(deltas, key=lambda x: x[1])
        if d <= -2:
            tips.append({"kind": "trend", "tone": "bad", "text": f"Your {ph} slipped: {d:.1f}% accuracy vs earlier games."})
    rn, rb = now.get("rating"), before.get("rating")
    if rn and rb and abs(rn - rb) >= 25:
        tips.append({"kind": "trend", "tone": "good" if rn > rb else "bad",
                     "text": f"Average rating {rn} in this period vs {rb} before ({rn - rb:+d})."})
    return tips


# --------------------------------------------------------------------------- #
#  Beginner-oriented sections
# --------------------------------------------------------------------------- #

def _score(gs: list[Game]) -> float | None:
    scored = [g for g in gs if g.outcome != "unknown"]
    if not scored:
        return None
    return round(sum(1 if g.outcome == "win" else 0.5 if g.outcome == "draw" else 0 for g in scored) / len(scored) * 100, 1)


def _acc(gs: list[Game]) -> float | None:
    w = [(g.record["accuracy"][g.me], len(g.moves)) for g in gs
         if len(g.moves) >= SHORT_GAME_MOVES and g.record["accuracy"].get(g.me) is not None]
    return round(sum(a * n for a, n in w) / sum(n for _, n in w), 1) if w else None


def _beginner_sections(games: list[Game], moves: list[tuple[Game, dict]]) -> dict:
    out: dict = {}

    # Tactics: what you fall for (opponent's punishing idea) and what you miss (your best idea).
    for key, field in (("tacticsAgainst", "fellFor"), ("tacticsMissed", "missed")):
        rows = []
        for theme, label in tactics.THEMES.items():
            hits = [(g, m) for g, m in moves if m[field] == theme]
            if hits:
                rows.append({"theme": theme, "label": label, "tip": tactics.TIPS[theme], "count": len(hits),
                             "games": len({g.record["id"] for g, _ in hits}),
                             "examples": [_ref(g, m) for g, m in _newest(hits)[:60]]})
        out[key] = sorted(rows, key=lambda r: -r["count"])

    # How games end.
    ends: dict[str, dict[str, int]] = {"win": defaultdict(int), "loss": defaultdict(int), "draw": defaultdict(int)}
    for g in games:
        if g.outcome in ends:
            ends[g.outcome][g.end] += 1
    out["endings"] = {k: sorted(({"reason": r, "label": END_REASONS[r], "count": c} for r, c in v.items()),
                                key=lambda x: -x["count"]) for k, v in ends.items()}

    # Opening habits.
    hs = [(g, g.habits) for g in games if g.habits and g.habits.get("undevelopedAt10") is not None]
    if hs:
        castled = [(g, h) for g, h in hs if h["castleMove"]]
        early = [g for g, h in hs if h["castleMove"] and h["castleMove"] <= 10]
        late = [g for g, h in hs if not h["castleMove"] or h["castleMove"] > 10]
        books = [h["bookExit"] for _, h in hs if h["bookExit"]]
        out["habits"] = {
            "games": len(hs),
            "castleRate": round(len(castled) / len(hs) * 100),
            "avgCastleMove": round(sum(h["castleMove"] for _, h in castled) / len(castled), 1) if castled else None,
            "kingsideShare": round(sum(h["castleSide"] == "kingside" for _, h in castled) / len(castled) * 100) if castled else None,
            "earlyQueenRate": round(sum(h["earlyQueen"] for _, h in hs) / len(hs) * 100),
            "underdevelopedRate": round(sum(h["undevelopedAt10"] >= 2 for _, h in hs) / len(hs) * 100),
            "avgBookExit": round(sum(books) / len(books), 1) if books else None,
            "scoreCastledBy10": _score(early), "gamesCastledBy10": len(early),
            "scoreNotCastledBy10": _score(late), "gamesNotCastledBy10": len(late),
            "scoreEarlyQueen": _score([g for g, h in hs if h["earlyQueen"]]),
            "scoreNoEarlyQueen": _score([g for g, h in hs if not h["earlyQueen"]]),
        }

    # Opponent strength.
    buckets = [(-10_000, -200, "200+ lower"), (-200, -50, "50–200 lower"), (-50, 50, "about equal"),
               (50, 200, "50–200 higher"), (200, 10_000, "200+ higher")]
    rows = []
    for lo, hi, label in buckets:
        gs = [g for g in games if g.elo and g.opp_elo and lo <= g.opp_elo - g.elo < hi]
        rows.append({"label": label, "games": len(gs), "score": _score(gs), "accuracy": _acc(gs)})
    out["vsRating"] = rows

    # Converting advantages / saving bad positions.
    winning = [g for g in games if max(g.my_wins) >= WINNING_PCT]
    losing = [g for g in games if min(g.my_wins) <= LOSING_PCT]
    out["conversion"] = {
        "winningGames": len(winning),
        "converted": round(sum(g.outcome == "win" for g in winning) / len(winning) * 100) if winning else None,
        "losingGames": len(losing),
        "saved": round(sum(g.outcome in ("win", "draw") for g in losing) / len(losing) * 100) if losing else None,
    }

    # Tilt: after a blunder, how often does another one follow within your next 3 moves?
    after_blunder = followed = 0
    total_moves = sum(len(g.moves) for g in games)
    blunders = sum(m["cls"] == C.BLUNDER for _, m in moves)
    for g in games:
        ms = g.moves
        for i, m in enumerate(ms):
            if m["cls"] == C.BLUNDER and i + 3 < len(ms):
                after_blunder += 1
                followed += any(x["cls"] == C.BLUNDER for x in ms[i + 1:i + 4])
    p = blunders / total_moves if total_moves else 0
    out["tilt"] = {
        "samples": after_blunder,
        "rate": round(followed / after_blunder * 100) if after_blunder else None,
        "baseline": round((1 - (1 - p) ** 3) * 100) if total_moves else None,
    }

    # Colours.
    out["colors"] = {c: {"games": len(gs), "score": _score(gs), "accuracy": _acc(gs)}
                     for c, gs in (("w", [g for g in games if g.me == "w"]), ("b", [g for g in games if g.me == "b"]))}
    return out


def _focus(o: dict) -> dict | None:
    """The single most useful thing to practise, with a concrete habit."""
    games = o.get("games") or 0
    if games < 5:
        return None
    cands = []
    against = (o.get("tacticsAgainst") or [])
    if against:
        top = against[0]
        share = top["games"] / games
        if top["theme"] == "free_piece":
            cands.append((share * 1.2, {
                "theme": "free_piece", "title": "Stop giving away pieces",
                "text": f"In {top['games']} of {games} games your opponent simply won material after your move.",
                "tip": tactics.TIPS["free_piece"], "drill": "tacticsAgainst:free_piece"}))
        else:
            cands.append((share, {
                "theme": top["theme"], "title": f"Watch out for {top['label'].lower()}s",
                "text": f"{top['label']}s punished your moves {top['count']}× in {top['games']} games.",
                "tip": tactics.TIPS[top["theme"]], "drill": f"tacticsAgainst:{top['theme']}"}))
    missed = (o.get("tacticsMissed") or [])
    if missed:
        top = missed[0]
        cands.append((top["games"] / games * 0.8, {
            "theme": top["theme"], "title": f"Look for {top['label'].lower()}s",
            "text": f"You missed a winning {top['label'].lower()} {top['count']}× in {top['games']} games.",
            "tip": "Before every move, scan: checks, captures, threats – for you first, then for your opponent.",
            "drill": f"tacticsMissed:{top['theme']}"}))
    losses = o.get("endings", {}).get("loss", [])
    nloss = sum(e["count"] for e in losses)
    on_time = next((e["count"] for e in losses if e["reason"] == "time"), 0)
    if nloss >= 5 and on_time / nloss >= 0.2:
        cands.append((on_time / games * 1.3, {
            "theme": "time", "title": "Manage your clock",
            "text": f"{on_time} of your {nloss} losses were on time.",
            "tip": "Play the opening quickly, spend time only in critical moments, and keep a reserve for the endgame."}))
    h = o.get("habits")
    if h and h["castleRate"] < 70:
        cands.append(((100 - h["castleRate"]) / 100 * 0.5, {
            "theme": "castle", "title": "Castle earlier",
            "text": f"You castle in {h['castleRate']}% of games"
                    + (f" (score {h['scoreCastledBy10']}% when castled by move 10 vs {h['scoreNotCastledBy10']}% otherwise)."
                       if h.get("scoreCastledBy10") is not None and h.get("scoreNotCastledBy10") is not None else "."),
            "tip": "Develop knights and bishops, then castle – ideally within the first 10 moves."}))
    conv = o.get("conversion") or {}
    if conv.get("converted") is not None and conv["winningGames"] >= 5 and conv["converted"] < 75:
        cands.append(((100 - conv["converted"]) / 100 * conv["winningGames"] / games, {
            "theme": "convert", "title": "Finish your won games",
            "text": f"You reached a winning position in {conv['winningGames']} games but won only {conv['converted']}% of them.",
            "tip": "When ahead: trade pieces (not pawns), stop counterplay first, and double-check every capture.",
            "drill": "thrown"}))
    tilt = o.get("tilt") or {}
    if tilt.get("rate") and tilt.get("baseline") and tilt["samples"] >= 10 and tilt["rate"] >= 1.8 * tilt["baseline"]:
        cands.append((tilt["rate"] / 100 * 0.5, {
            "theme": "tilt", "title": "Reset after a blunder",
            "text": f"After a blunder you blunder again within 3 moves {tilt['rate']}% of the time (normally {tilt['baseline']}%).",
            "tip": "After a mistake, take 10 seconds: breathe, re-check the position from scratch, then move."}))
    if not cands:
        return None
    return max(cands, key=lambda c: c[0])[1]


def _habit_tips(o: dict) -> list[dict]:
    """Beginner-friendly takeaways from the extra sections (only when the signal is clear)."""
    tips = []
    t = o.get("tilt") or {}
    if t.get("rate") and t.get("baseline") and t["samples"] >= 10 and t["rate"] >= 1.8 * t["baseline"]:
        tips.append({"kind": "tilt", "tone": "bad",
                     "text": f"Blunders come in pairs: after one, you blunder again within 3 moves {t['rate']}% of the time "
                             f"(vs {t['baseline']}% by chance). Pause and re-check the board after a mistake."})
    losses = (o.get("endings") or {}).get("loss", [])
    n = sum(e["count"] for e in losses)
    on_time = next((e["count"] for e in losses if e["reason"] == "time"), 0)
    if n >= 5 and on_time / n >= 0.2:
        tips.append({"kind": "time", "tone": "bad", "text": f"{on_time} of your {n} losses were on time – keep a clock reserve."})
    h = o.get("habits")
    if h and h["games"] >= 10 and h["earlyQueenRate"] >= 30:
        tips.append({"kind": "habit", "tone": "bad",
                     "text": f"You move your queen in the first 5 moves in {h['earlyQueenRate']}% of games – develop knights and bishops first."})
    if h and h["games"] >= 10 and h["underdevelopedRate"] >= 35:
        tips.append({"kind": "habit", "tone": "bad",
                     "text": f"In {h['underdevelopedRate']}% of games two minor pieces are still at home after move 10 – get them out early."})
    c = o.get("colors") or {}
    if c.get("w", {}).get("games", 0) >= 10 and c.get("b", {}).get("games", 0) >= 10:
        sw, sb = c["w"]["score"], c["b"]["score"]
        if sw is not None and sb is not None and abs(sw - sb) >= 10:
            weak = "Black" if sw > sb else "White"
            tips.append({"kind": "color", "tone": "bad",
                         "text": f"You score {min(sw, sb)}% with {weak} vs {max(sw, sb)}% with the other colour – your {weak} openings deserve a look."})
    return tips
