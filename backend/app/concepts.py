"""Positional concepts: what a position *is*, in the terms chess books use.

`measure(board)` scores ~40 concepts for both sides – pawn structure, piece quality, king safety,
centre and space, development, endgame technique – each with the squares involved, so a lesson can
point at them. `compare(before, after, pov)` says which concepts a move made better or worse for one
side, weighted by the phase of the game. That is the raw material for the positional coach: the
engine says *that* a move was worse, the concepts say *which principle* it went against.

Every concept is computed from the position alone (no engine, no move history), in well under a
millisecond, so whole games and the whole library can be scored cheaply.

Conventions
-----------
* A concept's value is a magnitude per side (a count, or a score), always >= 0.
* `polarity` +1 = an asset for the side that has it (a knight outpost), -1 = a liability (an isolated
  pawn). The *balance* for one side = polarity x (own value - opponent's value).
* Ranks and directions are relative to the side: "rank 7" is the 2nd rank for Black.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import chess

WHITE, BLACK = chess.WHITE, chess.BLACK
VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
CENTER = (chess.D4, chess.E4, chess.D5, chess.E5)
CENTER_FILES = (2, 3, 4, 5)  # c-f

OPENING, MIDDLEGAME, ENDGAME = "opening", "middlegame", "endgame"


@dataclass(frozen=True)
class Concept:
    id: str
    title: str
    family: str
    polarity: int                       # +1 asset, -1 liability
    weight: tuple[float, float, float]  # importance in opening, middlegame, endgame (0 = not judged)


CONCEPTS: dict[str, Concept] = {c.id: c for c in [
    # pawn structure
    Concept("isolated_pawn", "Isolated pawn", "pawns", -1, (0.3, 0.8, 1.0)),
    Concept("doubled_pawn", "Doubled pawns", "pawns", -1, (0.3, 0.6, 0.9)),
    Concept("backward_pawn", "Backward pawn", "pawns", -1, (0.3, 0.8, 0.8)),
    Concept("pawn_islands", "Pawn islands", "pawns", -1, (0.1, 0.4, 0.8)),
    Concept("hanging_pawns", "Hanging pawns", "pawns", -1, (0.1, 0.4, 0.7)),
    Concept("passed_pawn", "Passed pawn", "pawns", 1, (0.3, 0.8, 1.5)),
    Concept("protected_passer", "Protected passed pawn", "pawns", 1, (0.2, 0.6, 1.2)),
    Concept("connected_passers", "Connected passed pawns", "pawns", 1, (0.2, 0.7, 1.4)),
    Concept("blockade", "Blockading a passed pawn", "pawns", 1, (0.1, 0.6, 0.9)),
    Concept("holes", "Weak squares (holes)", "pawns", -1, (0.3, 0.7, 0.4)),
    Concept("center_pawns", "Pawns in the centre", "centre", 1, (0.8, 0.6, 0.2)),
    # pieces
    Concept("knight_outpost", "Knight on an outpost", "pieces", 1, (0.5, 1.0, 0.7)),
    Concept("bishop_outpost", "Bishop on an outpost", "pieces", 1, (0.3, 0.5, 0.3)),
    Concept("outpost_squares", "Outpost squares for your knights", "pieces", 1, (0.2, 0.5, 0.3)),
    Concept("bad_bishop", "Bad bishop", "pieces", -1, (0.2, 0.8, 1.0)),
    Concept("bishop_pair", "Bishop pair", "pieces", 1, (0.3, 0.6, 0.8)),
    Concept("minor_piece_fit", "The right minor piece for the structure", "pieces", 1, (0.1, 0.5, 0.8)),
    Concept("rook_open_file", "Rook on an open file", "pieces", 1, (0.3, 1.0, 0.7)),
    Concept("rook_half_open_file", "Rook on a half-open file", "pieces", 1, (0.2, 0.6, 0.4)),
    Concept("rook_seventh", "Rook on the 7th rank", "pieces", 1, (0.1, 0.9, 1.0)),
    Concept("doubled_rooks", "Doubled rooks", "pieces", 1, (0.1, 0.6, 0.4)),
    Concept("rook_behind_passer", "Rook behind a passed pawn", "pieces", 1, (0.0, 0.4, 1.2)),
    Concept("knight_rim", "Knight on the rim", "pieces", -1, (0.6, 0.6, 0.4)),
    Concept("passive_piece", "Passive piece", "pieces", -1, (0.3, 0.8, 0.8)),
    Concept("mobility", "Piece activity", "pieces", 1, (0.3, 0.7, 0.7)),
    # development and the king
    Concept("undeveloped", "Undeveloped pieces", "development", -1, (1.0, 0.6, 0.0)),
    Concept("king_center", "King stuck in the centre", "king", -1, (1.0, 0.9, 0.0)),
    Concept("lost_castling", "King moved without castling", "king", -1, (0.8, 0.5, 0.0)),
    Concept("king_shield", "Weakened pawn shield", "king", -1, (0.6, 1.0, 0.0)),
    Concept("king_open_lines", "Open lines towards the king", "king", -1, (0.5, 1.0, 0.1)),
    Concept("king_attackers", "Pieces aiming at the king", "king", -1, (0.5, 1.0, 0.1)),
    Concept("back_rank", "Weak back rank", "king", -1, (0.1, 0.7, 0.5)),
    # centre and space
    Concept("center_control", "Control of the centre", "centre", 1, (1.0, 0.6, 0.2)),
    Concept("space", "Space", "centre", 1, (0.4, 0.7, 0.0)),
    # endgame
    Concept("king_activity", "Active king", "endgame", 1, (0.0, 0.0, 1.2)),
    Concept("opposition", "The opposition", "endgame", 1, (0.0, 0.0, 1.5)),
    Concept("unstoppable_passer", "Passed pawn the king can't catch", "endgame", 1, (0.0, 0.0, 2.0)),
    # material (context for the strategy rules, not a lesson on its own)
    Concept("material", "Material", "material", 1, (0.0, 0.0, 0.0)),
]}


@dataclass
class Feature:
    """One concept in one position: a value per side and the squares that show it."""
    value: dict[bool, float] = field(default_factory=lambda: {WHITE: 0.0, BLACK: 0.0})
    squares: dict[bool, list[int]] = field(default_factory=lambda: {WHITE: [], BLACK: []})

    def add(self, color: bool, amount: float = 1.0, *squares: int) -> None:
        self.value[color] += amount
        self.squares[color].extend(squares)


@dataclass
class Profile:
    phase: str
    features: dict[str, Feature]

    def balance(self, concept: str, pov: bool) -> float:
        """How the concept stands for `pov`: positive = good for them."""
        f = self.features[concept]
        return CONCEPTS[concept].polarity * (f.value[pov] - f.value[not pov])


@dataclass
class Change:
    concept: str
    delta: float      # change in balance for the side that moved (negative = got worse)
    weighted: float   # delta x the concept's weight in this phase
    squares: list[int]


# --------------------------------------------------------------------------- #
#  Helpers
# --------------------------------------------------------------------------- #

def rel_rank(sq: int, color: bool) -> int:
    """Rank 0..7 counted from the side's own back rank."""
    r = chess.square_rank(sq)
    return r if color == WHITE else 7 - r


