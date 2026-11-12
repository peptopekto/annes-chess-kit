"""Endgame trainer: the basic mates, pawn endings and the theoretical positions every player must know.

Each drill makes fresh positions (random placements, or a known theoretical position shifted and
mirrored), checked by Stockfish so they really are won – or drawn, for the defence drills – and,
where it matters, contain a trap (a natural move that ruins the result).

You play them against
* perfect defence: Stockfish (or Syzygy tablebases in engine/syzygy, if you add them), which always
  makes you find the most precise way, or
* a human: Maia at your rating, who defends like a club player – with the flaws that brings.
"""
from __future__ import annotations

import json
import random
import threading
import time
from dataclasses import asdict, dataclass
from functools import lru_cache

import chess
import chess.engine
import chess.syzygy
import yaml

from . import engine, nightmare
from .config import DATA, ROOT, USERDATA, write_atomic

STATS_FILE = USERDATA / "endgames.json"
TB_DIR = ROOT / "engine" / "syzygy"
WIN_CP = 250          # Stockfish score (pawns x100) that counts as "winning"
DRAW_CP = 90          # |score| below this counts as "drawn" for the defence drills

_tb: chess.syzygy.Tablebase | None = None
if TB_DIR.is_dir() and any(TB_DIR.glob("*.rtbw")):
    try:
        _tb = chess.syzygy.open_tablebase(str(TB_DIR))
    except Exception:  # broken files: train with Stockfish alone
        _tb = None

def tablebase_ready() -> bool:
    return _tb is not None


# Its own small engine, so the trainer doesn't wait for a running batch analysis.
_sf = engine.Engine(threads=2, hash_mb=64, options={"SyzygyPath": str(TB_DIR)} if _tb else None)


@dataclass(frozen=True)
class Drill:
    id: str
    group: str
    title: str
    goal: str                   # mate | promote | win (opponent left with a bare king) | draw
    level: int                  # 1 (easy) … 5 (hard)
    blurb: str
    tip: str
    you: str = ""               # random placement: your pieces (White = you, as generated)
    them: str = ""
    rule: str = ""              # extra placement rule, see _rule_ok
    fens: tuple[str, ...] = ()  # fixed positions instead (side to move = you)
    shift: bool = False         # fixed positions may be shifted sideways
    min_mate: int = 0           # reject positions with a quicker forced mate (too easy)
    care: bool = False          # needs at least one natural move that ruins the result
    survive: int = 0            # draw drills: hold this many of your moves


def _after(sans: str) -> str:
    b = chess.Board()
    for san in sans.split():
        b.push_san(san)
    return b.fen()


