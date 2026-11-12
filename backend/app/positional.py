"""Positional coach: which principle a move went against – and only when the engine agrees.

For a move the engine rates Inaccuracy or worse that no tactic explains (see tactics.enrich), compare
the position after the engine's best move with the position after the move played – right after the
move, and again a few plies down each engine line – using the concept detectors (concepts.py).

A concept is taught only when
* the played move made it clearly worse for the mover (weighted by the phase of the game), and
* the engine's lines confirm it: the difference is still there after a few moves of best play.

Otherwise nothing is taught: a wrong principle is worse than none. What is taught comes from the lesson
cards (cards.py, data/coach/*.yaml): the principle, the explanation, the question to ask and the book,
with a template filled with this move's facts.
"""
from __future__ import annotations

import re

import chess

from . import classify as C
from . import cards
from . import concepts as K
from .voice import YOU, Voice, voice_for

LINE_PLIES = 3          # how far down each engine line the concept has to hold
THRESHOLD = 0.6         # weighted change (concept units x phase weight) needed to teach
SECOND_SHARE = 0.7      # a second concept is shown when it is at least this strong relative to the first
NOT_TAUGHT = {"mobility", "material"}  # measured, but too generic to name as "the" principle
GENERIC = {"center_control": 0.7, "space": 0.7}  # real, but broad: these need a clearer change to be "the" reason
MATERIAL_SWING = 1      # pawn units: if the lines end apart in material, the move lost (or missed) material – not a principle
THEIR_SIDE = 0.75       # "you let them fix/gain X" teaches less than "you created X": it needs more evidence
BLUNDER_FACTOR = 0.5    # a blunder is rarely explained by a principle alone; it needs a much clearer change
# …and then only by something that can cost a game at once: the king's safety or a pawn that runs through.
# "Your king was passive" or "a bad bishop" is never why a move drops two pawns' worth – that's a tactic.
BLUNDER_CONCEPTS = {"king_attackers", "king_center", "king_open_lines", "king_shield", "back_rank", "lost_castling",
                    "passed_pawn", "unstoppable_passer", "protected_passer"}
ONE_SQUARE = {"bad_bishop", "knight_rim", "knight_outpost", "bishop_outpost", "rook_open_file", "rook_seventh", "blockade"}
ROOK_HOMES = {chess.A1, chess.H1, chess.A8, chess.H8}
DECIDED_CP = 700        # beyond this the game is decided either way; a principle isn't what the move is about

# Rating gaps, "doesn't fit" feedback: see cards.level_factor and tuning() below.
FEEDBACK_MIN = 3        # verdicts on a concept before your feedback starts to count
FEEDBACK_WEIGHT = 0.4   # all "doesn't fit" -> the concept needs 1/(1-0.4) = 1.7x the evidence


def tuning() -> dict[str, float]:
    """Per concept, how much your "doesn't fit" verdicts damp it (1.0 = not at all)."""
    out = {}
    for cid, s in cards.feedback_summary().items():
        n = s["fits"] + s["doesntFit"]
        if n >= FEEDBACK_MIN:
            out[cid] = 1 - FEEDBACK_WEIGHT * s["doesntFit"] / n
    return out


def _after(fen: str, sans: list[str], plies: int) -> chess.Board | None:
    board = chess.Board(fen)
    for san in sans[:plies]:
        try:
            board.push_san(san)
        except ValueError:
            return None
    return board


def _line_text(fen: str, sans: list[str], plies: int) -> str:
    """The engine's line in move-number notation ("22.Nd5 Rc8 23.c3")."""
    board = chess.Board(fen)
    moves = []
    for san in sans[:plies]:
        try:
            moves.append(board.parse_san(san))
            board.push(moves[-1])
        except ValueError:
            break
    return chess.Board(fen).variation_san(moves).replace(". ", ".") if moves else ""


def _words(v: Voice) -> dict[str, str]:
    """Template words: {you}/{your} the mover, {opp}/{opps} the other side, {their} its pronoun."""
    return {"you": v.mover.subj, "your": v.mover.poss, "opp": v.other.subj, "opps": v.other.poss,
            "their": "your" if v.other == YOU else "their"}


def _piece_square(board: chess.Board, squares: list[int]) -> list[int]:
    return [s for s in squares if (p := board.piece_at(s)) and p.piece_type != chess.PAWN][:1]


def _balance(board: chess.Board, pov: bool) -> int:
    return K.material(board, pov) - K.material(board, not pov)


def _side(cid: str, a: K.Profile, p: K.Profile, pov: bool) -> str:
    """Which side the change is on: 'you' (your own structure/pieces) or 'them'."""
    pol = K.CONCEPTS[cid].polarity
    fa, fp = a.features[cid], p.features[cid]
    mine = -pol * (fp.value[pov] - fa.value[pov])          # > 0 = worse for you, on your side
    theirs = pol * (fp.value[not pov] - fa.value[not pov])  # > 0 = better for them
    return "you" if mine >= theirs else "them"


def _squares(cid: str, a: K.Profile, p: K.Profile, side: bool) -> list[int]:
    """The squares that show the concept after the move played (new ones first)."""
    now, before = p.features[cid].squares[side], set(a.features[cid].squares[side])
    new = [s for s in now if s not in before]
    return list(dict.fromkeys(new or now))