def _forward(color: bool) -> int:
    return 1 if color == WHITE else -1


def _pawns(board: chess.Board, color: bool) -> list[int]:
    return list(board.pieces(chess.PAWN, color))


def _pawn_files(pawns: list[int]) -> dict[int, list[int]]:
    files: dict[int, list[int]] = {}
    for sq in pawns:
        files.setdefault(chess.square_file(sq), []).append(sq)
    return files


def _ahead(sq: int, color: bool, other: int) -> bool:
    """Is `other` further up the board than `sq`, seen from `color`?"""
    return rel_rank(other, color) > rel_rank(sq, color)


def is_passed(board: chess.Board, sq: int, color: bool) -> bool:
    f = chess.square_file(sq)
    for e in board.pieces(chess.PAWN, not color):
        if abs(chess.square_file(e) - f) <= 1 and _ahead(sq, color, e):
            return False
    return True


def pawn_attackable(board: chess.Board, sq: int, by: bool) -> bool:
    """Could a pawn of `by` ever attack `sq` (now or after advancing)?"""
    f = chess.square_file(sq)
    for p in board.pieces(chess.PAWN, by):
        if abs(chess.square_file(p) - f) == 1 and rel_rank(p, by) < rel_rank(sq, by):
            return True
    return False


def _pawn_attacked_now(board: chess.Board, sq: int, by: bool) -> bool:
    return any(board.piece_type_at(a) == chess.PAWN for a in board.attackers(by, sq))


