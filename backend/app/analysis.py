"""Full game review: engine pass over every position, then classification."""
from __future__ import annotations

import hashlib
import io
import queue
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Iterable

import chess
import chess.engine
import chess.pgn

from . import classify as C
from . import engine, openings
from .config import my_names

ProgressFn = Callable[[int, int, str], None]

PV_PLIES = 12
# Bump when the analysis changes in a way that makes older reviews worth re-running.
# 2: rating-aware win-chance curve + played move searched from the same position.
ANALYSIS_VERSION = 2
CHESSCOM_SHIFT = 350  # Chess.com ratings sit ~350 below Lichess at club level
SAC_CHECK = 2  # brilliant needs an engine-confirmed sacrifice; recheck.py re-judges older reviews
RATE_CHECK = 2  # allowing mate is a blunder, stricter Miss; recheck.run_rates re-rates older reviews
ACC_CHECK = 1  # accuracy with Lichess's ±10-pawn cap; recheck.run_accuracy recomputes older reviews


def game_rating(headers) -> float | None:
    """Average rating of both players on the Lichess scale (None if unknown)."""
    elos = [int(e) for e in (headers.get("WhiteElo", ""), headers.get("BlackElo", "")) if str(e).isdigit()]
    if not elos:
        return None
    shift = CHESSCOM_SHIFT if "chess.com" in (headers.get("Site", "") + headers.get("Link", "")).lower() else 0
    return sum(elos) / len(elos) + shift
# Safety cap per search; depth is the real limit (single-threaded engines need longer).
BATCH_TIME_CAP = 12.0


@dataclass(frozen=True)
class Limits:
    """How hard the engine looks at each position of a review.

    Fixed depth (`move_time` None) gives identical results on every run. A time per move adapts to the
    machine – a faster PC searches deeper in the same time – up to `depth`; results can then differ a
    little between runs.
    """
    depth: int = 16
    move_time: float | None = None   # seconds per position

    @property
    def time_cap(self) -> float:
        return min(self.move_time, BATCH_TIME_CAP) if self.move_time else BATCH_TIME_CAP

    def covers(self, review: dict) -> bool:
        """Whether an existing review is good enough that queuing the game again needn't redo it.

        With a time limit, existing reviews are kept (redo one with "Re-analyze"); with a fixed depth, a
        shallower review is redone.
        """
        if self.move_time:
            return True
        reached = review.get("depthReached") if review.get("moveTime") else review.get("depth")
        return (reached or 0) >= self.depth


# --------------------------------------------------------------------------- #
#  PGN helpers
# --------------------------------------------------------------------------- #

def read_games(pgn_text: str, limit: int = 200) -> list[chess.pgn.Game]:
    stream = io.StringIO(pgn_text.lstrip("﻿"))
    games = []
    while len(games) < limit:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        if game.errors and not any(True for _ in game.mainline_moves()):
            continue
        games.append(game)
    return games


def game_summary(game: chess.pgn.Game) -> dict:
    h = game.headers
    moves = sum(1 for _ in game.mainline_moves())
    return {
        "white": h.get("White", "?"),
        "black": h.get("Black", "?"),
        "whiteElo": h.get("WhiteElo", ""),
        "blackElo": h.get("BlackElo", ""),
        "result": h.get("Result", "*"),
        "date": h.get("UTCDate", h.get("Date", "")).replace("?", "").strip(".") or "",
        "event": h.get("Event", ""),
        "timeControl": h.get("TimeControl", ""),
        "plies": moves,
    }


def game_id(game: chess.pgn.Game) -> str:
    h = game.headers
    key = "|".join([h.get("White", ""), h.get("Black", ""), h.get("Date", ""), h.get("UTCTime", ""),
                    h.get("Site", ""), game.board().fen(), *(m.uci() for m in game.mainline_moves())])
    return hashlib.sha1(key.encode()).hexdigest()[:12]


# --------------------------------------------------------------------------- #
#  Formatting
# --------------------------------------------------------------------------- #

def eval_json(score: chess.engine.PovScore) -> dict:
    white = score.white()
    mate = white.mate()
    if mate is not None:
        if mate == 0:  # checkmate on the board: "mate 0" alone doesn't say who gave it
            return {"mate": 0, "winner": "w" if white > chess.engine.Cp(0) else "b"}
        return {"mate": mate}
    return {"cp": white.score()}


def fill_mate_winner(record: dict) -> dict:
    """Older reviews store a final checkmate as {"mate": 0}: the side that played the mating move won."""
    for m in record.get("moves", []):
        if m["eval"].get("mate") == 0 and "winner" not in m["eval"]:
            m["eval"] = {**m["eval"], "winner": m["color"]}
    return record


