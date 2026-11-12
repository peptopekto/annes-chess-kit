"""Plain-language move explanations for reviews: what a move does, and why a bad one was bad.

Built from the stored engine lines plus simple board facts (what's attacked, defended,
hanging, threatened), so it works for every review without re-running the engine.
"""
from __future__ import annotations

import re

import chess

from . import classify as C
from . import tactics
from .voice import Voice, render, voice_for

VAL = C.PIECE_VALUES
NAME = C.PIECE_NAMES


def _piece(board: chess.Board, sq: chess.Square) -> str:
    return NAME[board.piece_type_at(sq)]


def _material(board: chess.Board, color: chess.Color) -> int:
    return sum(VAL[p.piece_type] for p in board.piece_map().values() if p.color == color)


def _balance(board: chess.Board, me: chess.Color) -> int:
    return _material(board, me) - _material(board, not me)


def _line_balance(board: chess.Board, sans: list[str], plies: int = 6) -> int | None:
    """Material balance (for the side to move at `board`) after playing out a line, settling captures."""
    me = board.turn
    b = board.copy(stack=False)
    played = 0
    for san in sans:
        try:
            m = b.parse_san(san)
        except ValueError:
            break
        capture = b.is_capture(m)
        b.push(m)
        played += 1
        if b.is_checkmate():
            return 100 if b.turn != me else -100
        if played >= plies and not capture:
            break
    return _balance(b, me) if played else None


def _pawns_dropped(m: dict) -> float | None:
    """How many pawns of evaluation the move gave away compared with the best move (None with a mate)."""
    best, now = m.get("bestEval") or {}, m.get("eval") or {}
    if "cp" not in best or "cp" not in now:
        return None
    sign = 1 if chess.Board(m["fenBefore"]).turn == chess.WHITE else -1
    return (best["cp"] - now["cp"]) * sign / 100


def _material_words(n: int) -> str:
    return {1: "a pawn", 2: "two pawns' worth of material", 3: "a piece", 4: "a piece and a pawn",
            5: "a rook's worth of material", 6: "a rook and a pawn"}.get(
        n, "about a queen's worth of material" if n >= 8 else f"{n} pawns' worth of material")


def _theme_clause(theme: str | None, board: chess.Board | None = None, move: chess.Move | None = None) -> str:
    """', which wins material' / ' – a fork' etc. (`board`, `move`: the move that does it, to name the victim)."""
    if not theme:
        return ""
    if theme == "trapped" and board is not None and move is not None:
        sq = tactics.trapped_square(board, move)
        if sq is not None:
            return f", which traps the {_piece(board, sq)} on {chess.square_name(sq)}: it has no safe square left"
    if theme == "free_piece":
        return ", which wins material"
    if theme == "promotion":
        return ", and a pawn promotes"
    if theme == "trapped":
        return ", which traps a piece: it has no safe square left"
    lbl = tactics.THEMES[theme].lower()
    return f" – {'an' if lbl[0] in 'aeiou' else 'a'} {lbl}"


def _hanging(board: chess.Board, owner: chess.Color) -> dict[chess.Square, int]:
    """Pieces of `owner` the side to move could win (cheap one-ply exchange estimate)."""
    if board.turn == owner:
        return {}
    return C._en_prise(board, owner)


def _mate_in_one(board: chess.Board) -> chess.Move | None:
    for m in board.legal_moves:
        board.push(m)
        mate = board.is_checkmate()
        board.pop()
        if mate:
            return m
    return None


def _null(board: chess.Board) -> chess.Board | None:
    """The same position with the other side to move (to ask 'what were they threatening?')."""
    if board.is_check():
        return None
    b = board.copy(stack=False)
    b.push(chess.Move.null())
    return b


def eval_label(ev: dict, me_white: bool) -> str:
    """Position assessment for the mover, in words."""
    if ev.get("mate") == 0:  # checkmate on the board – after a move, normally given by the mover
        won = (ev.get("winner", "w" if me_white else "b") == "w") == me_white
        return "won – checkmate" if won else "lost – checkmated"
    if ev.get("mate") is not None:
        mine = (ev["mate"] > 0) == me_white
        return "winning (forced mate)" if mine else "lost (mate is coming)"
    cp = ev.get("cp", 0) * (1 if me_white else -1)
    for limit, word in ((300, "winning"), (120, "clearly better"), (40, "slightly better"), (-40, "equal"),
                        (-120, "slightly worse"), (-300, "clearly worse")):
        if cp >= limit:
            return word
    return "losing"


