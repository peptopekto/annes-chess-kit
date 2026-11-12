"""Chess.com-style move classification.

Everything is measured in *expected points* (0..1, from the mover's point of
view) using the Lichess win-probability model shipped with python-chess. A
move's "loss" is how many expected points it gives away compared with the
engine's best move.

    Brilliant  !!  a good piece sacrifice; best (or near-best) move, you're not
                   worse afterwards and you weren't winning anyway without it
    Great       !  the only good move: the engine's next-best is much worse
    Best        ★  the engine's top move
    Excellent      loses < 2% expected points
    Good           loses < 5%
    Book           theory (from the openings book)
    Inaccuracy ?!  loses < 10%
    Mistake     ?  loses < 20%
    Miss        ✗  you let a forced mate slip, or failed to punish your opponent's mistake
                   without making your own position worse than it was before it
    Blunder    ??  loses 20% or more – and when it allows a forced mate
    Forced         only legal move

The thresholds are Chess.com's published expected-points bands. Mates are judged by rule, not
by expected points alone (see `judge_mates_and_misses`): with a lost position the expected points
left to lose are tiny, but walking into a mate is still a blunder.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import math

import chess
import chess.engine

BRILLIANT, GREAT, BEST, EXCELLENT, GOOD, BOOK = "brilliant", "great", "best", "excellent", "good", "book"
INACCURACY, MISTAKE, MISS, BLUNDER, FORCED = "inaccuracy", "mistake", "miss", "blunder", "forced"

PIECE_VALUES = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0,
}
PIECE_NAMES = {
    chess.PAWN: "pawn",
    chess.KNIGHT: "knight",
    chess.BISHOP: "bishop",
    chess.ROOK: "rook",
    chess.QUEEN: "queen",
    chess.KING: "king",
}

# Expected-points loss thresholds.
EXCELLENT_MAX = 0.02
GOOD_MAX = 0.05
INACCURACY_MAX = 0.10
MISTAKE_MAX = 0.20
# A missed mate this short counts as a Miss even when you stay completely winning.
SHORT_MATE = 3
# Net material (pawns) a move must offer to count as a sacrifice.
SACRIFICE_MIN = 1
# ...and how much the engine's line must actually leave you down (a piece for a pawn, or the exchange),
# within how many plies of the move.
SACRIFICE_CONFIRM = 2
SACRIFICE_WINDOW = 6

# Engine check for a declined offer: position after the capture -> (score, principal variation).
Refuter = Callable[[chess.Board], tuple[chess.engine.PovScore, list[chess.Move]]]


LICHESS_K = 0.00368208  # steepness of the Lichess win% model (strong-ish players)


def k_for_rating(rating: float | None) -> float:
    """How decisive an advantage is at this level (Lichess-scale rating).

    Fitted on real games: at club level a +3 is far from a sure win, so the curve
    is flatter (≈0.0018 at 600, ≈0.0027 at 1300) and reaches the Lichess model at 2000.
    """
    if not rating:
        return LICHESS_K
    lo, hi, k_lo = 600.0, 2000.0, 0.0018
    t = min(1.0, max(0.0, (rating - lo) / (hi - lo)))
    return k_lo + t * (LICHESS_K - k_lo)


def expected_points(score: chess.engine.Score, k: float = LICHESS_K) -> float:
    """Expected score (0..1) for the side the score is from."""
    mate = score.mate()
    if mate is not None:
        return 1.0 if mate > 0 else 0.0 if mate < 0 else (0.0 if score < chess.engine.Cp(0) else 1.0)
    cp = max(-2000, min(2000, score.score()))
    return 1.0 / (1.0 + math.exp(-k * cp))


@dataclass
class Line:
    move: chess.Move
    score: chess.engine.PovScore
    pv: list[chess.Move] = field(default_factory=list)


@dataclass
class MoveContext:
    board: chess.Board  # position *before* the move
    move: chess.Move
    lines: list[Line]  # engine top lines for `board` (multipv, best first)
    after: chess.engine.PovScore  # engine eval of the position after the move
    in_book: bool = False
    prev_move: chess.Move | None = None
    prev_loss: float | None = None  # expected points the opponent lost on their last move
    k: float = LICHESS_K  # win-chance curve for the players' level (see k_for_rating)
    reply_pv: list[chess.Move] | None = None  # engine's best line *after* the move (opponent first)
    refute: Refuter | None = None              # to test an offer the engine line declines


@dataclass
class Verdict:
    cls: str
    loss: float
    ep_best: float
    ep_after: float
    ep_second: float | None
    sacrifice: int = 0
    hanging: tuple[int, int] | None = None  # (square, piece_type) left en prise by a bad move
    sac_kind: str | None = None  # brilliant: 'sacrifice' (taken in the engine line) or 'offer' (can't be taken)


# --------------------------------------------------------------------------- #
#  Material helpers
# --------------------------------------------------------------------------- #

def _capturers(board: chess.Board, square: chess.Square, color: chess.Color) -> list[chess.Square]:
    """Squares of `color` pieces that can legally capture on `square` (board.turn must be `color`)."""
    result = []
    for attacker in board.attackers(color, square):
        piece = board.piece_type_at(attacker)
        promo = chess.QUEEN if piece == chess.PAWN and chess.square_rank(square) in (0, 7) else None
        if board.is_legal(chess.Move(attacker, square, promotion=promo)):
            result.append(attacker)
    return result


def _en_prise(board: chess.Board, owner: chess.Color) -> dict[chess.Square, int]:
    """Approximate material `owner` loses on each square if the side to move captures there.

    A cheap one-ply static exchange: an undefended piece loses its full value,
    a defended one loses the difference to the cheapest legal capturer.
    Pawns and the king are ignored – a pawn "sacrifice" is not brilliant.
    """
    assert board.turn != owner
    out: dict[chess.Square, int] = {}
    for square, piece in board.piece_map().items():
        if piece.color != owner or piece.piece_type in (chess.PAWN, chess.KING):
            continue
        capturers = _capturers(board, square, board.turn)
        if not capturers:
            continue
        value = PIECE_VALUES[piece.piece_type]
        if board.attackers(owner, square):
            cheapest = min(PIECE_VALUES[board.piece_type_at(s)] or 100 for s in capturers)
            loss = value - cheapest
        else:
            loss = value
        if loss > 0:
            out[square] = loss
    return out


def captured_value(board: chess.Board, move: chess.Move) -> int:
    if board.is_en_passant(move):
        return 1
    piece = board.piece_type_at(move.to_square)
    return PIECE_VALUES[piece] if piece else 0


def sacrifice(board: chess.Board, move: chess.Move) -> tuple[int, chess.Square | None]:
    """Net material the mover offers with `move` (0 if none) and the square it's offered on."""
    mover = board.turn
    after = board.copy(stack=False)
    after.push(move)
    if after.is_checkmate():
        return 0, None

    now = _en_prise(after, mover)
    if not now:
        return 0, None

    # A piece that was already hanging before this move (and isn't the piece
    # we just moved) was not sacrificed *by this move*.
    before: dict[chess.Square, int] = {}
    if not board.is_check():
        nulled = board.copy(stack=False)
        nulled.push(chess.Move.null())
        before = _en_prise(nulled, mover)

    best_sq, best = None, 0
    for square, loss in now.items():
        if square != move.to_square and before.get(square, 0) >= loss:
            continue
        if loss > best:
            best_sq, best = square, loss

    if move.promotion:
        best -= PIECE_VALUES[move.promotion] - 1
    return max(0, best - captured_value(board, move)), best_sq