def _safe_mobility(board: chess.Board, sq: int) -> int:
    """Squares a piece attacks that are not own-occupied and not covered by an enemy pawn."""
    color = board.color_at(sq)
    n = 0
    for t in board.attacks(sq):
        if board.color_at(t) == color:
            continue
        if _pawn_attacked_now(board, t, not color):
            continue
        n += 1
    return n


def material(board: chess.Board, color: bool) -> int:
    return sum(VALUE[p.piece_type] for p in board.piece_map().values() if p.color == color)


def non_pawn_material(board: chess.Board, color: bool) -> int:
    return sum(VALUE[p.piece_type] for p in board.piece_map().values()
               if p.color == color and p.piece_type not in (chess.PAWN, chess.KING))


def phase_of(board: chess.Board) -> str:
    npm = non_pawn_material(board, WHITE) + non_pawn_material(board, BLACK)  # 62 at the start
    queens = bool(board.pieces(chess.QUEEN, WHITE) or board.pieces(chess.QUEEN, BLACK))
    if npm <= 26 or (not queens and npm <= 34):
        return ENDGAME
    if board.fullmove_number <= 12 and npm >= 50:
        return OPENING
    return MIDDLEGAME


# --------------------------------------------------------------------------- #
#  Detectors (each fills its features for both sides)
# --------------------------------------------------------------------------- #

def _pawn_structure(board: chess.Board, fs: dict[str, Feature]) -> dict[bool, list[int]]:
    passers: dict[bool, list[int]] = {WHITE: [], BLACK: []}
    for color in (WHITE, BLACK):
        pawns = _pawns(board, color)
        files = _pawn_files(pawns)
        fwd = _forward(color)
        for f, sqs in files.items():
            if len(sqs) > 1:
                fs["doubled_pawn"].add(color, len(sqs) - 1, *sqs)
            if (f - 1) not in files and (f + 1) not in files:
                fs["isolated_pawn"].add(color, len(sqs), *sqs)
        # islands: groups of adjacent files with pawns
        islands = 0
        prev = -2
        for f in sorted(files):
            if f != prev + 1:
                islands += 1
            prev = f
        if islands > 1:
            fs["pawn_islands"].add(color, islands - 1)
        for sq in pawns:
            f, r = chess.square_file(sq), rel_rank(sq, color)
            # backward: no own pawn on an adjacent file level or behind, and the stop square is hit by an enemy pawn
            support = any(abs(chess.square_file(o) - f) == 1 and rel_rank(o, color) <= r for o in pawns)
            stop = sq + 8 * fwd
            if (not support and 0 <= stop < 64 and (f - 1 in files or f + 1 in files)
                    and _pawn_attacked_now(board, stop, not color) and not is_passed(board, sq, color)):
                fs["backward_pawn"].add(color, 1, sq)
            if is_passed(board, sq, color):
                passers[color].append(sq)
                fs["passed_pawn"].add(color, 1 + max(0, r - 3) * 0.5, sq)  # further advanced = worth more
                if _pawn_attacked_now(board, sq, color):  # defended by own pawn
                    fs["protected_passer"].add(color, 1, sq)
                ahead = sq + 8 * fwd
                if 0 <= ahead < 64:
                    blocker = board.piece_at(ahead)
                    if blocker and blocker.color != color:
                        fs["blockade"].add(not color, 1.5 if blocker.piece_type == chess.KNIGHT else 1, ahead)
        # connected passers: passers on adjacent files
        pfiles = sorted({chess.square_file(p) for p in passers[color]})
        pairs = sum(1 for a, b in zip(pfiles, pfiles[1:]) if b == a + 1)
        if pairs:
            fs["connected_passers"].add(color, pairs, *passers[color])
        # hanging pawns: two pawns on adjacent files, side by side, with no own pawns on the neighbouring files
        for f in range(7):
            a, b = files.get(f, []), files.get(f + 1, [])
            if (len(a) == 1 and len(b) == 1 and (f - 1) not in files and (f + 2) not in files
                    and rel_rank(a[0], color) == rel_rank(b[0], color) >= 3 and f + 1 in CENTER_FILES):
                fs["hanging_pawns"].add(color, 1, a[0], b[0])
        # holes: squares in your own half (ranks 3-4, files c-f or near your king) no own pawn can ever cover
        king = board.king(color)
        for sq in chess.SQUARES:
            r = rel_rank(sq, color)
            if r not in (2, 3):
                continue
            f = chess.square_file(sq)
            near_king = king is not None and chess.square_distance(sq, king) <= 2
            if f not in CENTER_FILES and not near_king:
                continue
            if board.piece_type_at(sq) == chess.PAWN:
                continue
            if not pawn_attackable(board, sq, color):
                fs["holes"].add(color, 1.5 if near_king else 1, sq)
        # centre pawns: on d/e files, ranks 4-5
        for sq in pawns:
            if chess.square_file(sq) in (3, 4) and rel_rank(sq, color) in (3, 4):
                fs["center_pawns"].add(color, 1, sq)
    return passers


