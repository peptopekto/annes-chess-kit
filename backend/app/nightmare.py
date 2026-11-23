"""The Nightmare: an opponent at your level that plays for *your* weaknesses.

It moves like a human of about your rating (Maia – a neural network trained on millions of human
games, run in Lc0) instead of like Stockfish. Among the human-plausible moves it prefers the ones that
make *you* likely to go wrong:

* Openings: positions from your own reviewed games after which you made mistakes most often.
* Traps: for each candidate it predicts your likely replies (Maia at your rating), and Stockfish checks
  which of them are blunders. Tactic types you personally fall for (from your reviews) weigh extra.
* It stays human: the move is *sampled* from Maia's probabilities, not its single most likely move.
  Maia's top move is the move most players at that rating would agree on, and always playing it is
  far stronger than the rating (the Maia authors say so, too) – a real 1300 also plays the second,
  third and occasionally a losing choice. Only sound moves (by Stockfish) get the trap / opening
  bonus, so the steering never makes it play worse – or better – than a human of that level.
"""
from __future__ import annotations

import json
import math
import random
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import chess
import chess.engine
import yaml

from . import classify as C
from . import bundled, engine, insights, openings, storage, tactics
from .config import DATA, ENGINE_DIR, USERDATA, write_atomic

LC0_DIR = ENGINE_DIR / "lc0"
MAIA_DIR = ENGINE_DIR / "maia"
LEVELS = list(range(1100, 2000, 100))
STATS_FILE = USERDATA / "nightmare.json"
CHESSCOM_SHIFT = 350
POLICY_RE = re.compile(r"^(\S+)\s+\(\s*\d+\s*\)\s+N:.*?\(P:\s*([\d.]+)%\)")
BOOK_PLIES = 24      # opening steering works on the first moves only
TRAP_LOSS = 0.12     # expected-points drop that makes your reply a blunder
# Tactics that count as a trap. A plain hanging piece ("free piece") doesn't: the bot didn't set anything up.
TRAP_THEMES = {"fork", "pin", "skewer", "discovered", "trapped", "back_rank", "mate", "promotion"}
GAMBITS_FILE = DATA / "gambits.yaml"
VARIETY_PLIES = 12   # opening variety: the bot's first 6 moves
VARIETY_SHARE = 0.3  # …among moves played at least this share as often as the most likely one
PLAUSIBLE = 0.35     # Nightmare mode: an alternative needs at least ~this share of the top move's probability
MAX_ALTS = 4         # …and is one of the next few most likely moves


# --------------------------------------------------------------------------- #
#  Maia (human-like move probabilities)
# --------------------------------------------------------------------------- #

def lc0_path() -> Path | None:
    """Lc0 in engine/lc0/ (Windows build with its DLLs) or on the PATH (e.g. installed with a package manager)."""
    bundled.wait()
    found = engine.find_binary("lc0", LC0_DIR, ("lc0",))
    return found[0] if found else None


def available() -> bool:
    if bundled.busy():  # being unpacked: answer from the archive instead of waiting (health checks call this)
        return bundled.includes("lc0/") and bundled.includes("maia/")
    return lc0_path() is not None and any((MAIA_DIR / f"maia-{lv}.pb.gz").exists() for lv in LEVELS)


def nearest_level(rating: float) -> int:
    have = [lv for lv in LEVELS if (MAIA_DIR / f"maia-{lv}.pb.gz").exists()] or LEVELS
    return min(have, key=lambda lv: abs(lv - rating))