DRILLS: list[Drill] = [
    # ------------------------------------------------------------------ checkmates
    Drill("kq", "Checkmates", "Queen vs king", "mate", 1,
          "Mate with king and queen.",
          "Shrink the king's box with the queen a knight's move away, then bring your king up. "
          "Mate on the edge – and check for stalemate before every queen move.",
          you="KQ", them="K", rule="center", min_mate=5),
    Drill("krr", "Checkmates", "Two rooks (ladder)", "mate", 1,
          "Mate with two rooks – no king needed.",
          "The rooks take turns: one cuts off a rank, the other gives check on the next. "
          "If the king gets close, move the rook far away along its rank.",
          you="KRR", them="K", rule="center", min_mate=3),
    Drill("kr", "Checkmates", "Rook vs king", "mate", 2,
          "Mate with king and rook.",
          "Cut the king off with the rook, walk your king in front of it (opposition) and check "
          "when the kings face each other. Waiting rook moves keep the box.",
          you="KR", them="K", rule="center", min_mate=9),
    Drill("kbb", "Checkmates", "Two bishops", "mate", 3,
          "Mate with king and two bishops.",
          "Side by side the bishops build a wall the king can't cross. Push it to a corner with "
          "your king's help; the mate comes in the corner.",
          you="KBB", them="K", rule="center", min_mate=10),
    Drill("kbn", "Checkmates", "Bishop and knight", "mate", 5,
          "The hardest basic mate: king, bishop and knight.",
          "Mate is only forced in a corner of your bishop's colour. Drive the king to the edge, then "
          "use the W-manoeuvre of the knight to herd it from the wrong corner to the right one. "
          "You have 50 moves.",
          you="KBN", them="K", rule="center", min_mate=16),
    # ------------------------------------------------------------------ mating patterns (forced mates to recognise)
    Drill("backrank", "Mating patterns", "Back-rank mate", "mate", 1,
          "Mate on the back rank – the king is boxed in by its own pawns.",
          "Count the defenders of the back rank. Remove or deflect the only one (a capture with check), "
          "then the rook comes in. Mate in 2.",
          fens=("3r2k1/2q2ppp/8/3Q4/8/8/5PPP/3R2K1 w - - 0 1",)),
    Drill("arabian", "Mating patterns", "Arabian mate", "mate", 1,
          "Rook and knight against a king in the corner.",
          "The knight guards the rook and the square next to the corner; the rook gives mate next to the king. "
          "Bring the knight first – and leave the king a legal move, or it is stalemate. Mate in 2.",
          fens=("7k/1R6/8/p7/4N3/8/8/6K1 w - - 0 1",)),
    Drill("anastasia", "Mating patterns", "Anastasia's mate", "mate", 2,
          "Knight and rook against a king on the edge, trapped by its own pawn.",
          "The knight on e7 covers g8 and g6. Sacrifice to open the h-file, then the rook mates along it. Mate in 2.",
          fens=("5r1k/4Nppp/8/7Q/8/3R4/5PPP/6K1 w - - 0 1",)),
    Drill("boden", "Mating patterns", "Boden's mate", "mate", 2,
          "Two bishops on crossing diagonals against a king castled long.",
          "The king's own pieces block its escape squares. Sacrifice on c6 to open the diagonal; one bishop "
          "covers the squares in front of the king, the other mates. Mate in 2.",
          fens=("2kr4/pp1n1ppp/2n5/8/4QB2/8/PPP2PPP/5BK1 w - - 0 1",)),
    Drill("legal", "Mating patterns", "Légal's mate", "mate", 2,
          "The opening trap: the queen was taken, but the minor pieces mate.",
          "Your queen is gone – ignore it. Check on f7 with the bishop, then the second knight mates. Mate in 2. "
          "(Position after 1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6 5.Nxe5 Bxd1.)",
          fens=(_after("e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1"),)),
    Drill("smothered", "Mating patterns", "Smothered mate", "mate", 3,
          "Philidor's legacy: the knight mates a king surrounded by its own pieces.",
          "Queen and knight check in turn and drive the king into the corner. Then sacrifice the queen on g8: "
          "the rook has to take, and the knight mates on f7. Every move is a check.",
          fens=("r5k1/6pp/8/1b4N1/8/8/4Q3/6K1 w - - 0 1",)),
    # ------------------------------------------------------------------ pawn endings
    Drill("kpk", "Pawn endings", "King and pawn vs king", "promote", 2,
          "Escort your pawn to promotion.",
          "King in front of the pawn, not behind it. Take the opposition; with a rook pawn or a "
          "king stuck in front of the pawn the win is often gone.",
          you="KP", them="K", rule="kpk", care=True),
    Drill("kkp", "Pawn endings", "Stop the pawn (defend)", "draw", 2,
          "Hold the draw against king and pawn.",
          "Get in front of the pawn and keep the opposition; when the pawn reaches your rank "
          "with check, step straight back, not sideways.",
          you="K", them="KP", rule="kkp", care=True, survive=12),
    Drill("break", "Pawn endings", "Pawn breakthrough", "promote", 3,
          "Three pawns against three – break through.",
          "Sacrifice to deflect: push the middle pawn first. Whatever takes, another pawn runs through.",
          fens=("7k/ppp5/8/PPP5/8/8/8/7K w - - 0 1",), care=True),
    Drill("reti", "Pawn endings", "Réti manoeuvre (defend)", "draw", 4,
          "Your king is too far from both pawns – and still draws.",
          "Walk the king diagonally: on the diagonal it heads for the enemy pawn and for your own pawn at the "
          "same time. Whichever the opponent stops, you reach the other one in time.",
          fens=("7K/8/k1P5/7p/8/8/8/8 w - - 0 1",), care=True, survive=8),
    # ------------------------------------------------------------------ rook endings
    Drill("lucena", "Rook endings", "Lucena position", "promote", 3,
          "Win the most important rook ending: build a bridge.",
          "Cut the enemy king off with a check, put the rook on the fourth rank, walk your king out "
          "and block the checks with the rook (the bridge).",
          fens=("1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1",), shift=True, care=True),
    Drill("philidor", "Rook endings", "Philidor position (defend)", "draw", 3,
          "Hold the draw a pawn down with the third-rank defence.",
          "Keep your rook on the third rank from your side until the pawn advances; then go behind "
          "the king and check it from far away.",
          fens=("4k3/R7/8/3KP3/8/8/8/6r1 b - - 0 1",), shift=True, care=True, survive=12),
    Drill("rvp", "Rook endings", "Rook vs pawn", "win", 3,
          "Stop an advanced pawn with the rook before its king can help it.",
          "Bring your king towards the pawn first – the rook alone usually can't win it. Cut the enemy king off "
          "with the rook along a rank or file, and check only when it gains time.",
          you="KR", them="KP", rule="rvp", care=True),
    # ------------------------------------------------------------------ minor pieces
    Drill("wrongb", "Minor pieces", "Wrong bishop (defend)", "draw", 2,
          "Bishop and rook pawn against you – but the bishop can't cover the corner.",
          "Get your king into the corner in front of the pawn. A bishop that doesn't control the queening "
          "square can never drive you out: stay there and it's a draw.",
          you="K", them="KBP", rule="wrongb", care=True, survive=10),
    Drill("ocb", "Minor pieces", "Opposite-coloured bishops (defend)", "draw", 3,
          "Two pawns down with bishops of opposite colours – hold the draw.",
          "Blockade the pawns on squares of your bishop's colour, with your king in front of them. "
          "The other bishop can never attack those squares; don't trade into a lost pawn ending.",
          you="KB", them="KBPP", rule="ocb", care=True, survive=12),
    # ------------------------------------------------------------------ queen endings
    Drill("qp7", "Queen endings", "Queen vs pawn on the 7th", "win", 3,
          "Stop the pawn and win it – or mate.",
          "Check, or pin, until the enemy king has to step in front of the pawn; use that tempo "
          "to bring your own king one step closer. Repeat.",
          you="KQ", them="KP", rule="qp7"),
    Drill("kqkr", "Queen endings", "Queen vs rook", "win", 5,
          "Win the rook or mate – it takes technique.",
          "Push the king to the edge, then reach the winning set-up with your opponent to move: "
          "forks, skewers and mates appear by themselves. Philidor's position is the target.",
          you="KQ", them="KR", rule="kqkr", min_mate=6),
]
BY_ID = {d.id: d for d in DRILLS}
GOALS = {"mate": "Checkmate", "promote": "Promote safely", "win": "Win the material", "draw": "Hold the draw"}