# --------------------------------------------------------------------------- #
#  What a move does
# --------------------------------------------------------------------------- #

# An exchange under way: (material you're down since it began, the square of the opponent's last move,
# the piece it promoted to – if it did).
Prev = tuple[int, chess.Square, int | None]


def prev_capture(moves: list[dict], i: int) -> Prev | None:
    """If the opponent's move before `moves[i]` was a capture or a promotion: how much material the mover is down
    since the exchange began (it may have started with the mover's own capture), and where it happened.
    """
    if i <= 0 or not tactics.changes_material(moves[i - 1]):
        return None
    now = chess.Board(moves[i]["fenBefore"])
    deficit = _balance(tactics.exchange_start(moves, i), now.turn) - _balance(now, now.turn)
    last = chess.Move.from_uci(moves[i - 1]["uci"])
    return deficit, last.to_square, last.promotion


def _exchange(after: chess.Board, line: list[str], square: chess.Square) -> tuple[int, bool] | None:
    """Play the engine's continuation while it keeps capturing or checking (the exchange a capture starts;
    getting out of check doesn't end it – the checking side moves again, e.g. a fork that wins the piece back).

    Returns the balance for the side that just moved, and whether its capturing piece on `square` was taken.
    None without a line to play (or when it ends in mate – then material isn't the point).
    """
    me = not after.turn
    b = after.copy(stack=False)
    played, retaken = 0, False
    for san in line[:8]:
        try:
            mv = b.parse_san(san)
        except ValueError:
            break
        forcing = b.is_capture(mv) or b.gives_check(mv) or b.is_check()
        if b.turn != me and mv.to_square == square and b.is_capture(mv):
            retaken = True
        b.push(mv)
        played += 1
        if b.is_checkmate():
            return None
        if not forcing:
            break
    return (_balance(b, me), retaken) if played else None


def _capture(board: chess.Board, move: chess.Move, after: chess.Board, line: list[str] | None, prev: Prev | None) -> str:
    """'wins the bishop for free' / 'recaptures the bishop' / 'trades rooks' … – by what the exchange really does."""
    me = board.turn
    victim = chess.PAWN if board.is_en_passant(move) else board.piece_type_at(move.to_square)
    taker = board.piece_type_at(move.from_square)
    v = VAL[victim]
    got = _exchange(after, line, move.to_square) if line else None
    if got is not None:
        gain, retaken = got[0] - _balance(board, me), got[1]
    else:  # no engine line: a one-move look
        retaken = bool(after.attackers(not me, move.to_square))
        gain = v - VAL[taker] if retaken else v
    if prev is not None and prev[0] >= 1:
        # The opponent has just taken material (or promoted): judge the exchange as a whole, not this capture alone.
        deficit, square, promoted = prev
        total = gain - deficit
        if move.to_square == square:
            if promoted:
                return f"takes the new {NAME[victim]}"
            return f"wins the {NAME[victim]}" if total >= 2 else f"recaptures the {NAME[victim]}"
        if total >= 2:
            return f"wins the {NAME[victim]}"
        return f"wins the material back by taking the {NAME[victim]}" if total >= -1 else f"takes the {NAME[victim]}"
    if gain > v + 1:
        return f"takes the {NAME[victim]} and wins material in the exchange"
    if gain >= v and not retaken:
        return f"wins the {NAME[victim]} for free"
    if gain >= 2:
        return f"wins the {NAME[victim]}" + (f" for the {NAME[taker]}" if retaken and taker != victim else "")
    if retaken and abs(gain) <= 1:
        return f"trades {NAME[victim]}s" if victim == taker else f"trades the {NAME[taker]} for the {NAME[victim]}"
    return f"takes the {NAME[victim]}"