def explain(moves: list[dict], i: int, me: str | None = None, rating: int | None = None,
            damp: dict[str, float] | None = None) -> dict | None:
    """The principle behind move `i`, or None when there's nothing sure to teach.

    `me` is the side you played ("w"/"b"), so the texts say "you" or "your opponent" correctly; `rating` picks
    lessons for your level; `damp` is tuning() (your "doesn't fit" verdicts)."""
    m = moves[i]
    if m.get("cls") not in (C.INACCURACY, C.MISTAKE, C.BLUNDER):
        return None
    if m.get("missed") or (m.get("refute") or {}).get("theme"):
        return None  # a tactic explains it – the tactics coaching covers that
    if not m.get("bestUci") or m["uci"] == m["bestUci"]:
        return None
    best_eval, played_eval = m.get("bestEval") or {}, m.get("eval") or {}
    if "mate" in best_eval or "mate" in played_eval or abs(best_eval.get("cp", 0)) > DECIDED_CP:
        return None  # mates and decided positions are about calculation, not principles
    before = chess.Board(m["fenBefore"])
    pov = before.turn
    best_now = before.copy(stack=False)
    try:
        best_now.push_uci(m["bestUci"])
    except ValueError:
        return None
    played_now = chess.Board(m["fen"])
    nxt = moves[i + 1] if i + 1 < len(moves) else None
    best_line = _after(m["fenBefore"], m.get("bestLine") or [], 1 + LINE_PLIES)
    reply_line = _after(m["fen"], (nxt or {}).get("bestLine") or [], LINE_PLIES) if nxt else None
    if best_line is None or reply_line is None:
        return None  # no line to confirm with (e.g. the game's last move)

    if abs(_balance(best_line, pov) - _balance(reply_line, pov)) >= MATERIAL_SWING:
        return None  # the difference is material: a tactic (or a loose piece), not a principle

    phase = K.phase_of(before)
    voice = voice_for(pov, me)
    reply_san = _line_text(m["fen"], (nxt or {}).get("bestLine") or [], LINE_PLIES + 1)
    a0, p0 = K.measure(best_now), K.measure(played_now)
    a1, p1 = K.measure(best_line), K.measure(reply_line)
    now = {c.concept: c for c in K.compare(a0, p0, pov, phase)}
    later = {c.concept: c for c in K.compare(a1, p1, pov, phase)}

    found = []
    for cid, c1 in later.items():
        card = cards.for_concept(cid)
        if cid in NOT_TAUGHT or card is None or c1.weighted >= 0:
            continue
        c0 = now.get(cid)
        # Confirmed: worse right after the move AND still worse after best play – or clearly worse
        # once the lines are played out (the engine shows it: an outpost gets occupied, a file taken).
        score = (c0.weighted + c1.weighted) / 2 if c0 and c0.weighted < 0 else c1.weighted * 0.8
        score *= GENERIC.get(cid, 1.0) * cards.level_factor(card, rating) * (damp or {}).get(cid, 1.0)
        side = _side(cid, a1, p1, pov)
        if side == "them":
            score *= THEIR_SIDE
        if m["cls"] == C.BLUNDER:
            if cid not in BLUNDER_CONCEPTS:
                continue
            score *= BLUNDER_FACTOR
        color = pov if side == "you" else not pov
        # Squares on the board right after the move when it shows there already, else down the line.
        here = _squares(cid, a0, p0, color)
        sq = here or _squares(cid, a1, p1, color)
        if cid in ONE_SQUARE:  # name the piece, not the pawns around it
            here = _piece_square(played_now, here)
            sq = here or _piece_square(reply_line, sq)
        if cid == "passive_piece" and all(s in ROOK_HOMES for s in sq):
            continue  # a rook still in its corner isn't a lesson yet
        if score <= -THRESHOLD:
            found.append((score, cid, side, sq, here, card))
    if not found:
        return None
    found.sort(key=lambda f: f[0])
    picks = [found[0]] + [f for f in found[1:2] if f[0] <= found[0][0] * SECOND_SHARE]

    out = []
    for score, cid, side, sq, here, card in picks:
        template = card["in_your_game"]["own" if side == "you" else "other"]
        names = ", ".join(chess.square_name(s) for s in sq[:3])
        text = template if names else re.sub(r" \([^()]*\{sq\}\)", "", template)
        text = text.format(sq=names, **_words(voice))
        theirs = voice.mine is False  # your opponent's move: tell you how to use it
        out.append({
            **cards.public(card),
            **({"chance": card["your_chance"]["own" if side == "you" else "other"], "replyLine": reply_san}
               if theirs else {}),
            "concept": cid,
            "card": card["id"],
            "side": "own" if side == "you" else "other",  # whose position: the mover's own, or the other side's
            "inGame": text,
            "squares": [chess.square_name(s) for s in here[:4]],  # to mark on the board after the move
            "strength": round(-score, 2),
        })
    return {"phase": phase, "concepts": out}


def enrich(record: dict) -> dict:
    """Add `principle` to the moves a positional concept explains (run after tactics.enrich)."""
    moves = record.get("moves", [])
    me = record.get("me")
    damp = tuning()
    verdict = cards.verdicts(record.get("id", ""))
    for i in range(len(moves)):
        mover = moves[i].get("color")
        try:
            p = explain(moves, i, me, _rating(record, me or mover), damp)
        except (ValueError, KeyError, AssertionError):
            p = None
        if p:
            for c in p["concepts"]:
                v = verdict.get(f"{moves[i].get('ply')}:{c['concept']}")
                if v is not None:
                    c["fits"] = v
            moves[i]["principle"] = p
    return record


def _rating(record: dict, side: str | None) -> int | None:
    """The rating the lessons are pitched at: yours when known, else the mover's."""
    try:
        return int(record.get("whiteElo" if side == "w" else "blackElo") or 0) or None
    except (TypeError, ValueError):
        return None
