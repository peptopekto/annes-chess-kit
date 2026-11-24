"""Name the tactic in a line of play (fork, pin, back-rank mate, …).

Used to explain *why* a move was bad ("it allows a knight fork") and to group
mistakes by theme in Insights. Heuristic, built on python-chess attack maps;
it looks at the attacker's first two moves of the engine line.
"""
from __future__ import annotations

import chess

from . import classify as C

VALUES = C.PIECE_VALUES

# Ordered by how specific / instructive the label is.
THEMES = {
    "back_rank": "Back-rank mate",
    "mate": "Checkmate",
    "fork": "Fork",
    "pin": "Pin",
    "skewer": "Skewer",
    "discovered": "Discovered attack",
    "trapped": "Trapped piece",
    "free_piece": "Free piece",
    "promotion": "Promotion",
    # Puzzle-only themes (drills from your games): defending and winning material through exchanges.
    "stop_mate": "Stop the mate",
    "save_piece": "Save your piece",
    "win_material": "Win material",
}

TIPS = {
    "back_rank": "Give your king an escape square (a 'luft' pawn move like h3/h6) once the back rank gets empty.",
    "mate": "Every move, ask: what checks does my opponent have? Mates always start with a check.",
    "fork": "Before moving, look at where enemy knights and queens can jump to – two of your pieces on that square's lines is a fork waiting to happen.",
    "pin": "Watch out for pieces lined up with your king or queen on a file or diagonal – a bishop, rook or queen can pin them.",
    "skewer": "Don't leave your king or queen in front of another valuable piece on an open line.",
    "discovered": "When an enemy piece blocks their own rook, bishop or queen, ask what happens if it moves away with tempo.",
    "trapped": "Before a piece goes to the edge or deep into the enemy camp, check that it has a way back – a piece with no safe squares is lost to the first attack.",
    "free_piece": "Blunder check before every move: is the piece I'm moving – or one I'm leaving behind – defended?",
    "promotion": "Count the steps for passed pawns: stop them early, the closer they get the harder it is.",
    "stop_mate": "Every move, ask: what checks does my opponent have next – and could one of them be mate?",
    "save_piece": "Before your own plans, check: is one of my pieces attacked and not defended enough?",
    "win_material": "Look at every capture and what follows: trades can win material even when nothing is simply hanging.",
}


def _value(board: chess.Board, sq: chess.Square) -> int:
    pt = board.piece_type_at(sq)
    return 100 if pt == chess.KING else VALUES.get(pt, 0)


def _defended(board: chess.Board, sq: chess.Square) -> bool:
    piece = board.piece_at(sq)
    return bool(piece and board.attackers(piece.color, sq))


def _juicy(board: chess.Board, target: chess.Square, attacker_sq: chess.Square) -> bool:
    """Is attacking `target` from `attacker_sq` actually threatening something?"""
    tv = _value(board, target)
    if tv == 100:
        return True  # check
    if tv < 3:
        return False
    return tv > _value(board, attacker_sq) or not _defended(board, target)


DIRECTIONS = {
    chess.BISHOP: [(1, 1), (1, -1), (-1, 1), (-1, -1)],
    chess.ROOK: [(1, 0), (-1, 0), (0, 1), (0, -1)],
}
DIRECTIONS[chess.QUEEN] = DIRECTIONS[chess.BISHOP] + DIRECTIONS[chess.ROOK]


def _ray_pieces(board: chess.Board, sq: chess.Square, d: tuple[int, int], n: int = 2) -> list[chess.Square]:
    """First `n` occupied squares walking from `sq` in direction `d`."""
    f, r = chess.square_file(sq), chess.square_rank(sq)
    out = []
    while len(out) < n:
        f, r = f + d[0], r + d[1]
        if not (0 <= f < 8 and 0 <= r < 8):
            break
        s = chess.square(f, r)
        if board.piece_at(s):
            out.append(s)
    return out