class Maia:
    """One Lc0 process per Maia level; `policy` = how likely a human at that level plays each move."""

    def __init__(self, level: int):
        self.level = level
        self._lock = threading.Lock()
        self._eng: chess.engine.SimpleEngine | None = None

    def _ensure(self) -> chess.engine.SimpleEngine:
        if self._eng is None:
            lc0 = lc0_path()
            if lc0 is None:
                raise chess.engine.EngineError("Lc0 not found")
            self._eng = chess.engine.SimpleEngine.popen_uci(str(lc0), cwd=str(lc0.parent), stderr=subprocess.DEVNULL,
                                                            **engine.NO_WINDOW)
            self._eng.configure({"WeightsFile": str(MAIA_DIR / f"maia-{self.level}.pb.gz"), "VerboseMoveStats": True,
                                 "Threads": 1})
        return self._eng

    def policy(self, board: chess.Board) -> list[tuple[chess.Move, float]]:
        with self._lock:
            for attempt in range(2):
                try:
                    with self._ensure().analysis(board, chess.engine.Limit(nodes=1), info=chess.engine.INFO_ALL) as an:
                        strings = [i["string"] for i in an if i.get("string")]
                    break
                except (chess.engine.EngineTerminatedError, chess.engine.EngineError):
                    self._eng = None
                    if attempt:
                        raise
        out: dict[chess.Move, float] = {}
        for s in strings:
            m = POLICY_RE.match(s)
            if not m or m.group(1) == "node":
                continue
            mv = _legal(board, m.group(1))
            if mv is not None:
                out[mv] = out.get(mv, 0.0) + float(m.group(2)) / 100
        total = sum(out.values()) or 1.0
        return sorted(((mv, p / total) for mv, p in out.items()), key=lambda x: -x[1])

    def close(self) -> None:
        with self._lock:
            if self._eng is not None:
                try:
                    self._eng.quit()
                except chess.engine.EngineError:
                    pass
                self._eng = None


def _legal(board: chess.Board, uci: str) -> chess.Move | None:
    """Lc0 writes castling as king-takes-rook (e1h1); return the move in standard notation (e1g1).

    `move in board.legal_moves` accepts e1h1 as castling without converting it, so the raw move
    must not be passed on – parse_uci normalises it.
    """
    try:
        return board.parse_uci(uci)
    except ValueError:  # illegal or malformed
        return None


_maias: dict[int, Maia] = {}
_maia_lock = threading.Lock()


def maia(level: int) -> Maia:
    with _maia_lock:
        if level not in _maias:
            _maias[level] = Maia(level)
        return _maias[level]


# Stockfish for the safety checks and trap detection – its own small engine, so playing doesn't wait
# for a running batch analysis.
_sf = engine.Engine(threads=2, hash_mb=64)


def _search(board: chess.Board, depth: int, moves: list[chess.Move] | None = None) -> list[C.Line]:
    infos = _sf.analyse(board, depth=depth, multipv=len(moves) if moves else 1, root_moves=moves, max_time=2.0)
    return [C.Line(move=i["pv"][0], score=i["score"], pv=i["pv"]) for i in infos if i.get("pv") and "score" in i]


# --------------------------------------------------------------------------- #
#  Your profile: rating, the tactics you fall for, the positions where you go wrong
# --------------------------------------------------------------------------- #

@dataclass
class Profile:
    rating: float
    k: float
    themes: dict[str, float]               # theme -> weight (1 = normal, higher = you fall for it more)
    theme_counts: list[tuple[str, int]]
    book: dict[str, tuple[int, int]]       # EPD (you to move) -> (games reached, games you went wrong soon after)
    base_err: float                        # your usual error rate after an opening position
    games: int
    built: float


_profile: Profile | None = None
_profile_lock = threading.Lock()
PROFILE_TTL = 600.0


RECENT_GAMES = 5     # your rating now: the average of your last few rated games on the site you play most recently


def rating_info() -> dict:
    """Your current playing strength on the Lichess scale, and where it comes from.

    A rating already sums up your whole history, so the latest games say it best (an average of many older games
    lags behind when you improve). Chess.com ratings are moved up to the Lichess scale. A rating you set yourself
    in the bot's setup wins.
    """
    override = _stats().get("rating")
    by_source: dict[str, list[tuple[float, int]]] = {}
    for s in storage.summaries():
        me = s.get("me")
        raw = str(s.get("whiteElo" if me == "w" else "blackElo") or "") if me else ""
        src = s.get("source") or "pgn"
        if raw.isdigit() and src != "nightmare":
            by_source.setdefault(src, []).append((s.get("playedAt") or 0, int(raw)))
    auto, site, latest = None, None, -1.0
    for src, games in by_source.items():
        games.sort(reverse=True)
        if games[0][0] > latest:
            shift = CHESSCOM_SHIFT if "chess.com" in src.lower() else 0
            recent = [elo for _, elo in games[:RECENT_GAMES]]
            auto, site, latest = sum(recent) / len(recent) + shift, src, games[0][0]
    return {"rating": float(override) if override else (auto or 1500.0), "auto": round(auto) if auto else None,
            "site": site, "manual": bool(override)}


def _rating() -> float:
    return rating_info()["rating"]