def _balance(board: chess.Board, me: chess.Color) -> int:
    return sum(PIECE_VALUES[p.piece_type] * (1 if p.color == me else -1) for p in board.piece_map().values())


def material_given(board: chess.Board, line: list[chess.Move], window: int = SACRIFICE_WINDOW) -> bool:
    """Does best play along `line` (your move first) really leave you down material?

    True when, within `window` plies, you are down SACRIFICE_CONFIRM or more compared with before the
    move *and still are after your next move* – so an exchange you win straight back doesn't count.
    """
    me = board.turn
    b = board.copy(stack=False)
    start = _balance(b, me)
    deficits = []
    for mv in line[:window + 1]:
        if not b.is_legal(mv):
            break
        b.push(mv)
        deficits.append(start - _balance(b, me))
    for k in range(1, len(deficits)):
        if deficits[k] >= SACRIFICE_CONFIRM and (k + 1 >= len(deficits) or deficits[k + 1] >= SACRIFICE_CONFIRM):
            return True
    return False


def sacrifice_kind(board: chess.Board, move: chess.Move, square: chess.Square | None,
                   reply_pv: list[chess.Move] | None, refute: Refuter | None, k: float = LICHESS_K,
                   ep_after: float | None = None) -> str | None:
    """A static "piece left hanging" only counts as a sacrifice if best play bears it out.

    1. The engine's line takes the material and you stay down for at least a move: a real sacrifice.
    2. The line declines it: then taking must be possible, must leave you down material for real, and
       must still be fine for you (taking it is a mistake) – an offer the opponent can't accept.
    Anything else (a trade, a piece that only *looked* loose) is not a sacrifice. Neither is a king
    move that abandons a piece, or – when escaping check – leaving some *other* piece behind.
    """
    if board.piece_type_at(move.from_square) == chess.KING:
        return None
    if board.is_check() and square != move.to_square:
        return None
    if reply_pv is None:
        return "sacrifice"  # no line to check against: keep the static verdict
    if material_given(board, [move, *reply_pv]):
        return "sacrifice"
    # Declined: only the piece you just moved counts as offered (not something you left behind).
    if refute is None or square is None or square != move.to_square:
        return None
    after = board.copy(stack=False)
    after.push(move)
    capturers = _capturers(after, square, after.turn)
    if not capturers:
        return None
    taker = min(capturers, key=lambda s: PIECE_VALUES[after.piece_type_at(s)] or 100)
    promo = chess.QUEEN if after.piece_type_at(taker) == chess.PAWN and chess.square_rank(square) in (0, 7) else None
    capture = chess.Move(taker, square, promotion=promo)
    taken = after.copy(stack=False)
    taken.push(capture)
    score, pv = refute(taken)
    ep_taken = expected_points(score.pov(board.turn), k)
    # Taking must be a real error for them: you come out better than when they decline (by at least an
    # inaccuracy's worth). An offer they could just as well accept – say, into a perpetual – is no sacrifice
    # when best play declines it, and "taking it would cost dearly" wouldn't be true.
    sc = k / LICHESS_K
    if ep_taken < 0.45 or (ep_after is not None and ep_taken < min(ep_after + GOOD_MAX * sc, 0.97)):
        return None
    return "offer" if material_given(board, [move, capture, *pv]) else None