def _pieces(board: chess.Board, fs: dict[str, Feature], passers: dict[bool, list[int]]) -> None:
    all_pawns = {c: _pawn_files(_pawns(board, c)) for c in (WHITE, BLACK)}
    for color in (WHITE, BLACK):
        own_files, opp_files = all_pawns[color], all_pawns[not color]
        knights = board.pieces(chess.KNIGHT, color)
        bishops = board.pieces(chess.BISHOP, color)
        rooks = board.pieces(chess.ROOK, color)
        # outposts: enemy half (ranks 4-6), supported by an own pawn, no enemy pawn can ever chase it away
        for sq in chess.SQUARES:
            if rel_rank(sq, color) not in (3, 4, 5) or chess.square_file(sq) in (0, 7):
                continue
            if pawn_attackable(board, sq, not color) or not _pawn_attacked_now(board, sq, color):
                continue
            piece = board.piece_at(sq)
            if piece and piece.color == color and piece.piece_type == chess.KNIGHT:
                fs["knight_outpost"].add(color, 1.5 if chess.square_file(sq) in CENTER_FILES else 1, sq)
            elif piece and piece.color == color and piece.piece_type == chess.BISHOP:
                fs["bishop_outpost"].add(color, 1, sq)
            elif piece is None and chess.square_file(sq) in CENTER_FILES and knights:
                fs["outpost_squares"].add(color, 1, sq)
        # bishops: the pair, and bad bishops (own pawns fixed on its colour)
        if len(bishops) >= 2 and len({(chess.square_file(b) + chess.square_rank(b)) % 2 for b in bishops}) == 2:
            fs["bishop_pair"].add(color, 1, *bishops)
        own_pawns = _pawns(board, color)
        for b in bishops:
            shade = (chess.square_file(b) + chess.square_rank(b)) % 2
            same = [p for p in own_pawns if (chess.square_file(p) + chess.square_rank(p)) % 2 == shade]
            fixed = [p for p in same if 0 <= p + 8 * _forward(color) < 64
                     and board.piece_type_at(p + 8 * _forward(color)) == chess.PAWN]
            central_fixed = [p for p in fixed if chess.square_file(p) in CENTER_FILES]
            if len(same) >= 3 and (len(central_fixed) >= 2 or (len(fixed) >= 2 and _safe_mobility(board, b) <= 3)):
                fs["bad_bishop"].add(color, 1, b, *central_fixed)
        # minor piece fit: bishops like open centres, knights closed ones
        nb, nn = len(bishops), len(knights)
        ob, on = len(board.pieces(chess.BISHOP, not color)), len(board.pieces(chess.KNIGHT, not color))
        center_pawns = sum(len(all_pawns[c].get(f, [])) for c in (WHITE, BLACK) for f in (3, 4))
        blocked_center = sum(1 for c in (WHITE, BLACK) for f in (3, 4) for p in all_pawns[c].get(f, [])
                             if 0 <= p + 8 * _forward(c) < 64 and board.piece_type_at(p + 8 * _forward(c)) == chess.PAWN)
        if nb > ob and on > nn and center_pawns <= 2:
            fs["minor_piece_fit"].add(color, 1, *bishops)       # bishop vs knight, open centre
        if nn > on and ob > nb and blocked_center >= 2:
            fs["minor_piece_fit"].add(color, 1, *knights)       # knight vs bishop, locked centre
        # rooks: files, the 7th rank, doubling, behind passers
        files_with_rooks: dict[int, int] = {}
        for r in rooks:
            f = chess.square_file(r)
            files_with_rooks[f] = files_with_rooks.get(f, 0) + 1
            if f not in own_files and f not in opp_files:
                fs["rook_open_file"].add(color, 1, r)
            elif f not in own_files:
                fs["rook_half_open_file"].add(color, 1, r)
            if rel_rank(r, color) == 6:
                enemy_on_7 = any(rel_rank(p, color) == 6 for p in board.pieces(chess.PAWN, not color))
                enemy_king = board.king(not color)
                if enemy_on_7 or (enemy_king is not None and rel_rank(enemy_king, color) == 7):
                    fs["rook_seventh"].add(color, 1, r)
            for p in passers[WHITE] + passers[BLACK]:
                if chess.square_file(p) != f:
                    continue
                pc = board.color_at(p)
                behind = rel_rank(r, pc) < rel_rank(p, pc)
                between = chess.SquareSet(chess.between(r, p))
                if behind and not (between & board.occupied):
                    fs["rook_behind_passer"].add(color, 1, r, p)
        for f, n in files_with_rooks.items():
            if n >= 2 and f not in own_files:
                fs["doubled_rooks"].add(color, 1, *[r for r in rooks if chess.square_file(r) == f])
        # knights on the rim, passive pieces, overall activity
        for n in knights:
            if chess.square_file(n) in (0, 7):
                fs["knight_rim"].add(color, 1, n)
        home = {WHITE: {chess.B1, chess.G1, chess.C1, chess.F1}, BLACK: {chess.B8, chess.G8, chess.C8, chess.F8}}[color]
        for sq, piece in board.piece_map().items():
            if piece.color != color or piece.piece_type in (chess.PAWN, chess.KING):
                continue
            mob = _safe_mobility(board, sq)
            fs["mobility"].add(color, mob / 10)  # 10 safe squares ~ one unit, like the counted concepts
            if piece.piece_type != chess.QUEEN and mob <= 1 and sq not in home:
                fs["passive_piece"].add(color, 1, sq)