# --------------------------------------------------------------------------- #
#  Evaluating
# --------------------------------------------------------------------------- #

@dataclass
class Verdict:
    verdict: str            # win | draw | loss (for you)
    cp: int | None
    mate: int | None        # mate in N (your POV: + you mate, - you get mated)
    best: chess.Move | None
    tb: bool = False

    def out(self) -> dict:
        return {"verdict": self.verdict, "cp": self.cp, "mate": self.mate, "tb": self.tb}


def _tb_wdl(board: chess.Board) -> int | None:
    if _tb is None or chess.popcount(board.occupied) > 7:
        return None
    try:
        return _tb.probe_wdl(board)
    except (KeyError, chess.syzygy.MissingTableError):
        return None


def judge(board: chess.Board, you: chess.Color, depth: int = 18, max_time: float = 0.5) -> Verdict:
    """How the position stands for you (any side to move), and the best move in it."""
    out = board.outcome(claim_draw=True)
    if out is not None:
        v = "draw" if out.winner is None else ("win" if out.winner == you else "loss")
        return Verdict(v, 0 if v == "draw" else None, 0 if v != "draw" else None, None)
    info = _sf.analyse(board, depth=depth, max_time=max_time)[0]
    sc = info["score"].pov(you)
    mate, cp = sc.mate(), sc.score()
    best = info["pv"][0] if info.get("pv") else None
    if _mating_material(board, you) and (board.turn == you or all(_kept(board, mv, you) for mv in board.legal_moves)):
        # Stockfish scores e.g. bishop + knight vs king modestly without tablebases; it's a known win.
        return Verdict("win", cp, mate, best)
    wdl = _tb_wdl(board)
    if wdl is not None:
        mine = wdl if board.turn == you else -wdl
        v = "win" if mine == 2 else "loss" if mine == -2 else "draw"  # cursed wins (±1) are draws
        return Verdict(v, cp, mate, best, tb=True)
    if mate is not None:
        v = "win" if mate > 0 else "loss"
    else:
        v = "win" if cp >= WIN_CP else "loss" if cp <= -WIN_CP else "draw" if abs(cp) < DRAW_CP else "unclear"
    return Verdict(v, cp, mate, best)