def sacrifice_confirmed(*args, **kwargs) -> bool:
    return sacrifice_kind(*args, **kwargs) is not None


def _gives_mate(board: chess.Board, move: chess.Move) -> bool:
    after = board.copy(stack=False)
    after.push(move)
    return after.is_checkmate()


def _is_recapture(board: chess.Board, move: chess.Move, prev: chess.Move | None) -> bool:
    if prev is None or move.to_square != prev.to_square:
        return False
    return board.is_capture(move)


def obvious_retreat(board: chess.Board, move: chess.Move) -> bool:
    """The piece was about to be lost where it stood, and this is its one square that keeps it.

    Moving an attacked bishop to its only safe square is the "only good move" by the numbers, but nobody
    needs to *find* it – so it isn't a Great move. (With two or more safe squares, picking the right one is
    a real decision and can still be one.)
    """
    piece = board.piece_at(move.from_square)
    if piece is None or piece.piece_type in (chess.PAWN, chess.KING) or board.is_check():
        return False
    mover = board.turn
    nulled = board.copy(stack=False)
    nulled.push(chess.Move.null())
    if _en_prise(nulled, mover).get(move.from_square, 0) < 2:
        return False
    safe = []
    for mv in board.legal_moves:
        if mv.from_square != move.from_square:
            continue
        after = board.copy(stack=False)
        after.push(mv)
        if after.is_checkmate() or _en_prise(after, mover).get(mv.to_square, 0) - captured_value(board, mv) < 1:
            safe.append(mv)
            if len(safe) > 1:
                return False
    return safe == [move]


def _is_free_capture(board: chess.Board, move: chess.Move) -> bool:
    """Taking material that simply isn't defended (or is worth more than the taker)."""
    if not board.is_capture(move):
        return False
    victim = captured_value(board, move)
    taker = PIECE_VALUES[board.piece_type_at(move.from_square)]
    defended = bool(board.attackers(not board.turn, move.to_square))
    return not defended or victim > taker


# --------------------------------------------------------------------------- #
#  Classification
# --------------------------------------------------------------------------- #