def _development_and_king(board: chess.Board, fs: dict[str, Feature], phase: str) -> None:
    moved_on = board.fullmove_number >= 8
    queens_on = bool(board.pieces(chess.QUEEN, WHITE) or board.pieces(chess.QUEEN, BLACK))
    for color in (WHITE, BLACK):
        back = 0 if color == WHITE else 7
        home = [chess.square(f, back) for f in (1, 2, 5, 6)]
        if moved_on and phase != ENDGAME:
            for sq in home:
                p = board.piece_at(sq)
                if p and p.color == color and p.piece_type in (chess.KNIGHT, chess.BISHOP):
                    fs["undeveloped"].add(color, 1, sq)
        king = board.king(color)
        if king is None:
            continue
        kf, kr = chess.square_file(king), rel_rank(king, color)
        enemy_heavy = bool(board.pieces(chess.QUEEN, not color) or board.pieces(chess.ROOK, not color))
        own_files = _pawn_files(_pawns(board, color))
        opp_files = _pawn_files(_pawns(board, not color))
        # king in the centre after the opening, queens still on
        if phase != ENDGAME and queens_on and board.fullmove_number >= 10 and kf in (3, 4) and kr <= 1:
            open_center = sum(1 for f in (3, 4) if f not in own_files)
            fs["king_center"].add(color, 1 + open_center, king)
        # moved the king without castling (lost the right, not on a castled square)
        if phase != ENDGAME and kr <= 1 and kf not in (1, 2, 6) and king != chess.square(4, back) \
                and not board.has_castling_rights(color):
            fs["lost_castling"].add(color, 1, king)
        # pawn shield of a castled king
        if phase != ENDGAME and kr == 0 and kf in (0, 1, 2, 5, 6, 7):
            shield_files = (5, 6, 7) if kf >= 5 else (0, 1, 2)
            missing = 0.0
            marks = []
            for f in shield_files:
                ps = [p for p in own_files.get(f, []) if rel_rank(p, color) in (1, 2)]
                if not ps:
                    missing += 1
                    marks.append(chess.square(f, 1 if color == WHITE else 6))
                elif all(rel_rank(p, color) == 2 for p in ps) and f == kf:
                    missing += 0.5  # pawn pushed one square right in front of the king
                    marks.extend(ps)
            if missing:
                fs["king_shield"].add(color, missing, *marks)
        # open or half-open files at the king with an enemy rook or queen on them
        if phase != ENDGAME:
            for f in (kf - 1, kf, kf + 1):
                if not 0 <= f <= 7 or f in own_files:
                    continue
                heavy = [sq for sq in chess.SQUARES if chess.square_file(sq) == f and board.piece_at(sq)
                         and board.color_at(sq) != color and board.piece_type_at(sq) in (chess.ROOK, chess.QUEEN)]
                if heavy or f not in opp_files:
                    fs["king_open_lines"].add(color, 1.5 if heavy else 0.5, *heavy)
        # enemy pieces attacking the king zone (king + neighbours + three in front)
        if queens_on:
            zone = chess.SquareSet(chess.BB_KING_ATTACKS[king]) | chess.BB_SQUARES[king]
            fwd = _forward(color)
            for df in (-1, 0, 1):
                f2, r2 = kf + df, chess.square_rank(king) + 2 * fwd
                if 0 <= f2 <= 7 and 0 <= r2 <= 7:
                    zone.add(chess.square(f2, r2))
            attackers = set()
            for sq in zone:
                for a in board.attackers(not color, sq):
                    if board.piece_type_at(a) not in (chess.PAWN, chess.KING):
                        attackers.add(a)
            if attackers:
                fs["king_attackers"].add(color, len(attackers), *attackers)
        # weak back rank: king on it, no luft, enemy heavy pieces about
        if kr == 0 and enemy_heavy:
            # only squares off the back rank count: sliding along it doesn't escape a back-rank check
            front = [chess.square(f, chess.square_rank(king) + _forward(color)) for f in (kf - 1, kf, kf + 1) if 0 <= f <= 7]
            escape = [s for s in front if board.color_at(s) != color and not board.attackers(not color, s)]
            if not escape:
                fs["back_rank"].add(color, 1, king)