def set_rating(rating: int | None) -> dict:
    """Use your own rating (Lichess scale) instead of the one read from your games; None goes back to automatic."""
    global _profile
    data = _stats()
    if rating:
        data["rating"] = max(400, min(3000, int(rating)))
    else:
        data.pop("rating", None)
    write_atomic(STATS_FILE, json.dumps(data))
    _profile = None  # rebuilt with the new rating
    return summary()


def profile(refresh: bool = False) -> Profile:
    global _profile
    with _profile_lock:
        if _profile and not refresh and time.time() - _profile.built < PROFILE_TTL:
            return _profile
        games = insights._games()
        themes: dict[str, int] = {}
        book: dict[str, list[int]] = {}
        errs_total = n_total = 0
        for g in games:
            mine = g.moves
            for j, m in enumerate(mine):
                if m.get("fellFor"):
                    themes[m["fellFor"]] = themes.get(m["fellFor"], 0) + 1
                if m["ply"] > BOOK_PLIES:
                    continue
                # Did you go wrong within your next three moves from here?
                soon = mine[j:j + 3]
                bad = any(x["cls"] in (C.MISTAKE, C.BLUNDER, C.MISS) and x["loss"] >= 0.08 for x in soon)
                epd = " ".join(m["fenBefore"].split()[:4])
                e = book.setdefault(epd, [0, 0])
                e[0] += 1
                e[1] += bad
                n_total += 1
                errs_total += bad
        total = sum(themes.values()) or 1
        weights = {t: 1.0 + 3.0 * c / total for t, c in themes.items()}
        rating = _rating()
        _profile = Profile(rating=rating, k=C.k_for_rating(rating), themes=weights,
                           theme_counts=sorted(themes.items(), key=lambda x: -x[1]),
                           book={k: (v[0], v[1]) for k, v in book.items() if v[0] >= 2},
                           base_err=errs_total / n_total if n_total else 0.2, games=len(games), built=time.time())
        return _profile


def _trouble(p: Profile, board_after: chess.Board) -> tuple[float, int] | None:
    """How much more often than usual you went wrong from this position (you to move), and how often you reached it."""
    hit = p.book.get(" ".join(board_after.fen().split()[:4]))
    if not hit:
        return None
    n, bad = hit
    rate = (bad + p.base_err * 2) / (n + 2)  # smoothed towards your usual rate
    return rate - p.base_err, n


# --------------------------------------------------------------------------- #
#  Choosing a move
# --------------------------------------------------------------------------- #

def _ep(score: chess.engine.PovScore, color: chess.Color, k: float) -> float:
    return C.expected_points(score.pov(color), k)