def _mating_material(board: chess.Board, you: chess.Color) -> bool:
    """The opponent has a bare king and you can force mate (queen, rook, two bishops or bishop + knight)."""
    them = not you
    if board.occupied_co[them] != chess.BB_SQUARES[board.king(them)]:
        return False
    if board.pieces(chess.QUEEN, you) or board.pieces(chess.ROOK, you):
        return True
    bishops = board.pieces(chess.BISHOP, you)
    if bishops and board.pieces(chess.KNIGHT, you):
        return True
    return bool(bishops & chess.BB_LIGHT_SQUARES) and bool(bishops & chess.BB_DARK_SQUARES)


def _kept(board: chess.Board, mv: chess.Move, you: chess.Color) -> bool:
    """After the bare king's move `mv` you still have mating material (it didn't take a piece you need)."""
    board.push(mv)
    try:
        return _mating_material(board, you)
    finally:
        board.pop()


def _ruins(board: chess.Board, you: chess.Color, want: str) -> int:
    """How many of your legal moves throw away the result `want` (quick search)."""
    moves = list(board.legal_moves)
    infos = _sf.analyse(board, depth=12, multipv=len(moves), max_time=0.6)
    bad = 0
    for i in infos:
        if "score" not in i:
            continue
        sc = i["score"].pov(you)
        m, cp = sc.mate(), sc.score()
        if want == "win":
            bad += not ((m is not None and m > 0) or (cp is not None and cp >= WIN_CP))
        else:
            bad += (m is not None and m < 0) or (cp is not None and cp <= -WIN_CP)
    return bad


# --------------------------------------------------------------------------- #
#  Making positions
# --------------------------------------------------------------------------- #

def _dist(a: int, b: int) -> int:
    return chess.square_distance(a, b)