def _centre_and_space(board: chess.Board, fs: dict[str, Feature], phase: str) -> None:
    for color in (WHITE, BLACK):
        for sq in CENTER:
            n = len(board.attackers(color, sq))
            p = board.piece_at(sq)
            if p and p.color == color:
                n += 2 if p.piece_type == chess.PAWN else 1
            if n:
                fs["center_control"].add(color, n / 3, sq)  # ~3 units of control per square = one unit
        if phase == ENDGAME:
            continue
        # Stockfish-style space: safe squares on files c-f, own ranks 2-4, counted double behind own pawns
        own = _pawns(board, color)
        for sq in chess.SQUARES:
            f, r = chess.square_file(sq), rel_rank(sq, color)
            if f not in CENTER_FILES or r not in (1, 2, 3):
                continue
            if board.piece_type_at(sq) == chess.PAWN and board.color_at(sq) == color:
                continue
            if _pawn_attacked_now(board, sq, not color):
                continue
            behind = any(chess.square_file(p) == f and 0 < rel_rank(p, color) - r <= 3 for p in own)
            fs["space"].add(color, 0.4 if behind else 0.2)  # five safe squares = one unit


def _endgame(board: chess.Board, fs: dict[str, Feature], phase: str, passers: dict[bool, list[int]]) -> None:
    if phase != ENDGAME:
        return
    for color in (WHITE, BLACK):
        k = board.king(color)
        if k is None:
            continue
        centre_dist = max(abs(chess.square_file(k) * 2 - 7), abs(chess.square_rank(k) * 2 - 7)) // 2  # 0..3
        fs["king_activity"].add(color, 3 - centre_dist, k)
    pawn_ending = all(p.piece_type in (chess.PAWN, chess.KING) for p in board.piece_map().values())
    wk, bk = board.king(WHITE), board.king(BLACK)
    if pawn_ending and wk is not None and bk is not None:
        df = abs(chess.square_file(wk) - chess.square_file(bk))
        dr = abs(chess.square_rank(wk) - chess.square_rank(bk))
        if (df, dr) in ((0, 2), (2, 0), (2, 2)):
            between = chess.SquareSet(chess.between(wk, bk)) if (df == 0 or dr == 0 or df == dr) else chess.SquareSet()
            if not (between & board.occupied):
                has = not board.turn  # the side NOT to move has the opposition
                fs["opposition"].add(has, 1, wk, bk)
    if pawn_ending:
        for color in (WHITE, BLACK):
            ek = board.king(not color)
            if ek is None:
                continue
            for p in passers[color]:
                promo = chess.square(chess.square_file(p), 7 if color == WHITE else 0)
                steps = 7 - rel_rank(p, color)
                if rel_rank(p, color) == 1:
                    steps -= 1  # double step from the start square
                king_steps = chess.square_distance(ek, promo) - (1 if board.turn != color else 0)
                path = chess.SquareSet(chess.between(p, promo)) | chess.BB_SQUARES[promo]
                if king_steps > steps and not (path & board.occupied):
                    fs["unstoppable_passer"].add(color, 1, p)