def eval_text(score: chess.engine.PovScore) -> str:
    w = score.white()
    if w.mate() is not None:
        m = w.mate()
        return f"{'' if m > 0 else '-'}M{abs(m)}" if m != 0 else "#"
    return f"{w.score() / 100:+.1f}"


def san_line(board: chess.Board, moves: Iterable[chess.Move], limit: int = PV_PLIES) -> list[str]:
    b = board.copy(stack=False)
    out = []
    for move in list(moves)[:limit]:
        if not b.is_legal(move):
            break
        out.append(b.san(move))
        b.push(move)
    return out


def _article(word: str) -> str:
    return "an" if word[0] in "aeiou" else "a"


def brilliant_text(board: chess.Board, move: chess.Move, san: str, kind: str | None) -> str:
    _, sq = C.sacrifice(board, move)
    b = board.copy(stack=False)
    b.push(move)
    what = C.PIECE_NAMES[b.piece_type_at(sq)] if sq is not None else "material"
    if kind == "offer":
        return f"{san} is brilliant!! It offers the {what} – and taking it would cost your opponent dearly."
    return f"{san} is brilliant!! Sacrificing the {what} is the strongest move on the board."


def explain(v: C.Verdict, board: chess.Board, move: chess.Move, san: str, best: C.Line,
            after: chess.engine.PovScore, opening_name: str | None) -> str:
    mover = board.turn
    best_san = board.san(best.move)
    piece_name = lambda pt: C.PIECE_NAMES[pt]  # noqa: E731

    if v.cls == C.BOOK:
        return f"{san} is a book move." + (f" {opening_name}." if opening_name else "")
    after_board = board.copy()
    after_board.push(move)
    if after_board.is_stalemate():
        if v.cls in (C.MISTAKE, C.BLUNDER, C.MISS, C.INACCURACY):
            return f"{san} is {_article(v.cls)} {v.cls}: it's stalemate – your opponent can't move, so the game is drawn. {best_san} was the way to win."
        return f"{san} forces stalemate – a draw."
    if after_board.is_repetition(3) and v.cls in (C.MISTAKE, C.BLUNDER, C.MISS, C.INACCURACY):
        return f"{san} is {_article(v.cls)} {v.cls}: it repeats the position a third time – a draw. {best_san} kept the win alive."
    if v.cls == C.FORCED:
        return f"{san} was forced — the only legal move."
    if v.cls == C.BRILLIANT:
        return brilliant_text(board, move, san, v.sac_kind)
    if v.cls == C.GREAT:
        if v.ep_after >= 0.75:
            why = "keeps the win alive"
        elif v.ep_after >= 0.40:
            why = "holds the position together"
        else:
            why = "keeps the fight going"
        return f"{san} is a great move! The only move that {why}."
    if v.cls == C.BEST:
        return f"{san} is the best move."
    if v.cls == C.EXCELLENT:
        return f"{san} is excellent — practically as good as the engine's choice."
    if v.cls == C.GOOD:
        return f"{san} is good. {best_san} was a little more precise."

    best_mate = best.score.pov(mover).mate()
    after_mate = after.pov(mover).mate()
    if v.cls == C.MISS:
        if best_mate and best_mate > 0:
            return f"{san} misses a forced mate in {best_mate}, starting with {best_san}."
        return f"{san} misses the chance to punish your opponent. {best_san} was the move."

    head = f"{san} is {_article(v.cls)} {v.cls}."
    if after_mate is not None and after_mate < 0:
        reason = f"It allows mate in {-after_mate}."
    elif v.hanging:
        sq, pt = v.hanging
        reason = f"It leaves the {piece_name(pt)} on {chess.square_name(sq)} hanging."
    elif best_mate and best_mate > 0:
        reason = f"There was mate in {best_mate} with {best_san}."
    else:
        reason = f"{best_san} was best."
    return f"{head} {reason}"


# --------------------------------------------------------------------------- #
#  Analysis
# --------------------------------------------------------------------------- #

END_TEXT = {
    "checkmate": "Checkmate",
    "stalemate": "Stalemate – the side to move has no legal move and isn't in check: a draw",
    "insufficient": "Draw – neither side has enough material to mate",
    "threefold": "Draw by threefold repetition",
    "fivefold": "Draw by fivefold repetition",
    "fifty": "Draw by the 50-move rule",
    "seventyfive": "Draw by the 75-move rule",
    "resignation": "Resigned",
    "time": "Lost on time",
    "agreement": "Draw agreed",
    "abandoned": "Abandoned",
}