def _rule_ok(rule: str, b: chess.Board) -> bool:
    wk, bk = b.king(chess.WHITE), b.king(chess.BLACK)
    if rule == "center":
        return 2 <= chess.square_file(bk) <= 5 and 2 <= chess.square_rank(bk) <= 5
    if rule == "kpk":   # the defender is inside the pawn's square, so it's not a simple race
        p = next(iter(b.pieces(chess.PAWN, chess.WHITE)))
        promo = chess.square(chess.square_file(p), 7)
        steps = 5 if chess.square_rank(p) == 1 else 7 - chess.square_rank(p)
        return _dist(bk, promo) <= steps - 1 and _dist(wk, p) <= 3
    if rule == "kkp":   # you (White) can still reach the pawn – but can't simply take it
        p = next(iter(b.pieces(chess.PAWN, chess.BLACK)))
        promo = chess.square(chess.square_file(p), 0)
        steps = min(chess.square_rank(p), 5)
        return _dist(wk, promo) <= steps and _dist(bk, p) <= 2 and (_dist(wk, p) >= 2 or _dist(bk, p) == 1)
    if rule == "qp7":   # black pawn one step from queening, its king next to it, your king far away
        p = next(iter(b.pieces(chess.PAWN, chess.BLACK)))
        return chess.square_rank(p) == 1 and _dist(bk, p) == 1 and _dist(wk, p) >= 4
    if rule == "rvp":   # an advanced pawn with its king next to it, your king some way off
        p = next(iter(b.pieces(chess.PAWN, chess.BLACK)))
        r = next(iter(b.pieces(chess.ROOK, chess.WHITE)))
        return _dist(bk, p) <= 2 and _dist(wk, p) >= 3 and not b.is_attacked_by(chess.BLACK, r)
    if rule == "wrongb":  # rook pawn, bishop of the other colour than the queening square, your king can get there
        p = next(iter(b.pieces(chess.PAWN, chess.BLACK)))
        bi = next(iter(b.pieces(chess.BISHOP, chess.BLACK)))
        promo = chess.square(chess.square_file(p), 0)
        light = lambda sq: bool(chess.BB_SQUARES[sq] & chess.BB_LIGHT_SQUARES)  # noqa: E731
        return light(bi) != light(promo) and 2 <= _dist(wk, promo) <= chess.square_rank(p) and wk != promo
    if rule == "ocb":     # bishops of opposite colours, nothing hangs at once
        mine = next(iter(b.pieces(chess.BISHOP, chess.WHITE)))
        theirs = next(iter(b.pieces(chess.BISHOP, chess.BLACK)))
        light = lambda sq: bool(chess.BB_SQUARES[sq] & chess.BB_LIGHT_SQUARES)  # noqa: E731
        return light(mine) != light(theirs) and not b.is_attacked_by(chess.BLACK, mine)
    if rule == "kqkr":  # nothing hangs at once
        r = next(iter(b.pieces(chess.ROOK, chess.BLACK)))
        q = next(iter(b.pieces(chess.QUEEN, chess.WHITE)))
        return not b.is_attacked_by(chess.WHITE, r) and not b.is_attacked_by(chess.BLACK, q) and _dist(wk, bk) >= 3
    return True


def _random_board(d: Drill, rng: random.Random) -> chess.Board | None:
    b = chess.Board(None)
    b.turn = chess.WHITE
    free = list(chess.SQUARES)
    rng.shuffle(free)
    pawn_ranks = {"kpk": range(1, 6), "kkp": range(2, 6), "qp7": range(1, 2), "rvp": range(2, 4),
                  "wrongb": range(2, 6), "ocb": range(2, 6)}.get(d.rule, range(1, 7))
    pawn_files = {"wrongb": (0, 7)}.get(d.rule, range(8))
    for color, pieces in ((chess.WHITE, d.you), (chess.BLACK, d.them)):
        for sym in pieces:
            pt = chess.Piece.from_symbol(sym).piece_type
            for i, sq in enumerate(free):
                if pt == chess.PAWN and (chess.square_rank(sq) not in pawn_ranks or chess.square_file(sq) not in pawn_files):
                    continue
                if pt == chess.BISHOP and d.you.count("B") == 2 and color == chess.WHITE:
                    others = b.pieces(chess.BISHOP, chess.WHITE)
                    if others and (chess.BB_SQUARES[sq] & chess.BB_LIGHT_SQUARES) == \
                            (chess.BB_SQUARES[next(iter(others))] & chess.BB_LIGHT_SQUARES):
                        continue  # bishops on opposite colours
                b.set_piece_at(sq, chess.Piece(pt, color))
                free.pop(i)
                break
    if not b.is_valid() or b.is_game_over() or not _rule_ok(d.rule, b):
        return None
    return b