def choose(moves: list[str], strength: int = 100, focus: float = 0.6, gambits: list[str] | None = None,
           variety: bool = False, fen: str | None = None) -> dict:
    """The bot's move after the given game moves (UCI, from the start position – or from `fen` if given).

    `gambits`: ids from data/gambits.yaml ("all" for every one) – when the game is on one of their lines, the
    bot plays the gambit move. `variety`: in the first moves, pick among the moves players at this level often
    play (weighted by how often) instead of always the most likely one.

    Maia's most likely move is the move a player at that level plays, so that is what the bot plays. With
    Nightmare mode on (`focus` > 0) it may play a different move instead – only one a player at that level
    plausibly plays too (close enough in Maia's probability), that is sound, and that steers into your weak
    openings or sets a trap you're likely to fall for. The stronger the focus, the more often that happens.
    """
    board = chess.Board(fen) if fen else chess.Board()
    for u in moves:
        board.push_uci(u)
    if board.is_game_over():
        raise ValueError("The game is over.")
    p = profile()
    me = board.turn                                   # the bot
    focus = max(0.0, min(1.0, focus))
    opp_level = nearest_level(p.rating + strength)
    you_level = nearest_level(p.rating)
    k = p.k

    if gambits:
        g = gambit_move(board, gambits, you_level)
        if g:
            mv, gb = g
            return {**_result(board, {"move": mv, "p": 0.0, "trap": None, "opening": None}, opp_level, you_level, 0),
                    "gambit": gb}

    pol = maia(opp_level).policy(board)
    top_mv, top_p = pol[0]
    top = {"move": top_mv, "p": top_p, "bonus": 0.0, "trap": None, "opening": None}
    if variety and board.ply() < VARIETY_PLIES:
        # Opening variety: one of the moves this level plays often, as often as Maia says it's played.
        common = [(mv, pr) for mv, pr in pol if pr >= VARIETY_SHARE * top_p]
        mv, pr = random.choices(common, weights=[pr for _, pr in common])[0]
        top = {"move": mv, "p": pr, "bonus": 0.0, "trap": None, "opening": None}
        top_p = pr
    if focus <= 0 or len(pol) == 1:
        return _result(board, top, opp_level, you_level, _rank(pol, top["move"]))

    # Alternatives a player at this level plays nearly as often as the top move.
    share = PLAUSIBLE - 0.2 * focus                   # Human 0.31, Sneaky 0.23, Ruthless 0.17 of the top move
    alts = [{"move": mv, "p": pr, "bonus": 0.0, "trap": None, "opening": None}
            for mv, pr in pol[1:MAX_ALTS + 1] if pr >= max(0.04, share * top_p)]

    # Soundness: an alternative must not throw away the game (Stockfish's view); the top move needs no check.
    if alts:
        best = _search(board, 12)
        ep_best = _ep(best[0].score, me, k) if best else 0.5
        lines = {ln.move: ln for ln in _search(board, 11, [a["move"] for a in alts])}
        margin = 0.10 - 0.05 * focus
        alts = [a for a in alts if (ln := lines.get(a["move"])) and ep_best - _ep(ln.score, me, k) <= margin]

    in_book = board.ply() < BOOK_PLIES
    for c in [top, *alts]:
        after = board.copy(stack=False)
        after.push(c["move"])
        if in_book:
            t = _trouble(p, after)
            if t and t[0] > 0:
                c["opening"] = {"games": t[1], "extra": round(t[0], 3)}
                c["bonus"] += min(1.0, t[0] / 0.25) * 0.8
        if after.is_game_over():
            continue
        trap = _trap(after, you_level, k, p)
        c["trap"] = trap
        if trap:
            c["bonus"] += min(1.0, trap["value"] / 0.12)

    # Deterministic: the top move, unless an alternative's bonus outweighs how much less likely it is.
    def score(c: dict) -> float:
        return math.log(c["p"] / top_p) + 3.0 * focus * c["bonus"]

    pick = max([top, *(a for a in alts if a["move"] != top["move"])], key=score)
    return _result(board, pick, opp_level, you_level, _rank(pol, pick["move"]))


def _rank(pol: list[tuple[chess.Move, float]], move: chess.Move) -> int:
    return next((i for i, (mv, _) in enumerate(pol, 1) if mv == move), 0)


# --------------------------------------------------------------------------- #
#  Gambits (data/gambits.yaml)
# --------------------------------------------------------------------------- #

def _epd(board: chess.Board) -> str:
    return " ".join(board.fen().split()[:4])


@lru_cache(maxsize=1)
def _gambit_book() -> tuple[list[dict], dict[str, list[tuple[str, str]]]]:
    """The gambits, and for every position on their lines (the bot to move): (gambit id, move to play)."""
    raw = yaml.safe_load(GAMBITS_FILE.read_text(encoding="utf-8")) or []
    book: dict[str, list[tuple[str, str]]] = {}
    out = []
    for g in raw:
        bot = chess.WHITE if g["bot"] == "w" else chess.BLACK
        for line in g["lines"]:
            board = chess.Board()
            for san in line.split():
                mv = board.parse_san(san)  # raises on an illegal line (the tests check every line)
                if board.turn == bot:
                    entry = (g["id"], mv.uci())
                    if entry not in book.setdefault(_epd(board), []):
                        book[_epd(board)].append(entry)
                board.push(mv)
        out.append({"id": g["id"], "name": g["name"], "bot": g["bot"], "against": g["against"],
                    "idea": " ".join(g["idea"].split()), "line": g["lines"][0]})
    return out, book


def gambit_list() -> list[dict]:
    return _gambit_book()[0]


# Choosing between gambits: when several wanted gambits fit (1.e4 heads for the Alien, the King's Gambit, the
# Smith-Morra …; 1.d4 for the Blackmar-Diemer), the bot plays the move that keeps the most of them alive – the one
# after which you are most likely (Maia at your level) to walk into one of their lines, looking a few moves ahead.
# So it doesn't commit to one gambit early and lose all of them when you play something else.
GAMBIT_LOOKAHEAD = 6      # bot moves looked ahead
GAMBIT_MIN_P = 0.02       # your replies rarer than this are ignored
_reply_cache: dict[tuple[str, int], dict[str, float] | None] = {}
_reply_lock = threading.Lock()