def classify(ctx: MoveContext) -> Verdict:
    board, move = ctx.board, ctx.move
    mover = board.turn

    best = ctx.lines[0]
    ep_best = expected_points(best.score.pov(mover), ctx.k)
    ep_after = expected_points(ctx.after.pov(mover), ctx.k)
    ep_second = expected_points(ctx.lines[1].score.pov(mover), ctx.k) if len(ctx.lines) > 1 else None

    is_top = move == best.move
    if is_top:
        # Separate searches of before/after positions disagree slightly; the
        # top move by definition loses nothing.
        ep_after = max(ep_after, ep_best)
    loss = 0.0 if is_top else max(0.0, ep_best - ep_after)

    def verdict(cls: str, **kw) -> Verdict:
        return Verdict(cls, round(loss, 4), round(ep_best, 4), round(ep_after, 4),
                       None if ep_second is None else round(ep_second, 4), **kw)

    if ctx.in_book:
        return verdict(BOOK)
    if board.legal_moves.count() == 1:
        return verdict(FORCED)

    # A flatter (lower-rated) curve shrinks every swing, so the loss thresholds shrink with it:
    # near-equal positions are judged exactly as before, while throwing away a big advantage
    # (which isn't "already won" at club level) now weighs more.
    sc = ctx.k / LICHESS_K
    if is_top or loss < 0.005 * sc:
        cls = BEST
    elif loss < EXCELLENT_MAX * sc:
        cls = EXCELLENT
    elif loss < GOOD_MAX * sc:
        cls = GOOD
    elif loss < INACCURACY_MAX * sc:
        cls = INACCURACY
    elif loss < MISTAKE_MAX * sc:
        cls = MISTAKE
    else:
        cls = BLUNDER

    # ---- the good stuff ---------------------------------------------------
    if cls in (BEST, EXCELLENT):
        if _gives_mate(board, move):
            return verdict(BEST)
        rated = judge_mates_and_misses(cls, ep_best=ep_best, ep_after=ep_after, sc=sc,
                                       best_mate=best.score.pov(mover).mate(),
                                       after_mate=_mate_for(ctx.after, mover), prev_loss=ctx.prev_loss,
                                       best_cp=best.score.pov(mover).score())
        if rated != cls and not is_top:
            return verdict(rated)
        sac, sac_sq = sacrifice(board, move)
        # A sacrifice is only special if you weren't winning anyway without it –
        # unless it's the one way to force mate.
        best_mates = (best.score.pov(mover).mate() or 0) > 0
        second_mates = len(ctx.lines) > 1 and (ctx.lines[1].score.pov(mover).mate() or 0) > 0
        winning_anyway = ep_second is not None and ep_second >= 0.93 and not (best_mates and not second_mates)
        kind = sacrifice_kind(board, move, sac_sq, ctx.reply_pv, ctx.refute, ctx.k, ep_after) \
            if sac >= SACRIFICE_MIN and ep_after >= 0.45 and not winning_anyway else None
        if kind:
            return verdict(BRILLIANT, sacrifice=sac, sac_kind=kind)

        only_move = ep_second is not None and ep_best - ep_second >= 0.20 * sc
        obvious = _is_recapture(board, move, ctx.prev_move) or _is_free_capture(board, move) \
            or obvious_retreat(board, move)
        if only_move and ep_after >= 0.30 and not obvious and not board.is_check():
            return verdict(GREAT)
        return verdict(cls)

    # ---- the bad stuff ----------------------------------------------------
    hanging = None
    if cls in (INACCURACY, MISTAKE, BLUNDER):
        sac, sq = sacrifice(board, move)
        if sac >= 2 and sq is not None:
            after = board.copy(stack=False)
            after.push(move)
            # Only call it hanging if best play really takes it (not when the engine has something better).
            if _taken_soon(after, ctx.reply_pv, sq):
                hanging = (sq, after.piece_type_at(sq))
    rated = judge_mates_and_misses(cls, ep_best=ep_best, ep_after=ep_after, sc=sc,
                                   best_mate=best.score.pov(mover).mate(),
                                   after_mate=_mate_for(ctx.after, mover), prev_loss=ctx.prev_loss,
                                   best_cp=best.score.pov(mover).score(), hangs_material=hanging is not None)
    return verdict(rated, hanging=hanging if rated != MISS else None)


def _mate_for(score: chess.engine.PovScore, mover: chess.Color) -> int | None:
    """Mate distance from the mover's point of view: > 0 they mate, < 0 they get mated.

    A checkmate already on the board (mate 0) is reported as +0 for the side that gave it, -0 is
    turned into -1 for the side that got mated, so the sign always tells who wins.
    """
    pov = score.pov(mover)
    m = pov.mate()
    if m == 0 and pov < chess.engine.Cp(0):
        return -1
    return m


def _worse(a: str, b: str) -> str:
    order = (BEST, EXCELLENT, GOOD, INACCURACY, MISTAKE, BLUNDER)
    return a if order.index(a) >= order.index(b) else b