def end_state(board: chess.Board, claim: bool = False) -> dict | None:
    """Is this position the end of the game (by the rules)? `claim` also counts claimable draws
    (threefold repetition, 50 moves) – needs the board's move history."""
    reason = None
    if board.is_checkmate():
        reason = "checkmate"
    elif board.is_stalemate():
        reason = "stalemate"
    elif board.is_insufficient_material():
        reason = "insufficient"
    elif board.is_fivefold_repetition():
        reason = "fivefold"
    elif board.is_seventyfive_moves():
        reason = "seventyfive"
    elif claim and board.can_claim_threefold_repetition():
        reason = "threefold"
    elif claim and board.can_claim_fifty_moves():
        reason = "fifty"
    if reason is None:
        return None
    winner = ("b" if board.turn == chess.WHITE else "w") if reason == "checkmate" else None
    return {"reason": reason, "text": END_TEXT[reason], "winner": winner}


def game_end(record: dict) -> dict | None:
    """How a reviewed game ended: by the rules on the board if possible, else from the PGN headers."""
    moves = record.get("moves") or []
    board = chess.Board(record.get("startFen") or chess.STARTING_FEN)
    try:
        for m in moves:
            board.push_uci(m["uci"])
    except ValueError:
        return None
    result = record.get("result") or (record.get("headers") or {}).get("Result")
    on_board = end_state(board, claim=result == "1/2-1/2")
    if on_board:
        return {**on_board, "result": result}
    term = ((record.get("headers") or {}).get("Termination") or "").lower()
    for marker in (" won ", "drawn "):
        if marker in term:
            term = term.split(marker, 1)[1]
            break
    for reason, words in (("time", ("time",)), ("resignation", ("resign",)), ("agreement", ("agreement",)),
                          ("abandoned", ("abandon",))):
        if any(w in term for w in words):
            break
    else:
        reason = "agreement" if result == "1/2-1/2" else "resignation" if result in ("1-0", "0-1") else None
    if reason is None:
        return None
    loser = board.turn if reason in ("resignation", "time") else None
    winner = None
    if result == "1-0":
        winner = "w"
    elif result == "0-1":
        winner = "b"
    elif loser is not None and reason == "resignation":
        winner = "b" if loser == chess.WHITE else "w"
    return {"reason": reason, "text": END_TEXT[reason], "winner": winner, "result": result}


def _terminal_score(board: chess.Board) -> chess.engine.PovScore | None:
    if board.is_checkmate():
        return chess.engine.PovScore(chess.engine.Mate(0), board.turn)
    if board.is_game_over(claim_draw=False):
        return chess.engine.PovScore(chess.engine.Cp(0), board.turn)
    return None


def analyse_lines(eng: engine.Engine, board: chess.Board, depth: int, multipv: int,
                  max_time: float | None = None, root_moves: list[chess.Move] | None = None,
                  game: object = None, reached: list[int] | None = None) -> list[C.Line]:
    infos = eng.analyse(board, depth=depth, multipv=multipv, max_time=max_time, root_moves=root_moves, game=game)
    if reached is not None and infos and infos[0].get("depth"):
        reached.append(infos[0]["depth"])
    lines = []
    for info in infos:
        pv = info.get("pv") or []
        if pv and "score" in info:
            lines.append(C.Line(move=pv[0], score=info["score"], pv=pv))
    return lines


@dataclass
class Strategy:
    """How the engine pass is scheduled (tunable for benchmarks; results are equivalent)."""
    block: int = 0            # consecutive positions per work item (hash reuse); 0 = auto
    reverse: bool = True      # search each block back-to-front
    lazy_second: bool = True  # second-best line only where classification needs it


DEFAULT_STRATEGY = Strategy()


def _needs_book_skip(boards: list[chess.Board], i: int) -> bool:
    return boards[0].fen() == chess.STARTING_FEN and openings.lookup(boards[i + 1]) is not None


def position_cost(board: chess.Board) -> float:
    """Rough relative search time of a position (measured: full boards ~2-3 s, late endgames ~0.2 s)."""
    return 0.15 + 2.5 * (len(board.piece_map()) / 32) ** 3