def describe(board: chess.Board, move: chess.Move, line: list[str] | None = None, prev: Prev | None = None) -> list[str]:
    """Up to three short phrases: 'castles to safety', 'attacks the queen', 'protects the knight on f3'…

    `line`: the engine's continuation after the move (SAN), to tell a won piece from a trade;
    `prev`: what the opponent's last move captured (prev_capture), so taking back counts as a trade.
    """
    me = board.turn
    after = board.copy(stack=False)
    after.push(move)
    if after.is_checkmate():
        return ["delivers checkmate"]
    out: list[str] = []
    moved = after.piece_type_at(move.to_square)

    if board.is_castling(move):
        out.append("castles the king to safety")
    elif board.is_capture(move):
        out.append(_capture(board, move, after, line, prev))
    if move.promotion:
        out.append(f"promotes to a {NAME[move.promotion]}")
    if after.is_check():
        out.append("gives check")

    # Stops a mate threat?
    nb = _null(board)
    if nb is not None:
        threat = _mate_in_one(nb)
        if threat is not None and _mate_in_one(after) is None:
            out.append(f"stops the mate threat {nb.san(threat)}")

    # Saves something that was hanging?
    before = _hanging(nb, me) if nb is not None else {}
    now = _hanging(after, me)
    if move.from_square in before and move.to_square not in now and not board.is_capture(move):
        out.append(f"gets the {NAME[moved]} out of danger")
    else:
        # (a square can be empty now: castling moves the rook off it)
        saved = [sq for sq in before if sq != move.from_square and sq not in now and after.color_at(sq) == me]
        if saved:
            sq = max(saved, key=lambda s: VAL[after.piece_type_at(s)])
            out.append(f"protects the {_piece(after, sq)} on {chess.square_name(sq)}")

    # New attacks on things worth attacking.
    targets = [t for t in after.attacks(move.to_square)
               if after.color_at(t) == (not me) and t not in board.attacks(move.from_square)
               and after.piece_type_at(t) != chess.KING and tactics._juicy(after, t, move.to_square)]
    if targets:
        names = sorted({NAME[after.piece_type_at(t)] for t in targets}, key=lambda n: -VAL[chess.PIECE_NAMES.index(n)])
        if len(names) >= 2:
            out.append(f"attacks the {names[0]} and the {names[1]} at once")
        elif len(targets) >= 2:
            out.append(f"attacks both {names[0]}s")
        else:
            out.append(f"attacks the {names[0]}")

    # Development / pawn play.
    if not out and board.fullmove_number <= 12 and moved in (chess.KNIGHT, chess.BISHOP) \
            and chess.square_rank(move.from_square) in (0, 7):
        out.append(f"develops the {NAME[moved]}")
    if not out and moved == chess.PAWN and _is_passed(after, move.to_square, me):
        out.append("pushes the passed pawn")
    if not out and moved == chess.PAWN and chess.square_file(move.to_square) in (3, 4) and board.fullmove_number <= 10             and (chess.square_rank(move.to_square) >= 3 if me == chess.WHITE else chess.square_rank(move.to_square) <= 4):
        out.append("grabs space in the centre")  # d4/e4 (d5/e5 for Black) – not a modest d3 or e6
    return out[:3]


def _is_passed(board: chess.Board, sq: chess.Square, color: chess.Color) -> bool:
    f, r = chess.square_file(sq), chess.square_rank(sq)
    ahead = range(r + 1, 8) if color == chess.WHITE else range(0, r)
    for ff in (f - 1, f, f + 1):
        if 0 <= ff < 8:
            for rr in ahead:
                p = board.piece_at(chess.square(ff, rr))
                if p and p.piece_type == chess.PAWN and p.color != color:
                    return False
    return True


def _join(phrases: list[str]) -> str:
    if len(phrases) <= 1:
        return "".join(phrases)
    return ", ".join(phrases[:-1]) + " and " + phrases[-1]


# --------------------------------------------------------------------------- #
#  Per-move coaching for a review
# --------------------------------------------------------------------------- #

BAD = {C.INACCURACY, C.MISTAKE, C.MISS, C.BLUNDER}
GOODISH = {C.BRILLIANT, C.GREAT, C.BEST, C.EXCELLENT}