def measure(board: chess.Board) -> Profile:
    """Score every concept for both sides."""
    fs = {cid: Feature() for cid in CONCEPTS}
    phase = phase_of(board)
    passers = _pawn_structure(board, fs)
    _pieces(board, fs, passers)
    _development_and_king(board, fs, phase)
    _centre_and_space(board, fs, phase)
    _endgame(board, fs, phase, passers)
    for color in (WHITE, BLACK):
        fs["material"].add(color, material(board, color))
    return Profile(phase, fs)


def compare(before: Profile, after: Profile, pov: bool, phase: str | None = None) -> list[Change]:
    """Which concepts got better or worse for `pov` from one position to the other, biggest first.

    Typical use: `before` = the position after the engine's best move, `after` = after the move
    played – the most negative changes are what the played move gave away.
    """
    ph = phase or before.phase
    idx = {OPENING: 0, MIDDLEGAME: 1, ENDGAME: 2}[ph]
    out = []
    for cid, concept in CONCEPTS.items():
        w = concept.weight[idx]
        if not w:
            continue
        delta = after.balance(cid, pov) - before.balance(cid, pov)
        if delta:
            fa, fb = after.features[cid], before.features[cid]
            squares = sorted(set(fa.squares[WHITE] + fa.squares[BLACK]) ^ set(fb.squares[WHITE] + fb.squares[BLACK]))
            out.append(Change(cid, delta, delta * w, squares))
    out.sort(key=lambda c: c.weighted)
    return out