def _hits(board: chess.Board, wanted: list[str] | tuple[str, ...]) -> list[tuple[str, str]]:
    """(gambit id, move) for the wanted gambits whose lines go through this position (bot to move)."""
    _, book = _gambit_book()
    legal = {m.uci() for m in board.legal_moves}
    return [(gid, uci) for gid, uci in book.get(_epd(board), [])
            if ("all" in wanted or gid in wanted) and uci in legal]


def _reply_policy(board: chess.Board, level: int | None) -> dict[str, float] | None:
    """How likely you (Maia at your level) play each move here; None without Maia."""
    if level is None:
        return None
    key = (_epd(board), level)
    with _reply_lock:
        if key in _reply_cache:
            return _reply_cache[key]
    try:
        pol: dict[str, float] | None = {m.uci(): p for m, p in maia(level).policy(board)}
    except Exception:  # no Lc0 / Maia: every reply counts the same
        pol = None
    with _reply_lock:
        _reply_cache[key] = pol
    return pol


def _bot_value(board: chess.Board, wanted: tuple[str, ...], level: int | None, depth: int, memo: dict) -> float:
    """Expected number of gambit moves the bot still gets to play from here (bot to move)."""
    if depth <= 0:
        return 0.0
    key = ("b", _epd(board), wanted, depth)
    if key not in memo:
        best = 0.0
        for uci in {u for _, u in _hits(board, wanted)}:
            after = board.copy(stack=False)
            after.push_uci(uci)
            best = max(best, 1.0 + _you_value(after, wanted, level, depth - 1, memo))
        memo[key] = best
    return memo[key]


def _you_value(board: chess.Board, wanted: tuple[str, ...], level: int | None, depth: int, memo: dict) -> float:
    """The same with you to move: your likely replies that keep a gambit on, weighted by how likely they are."""
    if depth <= 0 or board.is_game_over():
        return 0.0
    key = ("y", _epd(board), wanted, depth)
    if key not in memo:
        on = []
        for mv in board.legal_moves:
            board.push(mv)
            if _hits(board, wanted):
                on.append(mv)
            board.pop()
        total = 0.0
        if on:
            pol = _reply_policy(board, level)
            n = board.legal_moves.count()
            for mv in on:
                p = pol.get(mv.uci(), 0.0) if pol is not None else 1.0 / n
                if p >= GAMBIT_MIN_P or pol is None:
                    after = board.copy(stack=False)
                    after.push(mv)
                    total += p * _bot_value(after, wanted, level, depth, memo)
        memo[key] = total
    return memo[key]


def gambit_move(board: chess.Board, wanted: list[str], level: int | None = None) -> tuple[chess.Move, dict] | None:
    """The gambit move here, if the position is on a line of one of the wanted gambits (any move order).

    When several fit, the move that keeps the most wanted gambits reachable against a player at `level` (your
    Maia level); it is labelled with the gambit it most likely leads to.
    """
    gambits, _ = _gambit_book()
    hits = _hits(board, wanted)
    if not hits:
        return None
    memo: dict = {}
    want = tuple(sorted(set(wanted)))

    def after_value(uci: str, w: tuple[str, ...]) -> float:
        b = board.copy(stack=False)
        b.push_uci(uci)
        return _you_value(b, w, level, GAMBIT_LOOKAHEAD - 1, memo)

    moves = sorted({u for _, u in hits})
    if len(moves) > 1:
        scored = {u: after_value(u, want) for u in moves}
        best = max(scored.values())
        uci = random.choice([u for u, v in scored.items() if v >= best - 1e-9])
    else:
        uci = moves[0]
    gids = sorted({g for g, u in hits if u == uci})
    if len(gids) > 1:
        scored_g = {g: after_value(uci, (g,)) for g in gids}
        best = max(scored_g.values())
        gid = random.choice([g for g, v in scored_g.items() if v >= best - 1e-9])
    else:
        gid = gids[0]
    g = next(x for x in gambits if x["id"] == gid)
    return chess.Move.from_uci(uci), {"id": gid, "name": g["name"], "idea": g["idea"]}