def coach_move(moves: list[dict], i: int, end: dict | None = None, me: str | None = None) -> dict | None:
    """Why the move was good or bad, worded for whoever played it (`me`: your side, if known)."""
    m = moves[i]
    before = chess.Board(m["fenBefore"])
    me_white = before.turn == chess.WHITE
    v: Voice = voice_for(before.turn, me)
    move = chess.Move.from_uci(m["uci"])
    best = chess.Move.from_uci(m["bestUci"])
    prev_eval = moves[i - 1]["eval"] if i > 0 else None
    prev = prev_capture(moves, i)
    # The engine's continuation after the move played (the next move's best line) and after the best move.
    nxt_line = (moves[i + 1].get("bestLine") or None) if i + 1 < len(moves) else None
    best_line = (m.get("bestLine") or [])[1:] or None
    assess = {"before": eval_label(m.get("bestEval") or prev_eval or {"cp": 0}, me_white),
              "after": eval_label(m["eval"], me_white)}

    if m["cls"] in GOODISH or m["cls"] == C.GOOD:
        does = describe(before, move, nxt_line, prev)
        text = f"{m['san']} {_join(does)}." if does else ""
        if m["cls"] == C.GOOD and m["uci"] != m["bestUci"]:
            bd = describe(before, best, best_line, prev)
            text += f" {m['bestSan']} was a bit more precise" + (f" – it {_join(bd)}." if bd else ".")
        return {**assess, "why": text.strip(), "better": None} if text.strip() else None

    if m["cls"] not in BAD:
        return None

    after = chess.Board(m["fen"])
    nxt = moves[i + 1] if i + 1 < len(moves) else None
    why: list[str] = []
    if after.is_stalemate():
        why_text = (f"It's stalemate: {v.other.subj} {v.other.has} no legal move and isn't in check, so the game "
                    "is a draw instead of a win.")
        if v.mine is not False:
            why_text += " When you're far ahead, always check that the other side still has a move."
        return {**assess, "why": why_text, "better": f"Better was {m['bestSan']} – it keeps the win."}
    if end and end.get("reason") in ("threefold", "fivefold") and i == len(moves) - 1:
        why_text = (f"It repeats the position for the third time – the game is drawn although {v.mover.subj} "
                    f"{v.mover.was} {assess['before']}.")
        if v.mine is not False:
            why_text += " Look for a different move before repeating."
        return {**assess, "why": why_text,
                "better": f"Better was {m['bestSan']} – it avoids the repetition and keeps playing for the win."}

    # 1) The immediate problem: what does the opponent get?
    if nxt:
        ref_line = nxt.get("bestLine") or [nxt["bestSan"]]
        ref = chess.Move.from_uci(nxt["bestUci"])
        ref_mate = nxt["bestEval"].get("mate")
        theme = tactics.theme_of_line(after, ref_line, before)
        nb = _null(before)
        ignored = False
        if nb is not None and ref in nb.legal_moves:
            # Was this already threatened before your move (same move, same target)?
            same_target = nb.piece_type_at(ref.to_square) == after.piece_type_at(ref.to_square)
            ignored = same_target and (nb.is_capture(ref) or nb.gives_check(ref))
        # 2) What it costs in material, best play vs. your move.
        cost = None
        mat_best = _line_balance(before, m.get("bestLine") or [m["bestSan"]])
        mat_played = _line_balance(after, ref_line)
        if mat_best is not None and mat_played is not None and abs(mat_played) < 100 and abs(mat_best) < 100:
            delta = mat_best - (-mat_played)  # mat_played is from the opponent's side
            # The two lines are cut off after a few moves, sometimes in the middle of an exchange: only
            # name the material when the evaluation really dropped by about that much.
            drop = _pawns_dropped(m)
            if delta >= 1 and drop is not None and drop >= max(0.5, 0.5 * delta):
                cost = f"With best play it costs {v.mover.subj} {_material_words(delta)}."

        own_mate = m["eval"].get("mate")  # the move's own search has to agree that it walks into a mate
        if ref_mate is not None and (ref_mate > 0) != me_white and own_mate is not None and (own_mate > 0) != me_white:
            why.append(f"It allows mate in {abs(ref_mate)}, starting with {nxt['bestSan']}.")
        elif ignored and (theme or cost):
            # Only a threat if it wins something – a capture that's just a trade isn't one.
            why.append(f"It ignores the threat {nb.san(ref)}{_theme_clause(theme, after, ref)}.")
        elif theme:
            why.append(f"It allows {nxt['bestSan']}{_theme_clause(theme, after, ref)}.")
        elif cost:
            # No named tactic, but material goes: at least say which reply does it.
            why.append(f"It allows {nxt['bestSan']}.")
        if cost:
            why.append(cost)

    if m.get("cls") == C.MISS:
        best_mate = (m.get("bestEval") or {}).get("mate")
        if i > 0 and moves[i - 1]["cls"] in BAD:  # the previous move was an error: a chance to punish
            why.insert(0, f"{v.other.Subj} had just slipped – this was the moment to punish it."
                          if v.mine is not False else "You had just slipped – and your opponent let you off the hook.")
        elif best_mate is not None and (best_mate > 0) == me_white:
            why.insert(0, f"There was a forced mate in {abs(best_mate)}.")
    if not why:
        # No tactic and no material: say what the move does and what it costs positionally.
        does = describe(before, move, nxt_line, prev)
        if assess["before"] == assess["after"]:
            change = f"{v.mover.poss} position gets {'a little' if m['loss'] < C.INACCURACY_MAX else 'clearly'} worse "                      f"(still {assess['after']})"
        else:
            change = f"{v.mover.poss} position goes from {assess['before']} to {assess['after']}"
        does = [d.replace("castles the king to safety", "castles") for d in does]  # it was a bad move after all
        why.append(f"It {_join(does)}, but {change}." if does else f"{change[0].upper()}{change[1:]}.")

    bd = describe(before, best, best_line, prev)
    theme_best = tactics.theme_of_line(before, m.get("bestLine") or [m["bestSan"]], tactics.exchange_start(moves, i))
    better = f"Better was {m['bestSan']}"
    best_mate = (m.get("bestEval") or {}).get("mate")
    if theme_best in ("mate", "back_rank") or (best_mate is not None and best_mate != 0 and (best_mate > 0) == me_white):
        better += " – it leads to a forced mate."
    elif bd:
        better += f" – it {_join(bd)}."
        if theme_best and theme_best not in ("free_piece", "promotion") and "attacks" not in " ".join(bd):
            better = better[:-1] + f" (setting up {'an' if theme_best[0] in 'aeiou' else 'a'} {tactics.THEMES[theme_best].lower()})."
    else:
        better += f", keeping the position {assess['before']}."
    return {**assess, "why": " ".join(why), "better": better}