def judge_mates_and_misses(cls: str, *, ep_best: float, ep_after: float, sc: float,
                           best_mate: int | None, after_mate: int | None, prev_loss: float | None,
                           best_cp: int | None = None, hangs_material: bool = False) -> str:
    """Apply the rule-based corrections to an expected-points rating (`cls`).

    `best_mate` / `after_mate` are mate distances from the mover's point of view (> 0: the mover
    mates, < 0: the mover gets mated, None: no forced mate) for the best move and the move played;
    `best_cp` is the best move's evaluation in centipawns for the mover (None when it's a mate).

    1. Allowing a forced mate the best move avoided is a Blunder (Chess.com: a blunder "loses
       material or allows a forced checkmate") – a mate in 1-3 always, however lost you already
       were. A longer mate is graded like Lichess does: a Blunder unless you were already below
       -7, at least a Mistake down to -10, below that the expected-points rating stands (at least
       an Inaccuracy) – so shuffling in a long-lost ending isn't a string of blunders.
    2. Letting a forced mate slip is a Miss: a mate in 1-3 always, as long as you're still better
       afterwards; a longer one if you stay clearly winning. Otherwise the expected-points rating
       stands.
    3. A Mistake or Blunder right after your opponent erred is only a Miss if it doesn't leave you
       worse off than before their error and doesn't hang material – you merely gave the gift back.
       Otherwise it stays a Mistake / Blunder (Chess.com: a Miss is failing to capitalise on the
       opponent's mistake, not an error of your own).
    """
    if cls not in (BEST, EXCELLENT, GOOD, INACCURACY, MISTAKE, BLUNDER):
        return cls
    being_mated_anyway = best_mate is not None and best_mate < 0
    if after_mate is not None and after_mate < 0 and not being_mated_anyway:
        if -after_mate <= SHORT_MATE or best_cp is None or best_cp > -700:
            return BLUNDER
        return _worse(cls, MISTAKE if best_cp > -1000 else INACCURACY)

    had_mate = best_mate is not None and best_mate > 0
    kept_mate = after_mate is not None and after_mate >= 0 and ep_after >= 0.99
    if had_mate and not kept_mate:
        short = best_mate <= SHORT_MATE
        if cls in (BEST, EXCELLENT, GOOD):
            return MISS if short else cls
        return MISS if ep_after >= (0.5 if short else 0.70) else cls

    opponent_erred = prev_loss is not None and prev_loss >= INACCURACY_MAX * sc
    if opponent_erred and cls in (MISTAKE, BLUNDER) and not hangs_material:
        before_their_error = ep_best - prev_loss  # where you stood before the gift (your point of view)
        if ep_after >= before_their_error - GOOD_MAX * sc:
            return MISS
    return cls


def _taken_soon(board: chess.Board, pv: list[chess.Move] | None, sq: chess.Square, moves: int = 3) -> bool:
    """Does the side to move capture on `sq` within its next `moves` moves of the line?"""
    b = board.copy(stack=False)
    for i, mv in enumerate((pv or [])[:2 * moves - 1]):
        if mv not in b.legal_moves:
            return False
        if i % 2 == 0 and mv.to_square == sq and b.is_capture(mv):
            return True
        b.push(mv)
    return False


# --------------------------------------------------------------------------- #
#  Accuracy (Lichess algorithm)
# --------------------------------------------------------------------------- #

def move_accuracy(win_before: float, win_after: float) -> float:
    """Per-move accuracy from win% (0..100, mover's POV) before/after."""
    import math

    if win_after >= win_before:
        return 100.0
    raw = 103.1668 * math.exp(-0.04354 * (win_before - win_after)) - 3.1669 + 1
    return max(0.0, min(100.0, raw))


def game_accuracy(white_win_pcts: list[float], white_first: bool = True) -> tuple[float | None, float | None]:
    """Lichess-style volatility-weighted + harmonic mean accuracy for both sides.

    `white_win_pcts` is White's win% (0..100) for every position, start included.
    """
    import statistics

    n = len(white_win_pcts)
    if n < 2:
        return None, None

    window = max(2, min(8, n // 10))
    padded = [white_win_pcts[:window]] * (window - 2) if window > 2 else []
    windows = padded + [white_win_pcts[i:i + window] for i in range(0, n - window + 1)]
    weights = [max(0.5, min(12.0, statistics.pstdev(w))) for w in windows]

    per_side: dict[bool, list[tuple[float, float]]] = {True: [], False: []}
    for i in range(n - 1):
        white_moved = (i % 2 == 0) == white_first
        before, after = white_win_pcts[i], white_win_pcts[i + 1]
        if not white_moved:
            before, after = 100 - before, 100 - after
        weight = weights[i] if i < len(weights) else weights[-1]
        per_side[white_moved].append((move_accuracy(before, after), weight))

    def combine(items: list[tuple[float, float]]) -> float | None:
        if not items:
            return None
        weighted = sum(a * w for a, w in items) / sum(w for _, w in items)
        harmonic = len(items) / sum(1 / max(a, 1e-3) for a, _ in items)
        return round((weighted + harmonic) / 2, 1)

    return combine(per_side[True]), combine(per_side[False])