def _result(board: chess.Board, c: dict, level: int, you_level: int, rank: int) -> dict:
    return {"uci": c["move"].uci(), "san": board.san(c["move"]), "level": level, "youLevel": you_level,
            "trap": c["trap"], "opening": c["opening"], "humanP": round(c["p"], 3), "rank": rank}


def _trap(after: chess.Board, you_level: int, k: float, p: Profile) -> dict | None:
    """Your likely replies in `after` (you to move) and how much they'd cost you."""
    you = after.turn
    replies = [(mv, pr) for mv, pr in maia(you_level).policy(after) if pr >= 0.04][:7]
    if not replies:
        return None
    best = _search(after, 10)
    if not best:
        return None
    ep_best = _ep(best[0].score, you, k)
    lines = {ln.move: ln for ln in _search(after, 10, [mv for mv, _ in replies])}
    bad, value = [], 0.0
    for mv, pr in replies:
        ln = lines.get(mv)
        if not ln:
            continue
        loss = ep_best - _ep(ln.score, you, k)
        if loss < TRAP_LOSS:
            continue
        b2 = after.copy(stack=False)
        b2.push(mv)
        punish = []
        bb = b2.copy(stack=False)
        for x in ln.pv[1:5]:
            if x not in bb.legal_moves:
                break
            punish.append(bb.san(x))
            bb.push(x)
        theme = tactics.theme_of_line(b2, punish, after) if punish else None
        if theme not in TRAP_THEMES:
            continue  # simply leaving a piece hanging isn't a trap the bot set – only real tactics count
        w = p.themes.get(theme, 1.0)
        value += pr * loss * w
        bad.append({"uci": mv.uci(), "san": after.san(mv), "prob": round(pr, 3), "loss": round(loss, 3),
                    "theme": theme, "label": tactics.THEMES.get(theme) if theme else None, "punish": punish[:4]})
    if not bad:
        return None
    return {"value": round(value, 4), "bad": bad}


# --------------------------------------------------------------------------- #
#  Profile summary and results
# --------------------------------------------------------------------------- #

def _stats() -> dict:
    try:
        return json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"games": []}


def summary() -> dict:
    if not available():
        return {"available": False}
    p = profile()
    weak_openings: dict[str, tuple[int, float]] = {}
    for epd, (n, bad) in p.book.items():
        if n < 4:
            continue
        rate = (bad + p.base_err * 2) / (n + 2)
        if rate - p.base_err < 0.12:
            continue
        hit = openings.lookup(chess.Board(epd + " 0 1"))
        name = hit[1] if hit and hit[1] else None
        if name and (name not in weak_openings or weak_openings[name][1] < rate):
            weak_openings[name] = (n, rate)
    games = _stats()["games"]
    return {
        "available": True,
        "rating": round(p.rating),
        "ratingInfo": rating_info(),
        "level": nearest_level(p.rating),
        "levels": [lv for lv in LEVELS if (MAIA_DIR / f"maia-{lv}.pb.gz").exists()],
        "reviewed": p.games,
        "themes": [{"theme": t, "label": tactics.THEMES.get(t, t), "count": c}
                   for t, c in p.theme_counts if t in TRAP_THEMES][:5],
        "openings": [{"name": n, "games": g, "rate": round(r * 100)} for n, (g, r) in
                     sorted(weak_openings.items(), key=lambda x: -x[1][1])[:4]],
        "record": {"played": len(games), "won": sum(g["result"] == "win" for g in games),
                   "drawn": sum(g["result"] == "draw" for g in games), "lost": sum(g["result"] == "loss" for g in games),
                   "traps": sum(g.get("traps", 0) for g in games), "fell": sum(g.get("fell", 0) for g in games)},
        "recent": games[-10:][::-1],
    }


def finish(result: str, color: str, level: int, traps: int, fell: int, moves: int, pgn: str | None = None) -> dict:
    data = _stats()
    entry = {"at": int(time.time()), "result": result, "color": color, "level": level,
             "traps": traps, "fell": fell, "moves": moves}
    if pgn:  # kept so the game shows up under "Bot games" and can be reviewed later
        entry["pgn"], entry["id"] = pgn, _pgn_id(pgn)
    data["games"].append(entry)
    data["games"] = data["games"][-500:]
    write_atomic(STATS_FILE, json.dumps(data))
    return summary()


def _pgn_id(pgn: str) -> str | None:
    from . import analysis  # (analysis is heavy; only needed here)
    parsed = analysis.read_games(pgn, limit=1)
    return analysis.game_id(parsed[0]) if parsed else None