_HANGING = re.compile(r" It leaves the \w+ on ([a-h][1-8]) hanging\.")


def _check_hanging(moves: list[dict], i: int) -> str:
    """Older reviews could call a piece hanging that best play doesn't actually take: drop that sentence."""
    text = moves[i].get("text", "")
    found = _HANGING.search(text)
    if not found or i + 1 >= len(moves):
        return text
    after = chess.Board(moves[i]["fen"])
    pv, b = [], after.copy(stack=False)
    for san in moves[i + 1].get("bestLine") or []:
        try:
            mv = b.parse_san(san)
        except ValueError:
            break
        pv.append(mv)
        b.push(mv)
    if C._taken_soon(after, pv, chess.parse_square(found.group(1))):
        return text
    return text.replace(found.group(0), f" {moves[i]['bestSan']} was best.")


def enrich(record: dict, end: dict | None = None) -> dict:
    """Add the coach's notes to a review, and word the stored move texts for whoever moved."""
    moves = record.get("moves", [])
    me = record.get("me")
    for i in range(len(moves)):
        mover = chess.WHITE if moves[i].get("color") == "w" else chess.BLACK
        moves[i]["text"] = render(_check_hanging(moves, i), voice_for(mover, me))
        try:
            c = coach_move(moves, i, end, me)
        except (ValueError, KeyError, AssertionError):
            c = None
        if c:
            moves[i]["coach"] = c
    return record