def engine_pass(boards: list[chess.Board], moves: list[chess.Move], limits: Limits,
                progress: ProgressFn | None = None, strategy: Strategy = DEFAULT_STRATEGY,
                reached: list[int] | None = None):
    """Evaluate every position. Returns (top lines per position, score per position, played-move lines).

    `reached` collects the depth each main search got to (for time-limited reviews).

    The second-best line is only needed to judge Great/Brilliant, i.e. when the
    move played was the engine's choice. With `lazy_second` it is searched right
    after the first search on the same engine (warm hash, excluding the best move)
    instead of running every search as MultiPV 2.
    """
    depth, cap = limits.depth, limits.time_cap
    total = len(boards)
    pos_lines: list[list[C.Line]] = [[] for _ in boards]
    pos_scores: list[chess.engine.PovScore | None] = [None] * total
    # The move actually played, searched from the *same* position and depth as the best
    # move – comparing the two is far less noisy than evaluating the next position separately.
    pos_played: list[C.Line | None] = [None] * total
    lock = threading.Lock()
    done = [0.0]
    # Progress by expected work, not by position count: a full board takes ~10x longer to search than a
    # late endgame, so counting positions raced to 99 % on the quick endgame and then seemed to hang.
    weight = [position_cost(b) for b in boards]
    total_w = sum(weight) or 1.0

    def second_line(eng: engine.Engine, i: int, best: chess.Move, game: object = None) -> C.Line | None:
        others = [m for m in boards[i].legal_moves if m != best]
        if not others:
            return None
        lines = analyse_lines(eng, boards[i], depth, multipv=1, max_time=cap, root_moves=others, game=game)
        return lines[0] if lines else None

    def played_line(eng: engine.Engine, i: int, lines: list[C.Line], game: object = None) -> None:
        played = moves[i] if i < len(moves) else None
        if played is None or any(ln.move == played for ln in lines[:1]) or _needs_book_skip(boards, i):
            return
        got = analyse_lines(eng, boards[i], depth, multipv=1, max_time=cap, root_moves=[played], game=game)
        if got:
            pos_played[i] = got[0]

    def search(eng: engine.Engine, i: int, game: object = None) -> None:
        board = boards[i]
        terminal = _terminal_score(board)
        if terminal is not None:
            pos_scores[i] = terminal
        elif not strategy.lazy_second:
            lines = analyse_lines(eng, board, depth, multipv=2, max_time=cap, game=game, reached=reached)
            pos_lines[i], pos_scores[i] = lines, lines[0].score
            played_line(eng, i, lines, game)
        else:
            lines = analyse_lines(eng, board, depth, multipv=1, max_time=cap, game=game, reached=reached)
            played = moves[i] if i < len(moves) else None
            if played is not None and lines[0].move == played and not _needs_book_skip(boards, i):
                second = second_line(eng, i, lines[0].move, game)
                if second:
                    lines.append(second)
            pos_lines[i], pos_scores[i] = lines, lines[0].score
            played_line(eng, i, lines, game)
        with lock:
            done[0] += weight[i]
            if progress:
                progress(min(total, round(done[0] / total_w * total)), total, board.fen())

    # Long enough blocks for hash reuse, short enough that every engine gets work.
    size = strategy.block or max(2, min(8, total // (2 * engine.batch.size)))
    blocks = [list(range(s, min(s + size, total))) for s in range(0, total, size)]
    # Most expensive blocks first (longest-processing-time first): engines stay busy to the end instead of
    # a few full-board positions finishing alone. Every block starts from a fresh hash, so the order
    # doesn't change any result.
    blocks.sort(key=lambda b: -sum(weight[i] for i in b))
    work: "queue.Queue[list[int]]" = queue.Queue()
    for b in blocks:
        work.put(b[::-1] if strategy.reverse else b)

    def worker() -> None:
        with engine.batch.acquire() as eng:
            while True:
                try:
                    block = work.get_nowait()
                except queue.Empty:
                    return
                token = object()  # fresh hash per block → reproducible results
                for i in block:
                    search(eng, i, token)

    _run_parallel(worker, engine.batch.size, work)

    if strategy.lazy_second:
        # A non-best move that sacrifices material could still be Brilliant, and
        # that verdict needs the true second-best line: fetch it for those few.
        todo = []
        for i, move in enumerate(moves):
            lines = pos_lines[i]
            if lines and len(lines) == 1 and lines[0].move != move and not _needs_book_skip(boards, i):
                if C.sacrifice(boards[i], move)[0] >= C.SACRIFICE_MIN:
                    todo.append(i)
        extra: "queue.Queue[int]" = queue.Queue()
        for i in todo:
            extra.put(i)

        def worker2() -> None:
            with engine.batch.acquire() as eng:
                while True:
                    try:
                        i = extra.get_nowait()
                    except queue.Empty:
                        return
                    second = second_line(eng, i, pos_lines[i][0].move, object())
                    if second:
                        pos_lines[i].append(second)

        if todo:
            _run_parallel(worker2, min(len(todo), engine.batch.size), extra)

        # Everywhere else the move actually played is a valid stand-in for "an
        # alternative to the best move" (it's all the classifier can use there).
        for i, move in enumerate(moves):
            if len(pos_lines[i]) == 1 and pos_lines[i][0].move != move:
                if pos_played[i] is not None:
                    pos_lines[i].append(pos_played[i])
                elif pos_scores[i + 1] is not None:
                    pos_lines[i].append(C.Line(move=move, score=_flip_to(pos_scores[i + 1], boards[i].turn)))

    return pos_lines, pos_scores, pos_played


# --------------------------------------------------------------------------- #
#  Deeper check of the special moves
# --------------------------------------------------------------------------- #

SPECIAL_CHECK = 2   # Brilliant/Great confirmed by a deeper search; recheck.py re-judges older reviews
# (1 = checked by the first version, which left a stale second-best move and an unclipped loss: tidied without the engine)
CONFIRM_DEPTH = 22


def confirm_special(moves: list[dict], k: float, depth: int, time_cap: float = BATCH_TIME_CAP) -> list[tuple[int, str, str, str]]:
    """Re-check Brilliant and Great moves with a deeper search; downgrade the ones that don't hold up.

    They're the moves people remember – and celebrate – but at review depth about one Brilliant in five
    isn't (near) best any more a few plies deeper. The move is searched again from the same position as
    the best move; a Brilliant/Great that isn't near-best there – or, for Great, isn't the only good move;
    or that leaves you worse than the review's own rule allows (Brilliant 45 %, Great 30 %) – gets the plain
    rating of that search (never below Good: the rest of the game was judged at review depth).
    Changes `moves` in place; returns (ply, san, old, new) for each downgrade.
    """
    todo = [i for i, m in enumerate(moves) if m.get("cls") in (C.BRILLIANT, C.GREAT)]
    if not todo:
        return []
    deep = min(26, max(depth + 6, CONFIRM_DEPTH))
    cap = max(4.0, min(BATCH_TIME_CAP, 3 * time_cap))
    sc = k / C.LICHESS_K

    def judge(i: int):
        m = moves[i]
        board = chess.Board(m["fenBefore"])
        move = chess.Move.from_uci(m["uci"])
        mover = board.turn
        ep = lambda ln: C.expected_points(ln.score.pov(mover), k)  # noqa: E731
        with engine.batch.acquire() as eng:
            token = object()
            top = analyse_lines(eng, board, deep, multipv=2, max_time=cap, game=token)
            if not top:
                return None
            if top[0].move == move:
                return 0.0, (ep(top[0]) - ep(top[1])) if len(top) > 1 else None, ep(top[0]), top, board
            played = analyse_lines(eng, board, deep, multipv=1, max_time=cap, root_moves=[move], game=token)
            if not played:
                return None
            return max(0.0, ep(top[0]) - ep(played[0])), 0.0, ep(played[0]), top, board

    with ThreadPoolExecutor(max_workers=min(len(todo), engine.batch.size)) as pool:
        results = list(pool.map(judge, todo))
    changed = []
    for i, res in zip(todo, results):
        if res is None:
            continue
        loss, gap, ep_after, top, board = res
        best = top[0]
        m = moves[i]
        holds = loss < C.EXCELLENT_MAX * sc
        if m["cls"] == C.GREAT:
            holds = holds and gap is not None and gap >= 0.20 * sc and ep_after >= 0.30
        else:  # Brilliant: the deeper search must agree that you're not worse after the sacrifice either
            holds = holds and ep_after >= 0.45
        if holds:
            continue
        new = C.BEST if loss < 0.005 * sc else C.EXCELLENT if loss < C.EXCELLENT_MAX * sc else C.GOOD
        if new == C.GOOD:
            # Capped at Good: keep the loss inside that band too, so stats built on losses agree with the label.
            loss = min(loss, C.GOOD_MAX * sc - 0.0001)
        old = m["cls"]
        m["cls"], m["loss"] = new, round(loss, 4)
        if old == C.BRILLIANT:
            m["sacrifice"] = 0
        if best.move.uci() != m["uci"]:
            # The deeper search prefers another move: that's the one to show as best.
            m["bestUci"], m["bestSan"] = best.move.uci(), board.san(best.move)
            m["bestLine"], m["bestEval"] = san_line(board, best.pv), eval_json(best.score)
            m["secondUci"] = top[1].move.uci() if len(top) > 1 else None
        m["text"] = (f"{m['san']} is the best move." if new == C.BEST
                     else f"{m['san']} is excellent — practically as good as the engine's choice." if new == C.EXCELLENT
                     else f"{m['san']} is good. {m['bestSan']} was a little more precise.")
        changed.append((m["ply"], m["san"], old, new))
    return changed


def _flip_to(score: chess.engine.PovScore, color: chess.Color) -> chess.engine.PovScore:
    return chess.engine.PovScore(score.pov(color), color)


def _run_parallel(fn, n: int, q) -> None:
    """Run `fn` on n threads; on error/cancel drain the queue so the others stop too."""
    pool = ThreadPoolExecutor(max_workers=max(1, n))
    futures = [pool.submit(fn) for _ in range(max(1, n))]
    try:
        for f in futures:
            f.result()
    except BaseException:
        while True:
            try:
                q.get_nowait()
            except Exception:
                break
        raise
    finally:
        pool.shutdown(wait=True)


def reply_line(move: chess.Move, lines: list[C.Line], played: C.Line | None, after_lines: list[C.Line]) -> list[chess.Move]:
    """Best play after `move` (opponent first), taken from the search that judged the move."""
    if lines and lines[0].move == move and len(lines[0].pv) > 1:
        return lines[0].pv[1:]
    if played is not None and played.move == move and len(played.pv) > 1:
        return played.pv[1:]
    return after_lines[0].pv if after_lines else []


def refuter(limits: Limits | int) -> C.Refuter:
    """Engine check used to test a sacrifice the opponent's best line declines (rare: a few per game at most)."""
    if isinstance(limits, int):
        limits = Limits(depth=limits)
    def run(board: chess.Board):
        if board.is_game_over():
            return _terminal_score(board) or chess.engine.PovScore(chess.engine.Cp(0), board.turn), []
        with engine.batch.acquire() as eng:
            got = analyse_lines(eng, board, min(limits.depth, 18), multipv=1, max_time=limits.time_cap, game=object())
        return (got[0].score, got[0].pv) if got else (chess.engine.PovScore(chess.engine.Cp(0), board.turn), [])
    return run


def analyse_game(pgn_text: str, limits: Limits | int = 18, progress: ProgressFn | None = None) -> dict:
    if isinstance(limits, int):
        limits = Limits(depth=limits)
    games = read_games(pgn_text, limit=1)
    if not games:
        raise ValueError("Couldn't read a game from that PGN.")
    game = games[0]
    moves = list(game.mainline_moves())
    if not moves:
        raise ValueError("That game has no moves.")

    start = game.board()
    boards = [start.copy()]
    b = start.copy()
    for move in moves:
        b.push(move)
        boards.append(b.copy())

    # ---- engine pass ------------------------------------------------------
    total = len(boards)
    reached: list[int] = []
    pos_lines, pos_scores, pos_played = engine_pass(boards, moves, limits, progress, reached=reached)
    rating = game_rating(game.headers)
    k = C.k_for_rating(rating)

    # ---- classification ---------------------------------------------------
    # Book is per position (so transpositions back into theory count too).
    standard_start = start.fen() == chess.STARTING_FEN
    opening = None
    move_records = []
    prev_loss = None
    counts = {chess.WHITE: Counter(), chess.BLACK: Counter()}

    for i, move in enumerate(moves):
        before, after_board = boards[i], boards[i + 1]
        mover = before.turn
        san = before.san(move)

        book_entry = openings.lookup(after_board) if standard_start else None
        if book_entry and book_entry[1]:
            opening = {"eco": book_entry[0], "name": book_entry[1]}

        lines = pos_lines[i]
        if not lines:  # shouldn't happen: a move was played from here
            lines = [C.Line(move=move, score=pos_scores[i + 1])]
        ctx = C.MoveContext(
            board=before, move=move, lines=lines,
            after=pos_played[i].score if pos_played[i] is not None else pos_scores[i + 1],
            in_book=book_entry is not None, prev_move=moves[i - 1] if i else None, prev_loss=prev_loss, k=k,
            reply_pv=reply_line(move, lines, pos_played[i], pos_lines[i + 1]), refute=refuter(limits),
        )
        v = C.classify(ctx)
        prev_loss = v.loss
        counts[mover][v.cls] += 1
        best = lines[0]

        move_records.append({
            "ply": i + 1,
            "san": san,
            "uci": move.uci(),
            "color": "w" if mover == chess.WHITE else "b",
            "fenBefore": before.fen(),
            "fen": after_board.fen(),
            "cls": v.cls,
            "loss": v.loss,
            "epBest": v.ep_best,
            "epAfter": v.ep_after,
            "bestUci": best.move.uci(),
            "bestSan": before.san(best.move),
            "bestLine": san_line(before, best.pv),
            "bestEval": eval_json(best.score),
            "secondUci": lines[1].move.uci() if len(lines) > 1 else None,
            "eval": eval_json(pos_scores[i + 1]),
            "evalText": eval_text(pos_scores[i + 1]),
            "sacrifice": v.sacrifice,
            "text": explain(v, before, move, san, best, pos_scores[i + 1],
                            opening["name"] if (opening and v.cls == C.BOOK) else None),
            "check": after_board.is_check(),
            "capture": before.is_capture(move),
        })

    # ---- deeper check of Brilliant / Great ------------------------------------
    confirm_special(move_records, k, limits.depth, limits.time_cap)
    counts = {chess.WHITE: Counter(), chess.BLACK: Counter()}
    for rec in move_records:
        counts[chess.WHITE if rec["color"] == "w" else chess.BLACK][rec["cls"]] += 1

    # ---- summary ----------------------------------------------------------
    white_wins = [100 * C.expected_points(s.white()) for s in pos_scores]
    acc_w, acc_b = C.game_accuracy(white_wins, white_first=start.turn == chess.WHITE)

    h = game.headers
    names = my_names()
    me = None
    if h.get("White", "").lower() in names:
        me = "w"
    elif h.get("Black", "").lower() in names:
        me = "b"

    return {
        "id": game_id(game),
        "headers": dict(h),
        **game_summary(game),
        "startFen": start.fen(),
        "opening": opening,
        "me": me,
        "depth": limits.depth,
        "moveTime": limits.move_time,
        "depthReached": round(sum(reached) / len(reached), 1) if reached else None,
        "sacCheck": SAC_CHECK,
        "specialCheck": SPECIAL_CHECK,
        "rateCheck": RATE_CHECK,
        "accCheck": ACC_CHECK,
        "accuracy": {"w": acc_w, "b": acc_b},
        "counts": {"w": dict(counts[chess.WHITE]), "b": dict(counts[chess.BLACK])},
        "startEval": eval_json(pos_scores[0]),
        "winPct": [round(w, 2) for w in white_wins],
        "moves": move_records,
        "pgn": pgn_text.strip(),
        "version": ANALYSIS_VERSION,
        "ratingModel": {"rating": round(rating) if rating else None, "k": round(k, 6)},
    }


# --------------------------------------------------------------------------- #
#  Live helpers (retry / explore)
# --------------------------------------------------------------------------- #

def live_lines(fen: str, depth: int = 18, multipv: int = 3) -> dict:
    board = chess.Board(fen)
    terminal = _terminal_score(board)
    if terminal is not None:
        return {"eval": eval_json(terminal), "evalText": eval_text(terminal), "lines": [], "over": end_state(board)}
    # Interactive: answer fast (~1s) rather than deep.
    lines = analyse_lines(engine.live, board, depth, multipv=multipv, max_time=1.0)
    return {
        "eval": eval_json(lines[0].score),
        "evalText": eval_text(lines[0].score),
        "lines": [{
            "uci": ln.move.uci(),
            "san": board.san(ln.move),
            "eval": eval_json(ln.score),
            "evalText": eval_text(ln.score),
            # A forced mate is shown to the end (to play it out); other lines stay short.
            "line": san_line(board, ln.pv, 40 if ln.score.is_mate() else 8),
        } for ln in lines],
    }


def _live_refuter(depth: int) -> C.Refuter:
    def run(board: chess.Board):
        if board.is_game_over():
            return _terminal_score(board) or chess.engine.PovScore(chess.engine.Cp(0), board.turn), []
        got = analyse_lines(engine.live, board, min(depth, 18), multipv=1, max_time=3.0, game=object())
        return (got[0].score, got[0].pv) if got else (chess.engine.PovScore(chess.engine.Cp(0), board.turn), [])
    return run


def check_move(fen: str, uci: str, depth: int = 18, k: float | None = None,
               prev_uci: str | None = None, prev_loss: float | None = None, book: bool = False) -> dict:
    """Rate a move the way a review does (used by Retry and puzzles).

    Same method as the review: the move is searched from the same position as the best move, with the
    game's rating-aware win-probability curve (`k`) and the opponent's previous move (for "Miss").
    `book`: the game started from the normal position, so opening-book moves count as Book (live feedback).
    """
    board = chess.Board(fen)
    move = chess.Move.from_uci(uci)
    if move not in board.legal_moves:
        raise ValueError("Illegal move")
    token = object()  # both searches share the hash, like a review block
    lines = analyse_lines(engine.live, board, depth, multipv=2, max_time=3.0, game=token)
    after_board = board.copy()
    after_board.push(move)
    after = _terminal_score(after_board)
    played = lines[0] if lines and lines[0].move == move else None
    if after is not None:
        after = _flip_to(after, board.turn)
    else:
        if played is None:
            got = analyse_lines(engine.live, board, depth, multipv=1, max_time=3.0, root_moves=[move], game=token)
            played = got[0] if got else None
        if played is None:  # shouldn't happen: fall back to searching the position after the move
            after = analyse_lines(engine.live, after_board, depth, multipv=1, max_time=3.0)[0].score
        else:
            after = played.score
    if played is not None and played.move != lines[0].move and len(lines) > 1 and lines[1].move != move:
        lines = [lines[0], played]  # the played move stands in as "an alternative to the best move"
    prev = chess.Move.from_uci(prev_uci) if prev_uci else None
    v = C.classify(C.MoveContext(
        board=board, move=move, lines=lines, after=after, prev_move=prev, prev_loss=prev_loss,
        in_book=book and openings.lookup(after_board) is not None, k=k or C.LICHESS_K, reply_pv=played.pv[1:] if played is not None else [], refute=_live_refuter(depth)))
    san = board.san(move)
    # Stockfish's answer to the move – how a strong opponent would punish it (Woodpecker shows it).
    reply = None
    if not after_board.is_game_over():
        if played is not None and played.move == move and len(played.pv) > 1:
            reply = played.pv[1]
        else:
            got = analyse_lines(engine.live, after_board, min(depth, 16), multipv=1, max_time=2.0)
            reply = got[0].move if got else None
        if reply is not None and reply not in after_board.legal_moves:
            reply = None
    return {
        "replyUci": reply.uci() if reply else None,
        "replySan": after_board.san(reply) if reply else None,
        "cls": v.cls,
        "loss": v.loss,
        "san": san,
        "bestSan": board.san(lines[0].move),
        "bestUci": lines[0].move.uci(),
        "text": explain(v, board, move, san, lines[0], after, None),
        "eval": eval_json(after),
        "evalText": eval_text(after),
    }


# --------------------------------------------------------------------------- #
#  Export
# --------------------------------------------------------------------------- #

def limits_text(record: dict) -> str:
    """How deep a review searched, in words: "depth 16" or "1 s per move, avg depth 23"."""
    if record.get("moveTime"):
        reached = record.get("depthReached")
        return f"{record['moveTime']:g} s per move" + (f", avg depth {reached:g}" if reached else "")
    return f"depth {record.get('depth')}"


NAGS = {C.BRILLIANT: chess.pgn.NAG_BRILLIANT_MOVE, C.GREAT: chess.pgn.NAG_GOOD_MOVE,
        C.INACCURACY: chess.pgn.NAG_DUBIOUS_MOVE, C.MISTAKE: chess.pgn.NAG_MISTAKE,
        C.MISS: chess.pgn.NAG_MISTAKE, C.BLUNDER: chess.pgn.NAG_BLUNDER}


def annotated_pgn(record: dict) -> str:
    """The reviewed game as PGN with !!/!/?!/?/?? marks, evals and best-move comments."""
    game = read_games(record["pgn"], limit=1)[0]
    out = chess.pgn.Game()
    out.headers.update(game.headers)
    out.headers["Annotator"] = f"Anne's Chess Kit (Stockfish, {limits_text(record)})"
    if record.get("opening"):
        out.headers["Opening"] = record["opening"]["name"]
        out.headers["ECO"] = record["opening"]["eco"]
    node = out
    for m in record["moves"]:
        node = node.add_variation(chess.Move.from_uci(m["uci"]))
        if m["cls"] in NAGS:
            node.nags.add(NAGS[m["cls"]])
        ev = m["eval"]
        ev_txt = f"#{ev['mate']}" if "mate" in ev else f"{ev['cp'] / 100:.2f}"
        comment = f"[%eval {ev_txt}] {m['cls'].capitalize()}."
        if m["cls"] in (C.INACCURACY, C.MISTAKE, C.MISS, C.BLUNDER, C.GOOD):
            comment += f" Best was {m['bestSan']}."
            # Show the engine's line as a real variation too.
            board = node.parent.board()
            var = node.parent.add_variation(chess.Move.from_uci(m["bestUci"]))
            b = board.copy()
            b.push(var.move)
            for san in m["bestLine"][1:6]:
                try:
                    mv = b.parse_san(san)
                except ValueError:
                    break
                var = var.add_variation(mv)
                b.push(mv)
        node.comment = comment
    acc = record.get("accuracy", {})
    out.comment = f"Accuracy - White {acc.get('w')}, Black {acc.get('b')}"
    return str(out)