def _fixed_board(d: Drill, rng: random.Random) -> chess.Board | None:
    b = chess.Board(rng.choice(d.fens))
    if d.shift:
        df = rng.randint(-7, 7)
        out = chess.Board(None)
        out.turn = b.turn
        for sq, pc in b.piece_map().items():
            f = chess.square_file(sq) + df
            if not 0 <= f <= 7:
                return None
            out.set_piece_at(chess.square(f, chess.square_rank(sq)), pc)
        b = out
    return b if b.is_valid() and not b.is_game_over() else None


def _transform(b: chess.Board, rng: random.Random) -> chess.Board:
    if rng.random() < 0.5:
        b = b.transform(chess.flip_horizontal)
    if rng.random() < 0.5:
        b = b.mirror()      # swap colours (and flip the board): you play the other side
    b.castling_rights = 0
    b.ep_square = None
    b.halfmove_clock, b.fullmove_number = 0, 1
    return b


def make(d: Drill, rng: random.Random | None = None, tries: int = 80) -> tuple[chess.Board, Verdict]:
    rng = rng or random.Random()
    want = "draw" if d.goal == "draw" else "win"
    fallback = None
    care_checks = 0
    deadline = time.time() + 10
    for _ in range(tries):
        if time.time() > deadline and fallback:
            break
        # Random placements: try a few until one fits the drill's rule (cheap – no engine yet).
        b = _fixed_board(d, rng) if d.fens else next((x for x in (_random_board(d, rng) for _ in range(50)) if x is not None), None)
        if b is None:
            continue
        b = _transform(b, rng)
        you = b.turn
        v = judge(b, you, depth=16, max_time=0.35)
        if v.verdict != want:
            continue
        if d.min_mate and v.mate is not None and v.mate < d.min_mate:
            continue
        fallback = fallback or (b, v)
        if d.care and care_checks < 8:
            care_checks += 1
            if not _ruins(b, you, want):
                continue
        return _deepen(d, b, v)
    if fallback:
        return _deepen(d, *fallback)
    raise RuntimeError(f"Couldn't make a position for {d.title}.")


def _deepen(d: Drill, b: chess.Board, v: Verdict) -> tuple[chess.Board, Verdict]:
    """For the mates: a longer search, so "mate in N with best play" is known more often."""
    if d.goal == "mate" and v.mate is None:
        deep = judge(b, b.turn, depth=60, max_time=1.5)
        if deep.mate is not None and deep.mate > 0:
            v = Verdict(v.verdict, v.cp, deep.mate, deep.best, v.tb)
    return b, v


_ready: dict[str, list[tuple[chess.Board, Verdict]]] = {}
_ready_lock = threading.Lock()
_filling: set[str] = set()


def _prefill(d: Drill) -> None:
    """Make the next position in the background, so "next position" is instant."""
    with _ready_lock:
        if d.id in _filling or len(_ready.get(d.id, [])) >= 1:
            return
        _filling.add(d.id)

    def run():
        try:
            pos = make(d)
            with _ready_lock:
                _ready.setdefault(d.id, []).append(pos)
        except Exception:
            pass
        finally:
            with _ready_lock:
                _filling.discard(d.id)
    threading.Thread(target=run, daemon=True).start()