def themes_of_move(board: chess.Board, move: chess.Move) -> list[str]:
    """Tactical themes created by `move` (board is the position before it)."""
    me, them = board.turn, not board.turn
    out: list[str] = []
    if move.promotion:
        out.append("promotion")
    if board.is_capture(move) and not board.is_en_passant(move):
        victim, taker = _value(board, move.to_square), _value(board, move.from_square)
        if victim >= 3 and (victim > taker or not _defended(board, move.to_square)):
            out.append("free_piece")

    after = board.copy(stack=False)
    after.push(move)
    to = move.to_square
    if after.is_checkmate():
        king = after.king(them)
        back = 0 if them == chess.WHITE else 7
        if king is not None and chess.square_rank(king) == back and chess.square_rank(to) == back                 and after.piece_type_at(to) in (chess.ROOK, chess.QUEEN):
            return ["back_rank", "mate"] + out
        return ["mate"] + out

    # Fork: the moved piece attacks two worthwhile targets and can't simply be taken for free.
    targets = [t for t in after.attacks(to) if after.color_at(t) == them and _juicy(after, t, to)]
    if len(targets) >= 2:
        safe = not after.is_attacked_by(them, to)
        trades_up = _value(after, to) < min(_value(after, t) for t in targets)
        if safe or trades_up:
            out.append("fork")

    # Discovered attack: another of my long-range pieces now hits something it couldn't before.
    for sq in board.pieces(chess.BISHOP, me) | board.pieces(chess.ROOK, me) | board.pieces(chess.QUEEN, me):
        if sq == move.from_square:
            continue
        before_hits = board.attacks(sq)
        if any(t not in before_hits and after.color_at(t) == them and _juicy(after, t, sq) for t in after.attacks(sq)):
            out.append("discovered")
            break

    # Trapped piece: the move attacks a piece (with something cheaper, or one that's undefended) that
    # has no square left where it survives.
    if _trapped_by(after, to) is not None:
        out.append("trapped")

    # Pin / skewer along the moved piece's lines.
    pt = after.piece_type_at(to)
    for d in DIRECTIONS.get(pt, []):
        hits = _ray_pieces(after, to, d)
        if len(hits) < 2 or after.color_at(hits[0]) != them or after.color_at(hits[1]) != them:
            continue
        front, back = _value(after, hits[0]), _value(after, hits[1])
        if back == 100 and front >= 3:
            out.append("pin")       # front piece can't move without exposing the king
        elif front >= 9 and back >= 3 and front > back:
            out.append("skewer")    # the big piece must move and leaves the one behind
        elif front >= 3 and back > front and back >= 5 and _value(after, to) < back:
            out.append("pin")       # relative pin to a more valuable piece (and the pinner is cheaper)
    return out


def _lost_on(board: chess.Board, sq: chess.Square) -> int:
    """Material the piece on `sq` loses if the other side simply takes it (0 when it's safe there)."""
    piece = board.piece_at(sq)
    attackers = board.attackers(not piece.color, sq)
    if not attackers:
        return 0
    value = _value(board, sq)
    if not board.attackers(piece.color, sq):
        return value
    return max(0, value - min(_value(board, a) for a in attackers))


def _trapped_by(after: chess.Board, to: chess.Square) -> chess.Square | None:
    """The square of an enemy piece that the piece now on `to` attacks and that can't be saved by moving it:
    wherever it goes (captures included) it loses at least two points. `after`: the position after the
    move, the victim's side to move."""
    them = after.turn
    if after.is_check():
        return None  # they have to deal with the check first – that's a different tactic
    for t in after.attacks(to):
        piece = after.piece_at(t)
        if piece is None or piece.color != them or piece.piece_type in (chess.PAWN, chess.KING):
            continue
        if _lost_on(after, t) < 2:
            continue
        escapes = False
        for mv in after.legal_moves:
            if mv.from_square != t:
                continue
            won = _value(after, mv.to_square) if after.piece_at(mv.to_square) else 0
            b = after.copy(stack=False)
            b.push(mv)
            if b.is_checkmate() or _lost_on(b, mv.to_square) - won < 2:
                escapes = True
                break
        if not escapes:
            return t
    return None


def trapped_square(board: chess.Board, move: chess.Move) -> chess.Square | None:
    """The square of the piece that `move` (played from `board`) traps, if it traps one."""
    after = board.copy(stack=False)
    after.push(move)
    return _trapped_by(after, move.to_square)


def _balance(board: chess.Board, color: chess.Color) -> int:
    """Material of `color` minus the opponent's (pawn 1, minor 3, rook 5, queen 9)."""
    return sum((VALUES.get(p.piece_type, 0) if p.piece_type != chess.KING else 0) * (1 if p.color == color else -1)
               for p in board.piece_map().values())


def _gain(board: chess.Board, sans: list[str], before: chess.Board, plies: int = 4) -> int | None:
    """Material the side to move at `board` is up after the line (captures played out), compared with `before`."""
    me = board.turn
    b = board.copy(stack=False)
    played = 0
    for san in sans[:plies + 4]:
        try:
            move = b.parse_san(san)
        except ValueError:
            break
        capture = b.is_capture(move)
        b.push(move)
        played += 1
        if played >= plies and not capture:
            break  # the exchange is over
    return _balance(b, me) - _balance(before, me) if played else None