LEVEL_RE = re.compile(r"Maia (\d+)")


def bot_games() -> list[dict]:
    """Every Nightmare game, newest first: played ones (with their PGN, since this version) and reviewed ones."""
    reviews = {s["id"]: s for s in storage.summaries() if s.get("source") == "nightmare"}
    out, seen = [], set()
    for g in reversed(_stats()["games"]):
        if not g.get("pgn"):
            continue  # played before games were kept: only its result is known (reviewed ones come below)
        review = reviews.get(g.get("id") or "")
        if review:
            seen.add(review["id"])
        out.append({"at": g["at"], "result": g["result"], "color": g["color"], "level": g["level"],
                    "moves": g.get("moves", 0), "traps": g.get("traps", 0), "fell": g.get("fell", 0),
                    "pgn": None if review else g.get("pgn"), "review": _review(review)})
    # Reviews of games played before the PGN was kept.
    for r in reviews.values():
        if r["id"] in seen:
            continue
        me = r.get("me") or "w"
        result = r.get("result")
        outcome = ("draw" if result == "1/2-1/2" else "win" if result == ("1-0" if me == "w" else "0-1")
                   else "loss" if result in ("1-0", "0-1") else None)
        name = r.get("black") if me == "w" else r.get("white")
        lv = LEVEL_RE.search(name or "")
        out.append({"at": int(r.get("playedAt") or r.get("analysedAt") or 0), "result": outcome, "color": me,
                    "level": int(lv.group(1)) if lv else None, "moves": (r.get("plies") or 0) // 2 + (r.get("plies") or 0) % 2,
                    "traps": None, "fell": None, "pgn": None, "review": _review(r)})
    out.sort(key=lambda g: -g["at"])
    return out


def _review(s: dict | None) -> dict | None:
    if not s:
        return None
    side = s.get("me") or "w"
    return {"id": s["id"], "accuracy": (s.get("accuracy") or {}).get(side), "counts": (s.get("counts") or {}).get(side)}


def close() -> None:
    for m in list(_maias.values()):
        m.close()
    _sf.close()


# --------------------------------------------------------------------------- #
#  Convert your wins: positions from your games where you were clearly winning and still lost
# --------------------------------------------------------------------------- #

CONVERT_MIN = 70        # your winning chances (%) at the start position: 70 ≈ +2, 80 ≈ +4, 90 ≈ +6 pawns
NOT_THROWN = {"time", "abandoned"}  # lost on the clock (or by leaving): not a conversion problem


def thrown_wins(min_win: float = CONVERT_MIN, draws: bool = False, limit: int = 300) -> list[dict]:
    """Games you lost (or drew) from a winning position – not on time – with the position to restart from.

    The start is the last position in the game where it was your move and your winning chances were still at
    least `min_win`: from there on it slipped away. The bot then defends it like a human at the level you pick.
    """
    out = []
    sources = {x["id"]: x.get("source") for x in storage.summaries()}
    for g in insights._games():
        src = sources.get(g.record["id"])
        if src == "nightmare" or g.end in NOT_THROWN:
            continue
        if g.outcome != "loss" and not (draws and g.outcome == "draw"):
            continue
        w = g.my_wins
        start = None
        for m in g.moves:                            # your moves; position before move `ply` is w[ply - 1]
            if w[m["ply"] - 1] >= min_win:
                start = m
        if start is None:
            continue
        later = [m for m in g.moves if m["ply"] >= start["ply"]]
        worst = max(later, key=lambda m: m["loss"])
        r = g.record
        out.append({
            "id": f"{r['id']}-{start['ply']}", "gameId": r["id"], "ply": start["ply"], "fen": start["fenBefore"],
            "color": g.me, "win": round(w[start["ply"] - 1]), "peak": round(max(w)),
            "opponent": r.get("black") if g.me == "w" else r.get("white"), "oppElo": g.opp_elo, "elo": g.elo,
            "date": r.get("date"), "playedAt": g.ts, "outcome": g.outcome, "end": g.end, "source": src,
            "moveNumber": chess.Board(start["fenBefore"]).fullmove_number,
            "threw": {"ply": worst["ply"], "san": worst["san"], "cls": worst["cls"], "bestSan": worst.get("bestSan")},
        })
    out.sort(key=lambda t: -t["playedAt"])
    return out[:limit]