def new(drill_id: str) -> dict:
    d = BY_ID[drill_id]
    with _ready_lock:
        pool = _ready.get(d.id) or []
        pos = pool.pop(0) if pool else None
    if pos is None:
        pos = make(d)
    _prefill(d)
    b, v = pos
    return {"fen": b.fen(), "you": "w" if b.turn == chess.WHITE else "b", "eval": v.out(),
            "optimal": v.mate if v.mate and v.mate > 0 else None}


# --------------------------------------------------------------------------- #
#  Playing
# --------------------------------------------------------------------------- #

def _board(fen: str, moves: list[str]) -> chess.Board:
    b = chess.Board(fen)
    if not b.is_valid():  # Stockfish crashes on impossible positions
        raise ValueError("Invalid position")
    for u in moves:
        mv = b.parse_uci(u)
        if mv not in b.legal_moves:
            raise ValueError(f"Illegal move {u}")
        b.push(mv)
    return b


def _tb_move(b: chess.Board) -> chess.Move | None:
    """Tablebase-perfect move: keep the best result; win fastest / lose slowest (by DTZ)."""
    if _tb is None or chess.popcount(b.occupied) > 7:
        return None
    best, key = None, None
    try:
        for mv in b.legal_moves:
            b.push(mv)
            try:
                if b.is_checkmate():
                    k = (3, 0)
                else:
                    wdl = -_tb.probe_wdl(b)
                    dtz = abs(_tb.probe_dtz(b))
                    k = (wdl, -dtz if wdl > 0 else dtz)
            finally:
                b.pop()
            if key is None or k > key:
                best, key = mv, k
    except (KeyError, chess.syzygy.MissingTableError):
        return None
    return best


def _human_move(b: chess.Board, level: int) -> chess.Move:
    pol = nightmare.maia(nightmare.nearest_level(level)).policy(b)
    cands = [(mv, p) for mv, p in pol if p >= 0.02][:8] or pol[:1]
    return random.choices([mv for mv, _ in cands], weights=[p for _, p in cands])[0]


def _status(d: Drill, b: chess.Board, you: chess.Color, start_queens: int, mine: int, v: Verdict | None) -> dict | None:
    """Finished? {result: success | fail, reason}."""
    out = b.outcome(claim_draw=True)
    if out is not None:
        if out.termination == chess.Termination.CHECKMATE:
            return {"result": "success", "reason": "Checkmate!"} if out.winner == you else \
                {"result": "fail", "reason": "You were checkmated."}
        reason = {chess.Termination.STALEMATE: "Stalemate", chess.Termination.INSUFFICIENT_MATERIAL: "Not enough material left",
                  chess.Termination.THREEFOLD_REPETITION: "Draw by repetition", chess.Termination.FIFTY_MOVES: "50-move rule",
                  }.get(out.termination, "Draw")
        if d.goal == "draw":
            return {"result": "success", "reason": f"{reason} – you held the draw!"}
        return {"result": "fail", "reason": f"{reason} – the win slipped away."}
    if v is None:
        return None
    them = not you
    if d.goal == "promote" and len(b.pieces(chess.QUEEN, you)) > start_queens and v.verdict == "win":
        return {"result": "success", "reason": "Promoted – and the new queen is safe."}
    if d.goal == "win" and v.verdict == "win" and b.occupied_co[them] == chess.BB_SQUARES[b.king(them)]:
        return {"result": "success", "reason": "Won the material – the rest is a basic mate."}
    if d.goal == "draw" and mine >= d.survive and v.verdict == "draw":
        return {"result": "success", "reason": f"You held for {mine} moves – it's a draw."}
    return None