def theme_of_line(board: chess.Board, sans: list[str], before: chess.Board | None = None) -> str | None:
    """Most instructive theme in the attacker's first two moves of a line (SAN, from `board`).

    `before`: the position before the move being judged (when the line is the reply to it). A capture
    only counts as winning material if the attacker really ends up ahead of *that* position once the
    captures are played out – taking back a piece that just captured is a trade, not a free piece.
    The same goes for forks, pins, skewers and discovered attacks: the geometry alone isn't a tactic,
    the line has to win material (or mate) with it.
    """
    b = board.copy(stack=False)
    found: list[str] = []
    first_take = 0  # value of what the line's first move captures
    for i, san in enumerate(sans[:3]):
        try:
            move = b.parse_san(san)
        except ValueError:
            break
        if i == 0 and b.is_capture(move):
            first_take = VALUES[chess.PAWN] if b.is_en_passant(move) else _value(b, move.to_square)
        if i % 2 == 0:  # attacker's moves only
            # A piece is trapped by the line's first move – later in the line it's just an exchange.
            found += [t for t in themes_of_move(b, move) if i == 0 or t != "trapped"]
        b.push(move)
        if b.is_checkmate():
            found.insert(0, "mate")
            break
    # (A line of a move or two is too short to tell – then the shape of the move decides.)
    if len(sans) >= 3 and any(t in WINS_MATERIAL for t in found) and not _mates(board, sans):
        gain = _gain(board, sans, before or board, plies=6)
        if gain is not None and gain < 2:
            found = [t for t in found if t not in WINS_MATERIAL]
        elif gain is not None and gain <= first_take:
            # All it wins is the piece its first move takes: that's the point – not a fork or pin that
            # happens to show up later in the line.
            found = ["free_piece"] + [t for t in found if t not in WINS_MATERIAL]
    for t in THEMES:  # priority order
        if t in found:
            return t
    return None


WINS_MATERIAL = ("free_piece", "fork", "pin", "skewer", "discovered", "trapped")  # themes that are about winning material


def _mates(board: chess.Board, sans: list[str], plies: int = 8) -> bool:
    """Does the line end in checkmate within a few moves?"""
    b = board.copy(stack=False)
    for san in sans[:plies]:
        try:
            b.push_san(san)
        except ValueError:
            return False
        if b.is_checkmate():
            return True
    return False


def describe(theme: str | None) -> str | None:
    return THEMES.get(theme) if theme else None


def changes_material(m: dict) -> bool:
    """A capture or a promotion (a stored review move)."""
    move = chess.Move.from_uci(m["uci"])
    return move.promotion is not None or chess.Board(m["fenBefore"]).is_capture(move)


def exchange_start(moves: list[dict], i: int, limit: int = 8) -> chess.Board:
    """The position before the run of captures (and promotions) that ends right before `moves[i]` – its own
    position if there's none. Material is judged from there: taking back a piece that just captured is a
    trade, not a won piece."""
    j = i
    while j > 0 and i - j < limit and changes_material(moves[j - 1]):
        j -= 1
    return chess.Board(moves[j]["fenBefore"])


# --------------------------------------------------------------------------- #
#  Per-move explanation for reviews (computed on the fly, works for old reviews)
# --------------------------------------------------------------------------- #

BAD = {C.INACCURACY, C.MISTAKE, C.MISS, C.BLUNDER}


def enrich(record: dict) -> dict:
    """Add `refute` (the opponent's punishing reply) and `missed` (the tactic you missed) to moves."""
    moves = record.get("moves", [])
    for i, m in enumerate(moves):
        if m["cls"] not in BAD:
            continue
        # What did this move allow? The engine's best reply in the next position.
        nxt = moves[i + 1] if i + 1 < len(moves) else None
        if nxt and m["cls"] in (C.MISTAKE, C.BLUNDER, C.INACCURACY):
            after = chess.Board(m["fen"])
            line = nxt.get("bestLine") or [nxt["bestSan"]]
            theme = theme_of_line(after, line, chess.Board(m["fenBefore"]))
            m["refute"] = {"san": nxt["bestSan"], "uci": nxt["bestUci"], "line": line[:6], "theme": theme,
                           "label": describe(theme)}
        # What did you miss? The theme of your own best line (for a Mistake, Miss or Blunder – the bands
        # follow the players' level, so a fixed loss would leave out the mistakes of lower-rated games).
        if m["cls"] in (C.MISTAKE, C.MISS, C.BLUNDER):
            theme = theme_of_line(chess.Board(m["fenBefore"]), m.get("bestLine") or [m["bestSan"]],
                                  exchange_start(moves, i))
            if theme:
                m["missed"] = {"theme": theme, "label": describe(theme)}
    return record