def play(drill_id: str, fen: str, moves: list[str], mode: str, level: int | None) -> dict:
    """You just played moves[-1]: judge it, then answer (unless the drill is over)."""
    d = BY_ID[drill_id]
    start = chess.Board(fen)
    you = start.turn
    start_queens = len(start.pieces(chess.QUEEN, you))
    b = _board(fen, moves)
    mine = (len(moves) + 1) // 2
    want = "draw" if d.goal == "draw" else "win"

    v = judge(b, you, depth=20 if mode == "perfect" else 16, max_time=0.9 if mode == "perfect" else 0.45)
    slipped = (v.verdict != "win") if want == "win" else (v.verdict == "loss")
    res = {"eval": v.out(), "slipped": slipped, "status": _status(d, b, you, start_queens, mine, v), "reply": None}
    if slipped:
        prev = _board(fen, moves[:-1])
        pv = judge(prev, you, depth=18, max_time=0.5)
        if pv.best is not None and pv.best.uci() != moves[-1]:
            res["better"] = {"uci": pv.best.uci(), "san": prev.san(pv.best)}
    if res["status"] is not None:
        return res

    if mode == "human" and nightmare.available():
        reply = _human_move(b, level or nightmare.profile().rating)
    else:
        reply = _tb_move(b) or v.best or next(iter(b.legal_moves))
    res["reply"] = {"uci": reply.uci(), "san": b.san(reply)}
    b.push(reply)
    res["status"] = _status(d, b, you, start_queens, mine, None)
    return res


def hint(fen: str, moves: list[str]) -> dict:
    b = _board(fen, moves)
    you = chess.Board(fen).turn
    mv = _tb_move(b)
    v = judge(b, you, depth=20, max_time=1.0)
    mv = mv or v.best
    if mv is None:
        raise ValueError("No move to suggest here.")
    return {"uci": mv.uci(), "san": b.san(mv), "eval": v.out()}


# --------------------------------------------------------------------------- #
#  Your record
# --------------------------------------------------------------------------- #

_stats_lock = threading.Lock()


def _stats() -> dict:
    try:
        return json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


LESSONS_FILE = DATA / "endgame_lessons.yaml"


@lru_cache(maxsize=1)
def lessons() -> dict[str, dict]:
    """How each drill works (data/endgame_lessons.yaml): idea, when to look for it, steps, common mistakes."""
    try:
        raw = yaml.safe_load(LESSONS_FILE.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}
    return {k: {f: v[f] for f in ("idea", "spot", "steps", "mistakes") if v.get(f)} for k, v in raw.items()}


def summary() -> dict:
    stats = _stats()
    avail = nightmare.available()
    rating = nightmare.profile().rating if avail else None
    return {
        "drills": [{**{k: v for k, v in asdict(d).items() if k in ("id", "group", "title", "goal", "level", "blurb", "tip", "survive")},
                    "goalText": GOALS[d.goal], "record": stats.get(d.id, {}), "lesson": lessons().get(d.id)} for d in DRILLS],
        "maia": avail,
        "levels": [lv for lv in nightmare.LEVELS if (nightmare.MAIA_DIR / f"maia-{lv}.pb.gz").exists()] if avail else [],
        "level": nightmare.nearest_level(rating) if rating else None,
        "tablebase": _tb is not None,
    }


def finish(drill_id: str, mode: str, result: str, moves: int, optimal: int | None, takebacks: int, hints: int) -> dict:
    with _stats_lock:
        data = _stats()
        r = data.setdefault(drill_id, {})
        m = r.setdefault(mode, {"attempts": 0, "solved": 0, "clean": 0, "streak": 0, "best": None})
        m["attempts"] += 1
        if result == "success":
            m["solved"] += 1
            clean = not takebacks and not hints
            m["clean"] += clean
            m["streak"] = m["streak"] + 1 if clean else 0
            if clean and (m["best"] is None or moves < m["best"]):
                m["best"] = moves
            if clean and optimal and moves <= optimal:
                m["perfect"] = m.get("perfect", 0) + 1
        else:
            m["streak"] = 0
        m["last"] = int(time.time())
        write_atomic(STATS_FILE, json.dumps(data))
        return r


def close() -> None:
    _sf.close()