GOALS = {
    "back_rank": "Find the back-rank mate", "mate": "Find the checkmate", "fork": "Find the fork",
    "pin": "Find the pin", "skewer": "Find the skewer", "discovered": "Find the discovered attack",
    "trapped": "Trap the piece", "free_piece": "Win material", "promotion": "Promote the pawn",
    "stop_mate": "Stop the mate threat", "save_piece": "Save your piece", "win_material": "Win material with the right exchanges",
}


def _material(board: chess.Board, color: chess.Color) -> int:
    return sum(VALUES[p.piece_type] * (1 if p.color == color else -1) for p in board.piece_map().values())


def _mate_in_one(board: chess.Board) -> bool:
    for m in board.legal_moves:
        board.push(m)
        mate = board.is_checkmate()
        board.pop()
        if mate:
            return True
    return False


def quiet_solution(board: chess.Board, sans: list[str]) -> tuple[str, list[str]] | None:
    """Teachable puzzles that aren't attacking tactics (when puzzle_solution finds nothing):

    * stop_mate    – the opponent threatens mate; the best move stops it (1 move).
    * save_piece   – one of your pieces is attacked and would be lost; the best move saves it (1 move).
    * win_material – the engine line wins material through exchanges; play it until the gain is safe.
    Anything else (quiet positional moves) has no single clear point and is left out.
    """
    try:
        best = board.parse_san(sans[0])
    except (ValueError, IndexError):
        return None
    me = board.turn
    after = board.copy(stack=False)
    after.push(best)
    if not board.is_check():
        nb = board.copy(stack=False)
        nb.push(chess.Move.null())
        if _mate_in_one(nb) and not _mate_in_one(after):
            return "stop_mate", [best.uci()]
        threatened = C._en_prise(nb, me)
        if threatened:
            worst = max(threatened.values())
            if worst >= 2 and max(C._en_prise(after, me).values(), default=0) < worst:
                return "save_piece", [best.uci()]
    # Winning material: your move, then their reply, and you're still 2+ points up on where you started.
    start = _material(board, me)
    b = board.copy(stack=False)
    ucis = []
    for i, san in enumerate(sans[:6]):
        try:
            mv = b.parse_san(san)
        except ValueError:
            return None
        b.push(mv)
        ucis.append(mv.uci())
        if b.is_checkmate():
            return None  # a mate would have been found by puzzle_solution
        if i % 2 == 1 and _material(b, me) - start >= 2:
            return "win_material", ucis[:-1]  # end on your move; their reply only confirms the gain
    return None


def max_mate_for_rating(rating: float | None) -> int:
    """Longest forced mate (in moves) that's a fair puzzle at this rating."""
    if not rating:
        return 3
    # Lichess-scale thresholds (Chess.com ratings are shifted up before this).
    if rating < 1200:
        return 2
    if rating < 1600:
        return 3
    if rating < 2000:
        return 4
    return 5


def puzzle_solution(board: chess.Board, sans: list[str], max_mate: int = 3) -> tuple[str, list[str]] | None:
    """(theme, solution UCIs incl. opponent replies) if this line has a clear, teachable point.

    Mates are played out to the very end (up to mate-in-`max_mate`); other themes stop
    right after the move that delivers the tactic (1 move, or 3 plies for "check, then fork").
    """
    b = board.copy(stack=False)
    ucis: list[str] = []
    theme_at: dict[str, int] = {}
    for i, san in enumerate(sans[:2 * max_mate - 1]):
        try:
            move = b.parse_san(san)
        except ValueError:
            break
        if i % 2 == 0 and i <= 2:
            for t in themes_of_move(b, move):
                theme_at.setdefault(t, i)
        ucis.append(move.uci())
        b.push(move)
        if b.is_checkmate():
            # Back-rank only if the mating move itself is the back-rank blow.
            last = chess.Move.from_uci(ucis[-1])
            king = b.king(b.turn)
            back = 0 if b.turn == chess.WHITE else 7
            is_back = (king is not None and chess.square_rank(king) == back
                       and chess.square_rank(last.to_square) == back
                       and b.piece_type_at(last.to_square) in (chess.ROOK, chess.QUEEN))
            return ("back_rank" if is_back else "mate"), ucis
    for t in THEMES:
        if t in theme_at and t not in ("mate", "back_rank"):
            return t, ucis[:theme_at[t] + 1]
    return None
