"""One-time re-check of brilliant moves in existing reviews against the stricter sacrifice rule.

Older reviews marked a move brilliant whenever a piece *looked* hanging after it. Now the engine's
line has to bear the sacrifice out (see classify.sacrifice_confirmed). The stored lines are enough
for most moves; a declined offer needs one short engine search. Runs in the background at startup.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

import chess
import chess.engine

from . import analysis, engine, storage
from . import classify as C

SAC_CHECK = analysis.SAC_CHECK  # bump it there to re-run the check over every review
log = logging.getLogger(__name__)


def _sans(board: chess.Board, sans: list[str]) -> list[chess.Move]:
    b = board.copy(stack=False)
    out = []
    for san in sans:
        try:
            m = b.parse_san(san)
        except ValueError:
            break
        out.append(m)
        b.push(m)
    return out


def recheck(record: dict, refute: C.Refuter | None) -> list[tuple[int, str, str]]:
    """Re-judge the record's brilliant moves in place. Returns (ply, san, new class) for each downgrade."""
    k = (record.get("ratingModel") or {}).get("k") or C.LICHESS_K
    sc = k / C.LICHESS_K
    moves = record.get("moves", [])
    changed = []
    for i, m in enumerate(moves):
        if m.get("cls") != C.BRILLIANT:
            continue
        board = chess.Board(m["fenBefore"])
        move = chess.Move.from_uci(m["uci"])
        if m["uci"] == m.get("bestUci") and len(m.get("bestLine") or []) > 1:
            reply = _sans(board, m["bestLine"])[1:]
        elif i + 1 < len(moves):
            after = board.copy(stack=False)
            after.push(move)
            nxt = moves[i + 1]
            reply = _sans(after, nxt.get("bestLine") or [nxt["bestSan"]])
        else:
            reply = []
        _, sq = C.sacrifice(board, move)
        kind = C.sacrifice_kind(board, move, sq, reply, refute, k, m.get("epAfter"))
        if kind:
            m["text"] = analysis.brilliant_text(board, move, m["san"], kind)  # says whether it was taken
            continue
        new = C.BEST if m["uci"] == m.get("bestUci") or m.get("loss", 0) < 0.005 * sc else C.EXCELLENT
        m["cls"], m["sacrifice"] = new, 0
        m["text"] = f"{m['san']} is the best move." if new == C.BEST else \
            f"{m['san']} is excellent — practically as good as the engine's choice."
        counts = (record.get("counts") or {}).get(m["color"])
        if counts is not None:
            counts[C.BRILLIANT] = max(0, counts.get(C.BRILLIANT, 0) - 1)
            counts[new] = counts.get(new, 0) + 1
        changed.append((m["ply"], m["san"], new))
    return changed


def run_special() -> None:
    """Once per review: re-check its Brilliant and Great moves with a deeper search (analysis.confirm_special).

    The engine work happens outside the storage lock; the result is applied only if the review wasn't
    re-analysed meanwhile.
    """
    todo = [s["id"] for s in storage.summaries()
            if (s.get("specialCheck") or 0) < analysis.SPECIAL_CHECK
            and (s.get("specialCheck") or any(((s.get("counts") or {}).get(c) or {}).get(cls)
                                              for c in ("w", "b") for cls in (C.BRILLIANT, C.GREAT)))]
    if not todo:
        return

    def one(gid: str) -> int:
        try:
            if storage.update(gid, _tidy_special):
                return 0  # checked by the first version: only needed the tidy-up
            record = storage.load(gid)
            if record is None:
                return 0
            k = (record.get("ratingModel") or {}).get("k") or C.LICHESS_K
            limits = analysis.Limits(depth=int(record.get("depth") or 16), move_time=record.get("moveTime"))
            changed = analysis.confirm_special(record["moves"], k, limits.depth, limits.time_cap)
            fresh = {m["ply"]: m for m in record["moves"]}

            def apply(current: dict) -> bool:
                if current.get("analysedAt") != record.get("analysedAt") or                         (current.get("specialCheck") or 0) >= analysis.SPECIAL_CHECK:
                    return False  # re-analysed meanwhile (with the check included)
                current["moves"] = [fresh.get(m["ply"], m) for m in current["moves"]]
                counts: dict[str, dict[str, int]] = {"w": {}, "b": {}}
                for m in current["moves"]:
                    counts[m["color"]][m["cls"]] = counts[m["color"]].get(m["cls"], 0) + 1
                current["counts"] = counts
                current["specialCheck"] = analysis.SPECIAL_CHECK
                return True
            return len(changed) if storage.update(gid, apply) else 0
        except Exception:  # one odd review must not stop the rest
            log.exception("special-move re-check failed for %s", gid)
            return 0

    # Several reviews at once so every engine has work (each review only has a few such moves).
    with ThreadPoolExecutor(max_workers=max(1, engine.batch.size // 2)) as pool:
        downgraded = sum(pool.map(one, todo))
    log.info("special-move re-check: %d reviews, %d moves downgraded", len(todo), downgraded)


def _tidy_special(record: dict) -> bool:
    """Reviews checked by the first version of confirm_special: fix what it left behind, no engine needed.

    It replaced the best move without updating the second-best one, and kept a "Good" move's deeper loss even
    above the Good band. Returns False (nothing to do) for reviews that weren't checked by that version.
    """
    if record.get("specialCheck") != 1:
        return False
    sc = ((record.get("ratingModel") or {}).get("k") or C.LICHESS_K) / C.LICHESS_K
    for m in record.get("moves", []):
        if m.get("secondUci") and m["secondUci"] == m.get("bestUci"):
            m["secondUci"] = None
        if m.get("cls") == C.GOOD and m.get("loss", 0) >= C.GOOD_MAX * sc:
            m["loss"] = round(C.GOOD_MAX * sc - 0.0001, 4)
    record["specialCheck"] = analysis.SPECIAL_CHECK
    return True


def run() -> None:
    """Re-check every review that still has brilliant moves judged by the old rule."""
    todo = [s["id"] for s in storage.summaries()
            if (s.get("sacCheck") or 0) < SAC_CHECK
            and any(((s.get("counts") or {}).get(c) or {}).get(C.BRILLIANT) for c in ("w", "b"))]
    if not todo:
        return
    refute = analysis.refuter(analysis.Limits(depth=16))
    downgraded = 0
    for gid in todo:
        def apply(record: dict) -> bool:
            nonlocal downgraded
            if (record.get("sacCheck") or 0) >= SAC_CHECK:
                return False  # re-analysed meanwhile with the new rule
            downgraded += len(recheck(record, refute))
            record["sacCheck"] = SAC_CHECK
            return True
        try:
            storage.update(gid, apply)
        except Exception:  # one odd review must not stop the rest
            log.exception("brilliant re-check failed for %s", gid)
    log.info("brilliant re-check: %d reviews, %d moves downgraded", len(todo), downgraded)


# --------------------------------------------------------------------------- #
#  Accuracy with Lichess's evaluation cap (no engine needed)
# --------------------------------------------------------------------------- #

ACC_CHECK = analysis.ACC_CHECK  # bump it there to recompute the accuracy of every review


def reaccuracy(record: dict) -> bool:
    """Recompute a stored review's accuracy from its win% curve. True if it changed."""
    wins = record.get("winPct") or []
    if len(wins) < 2:
        return False
    white_first = chess.Board(record.get("startFen") or chess.STARTING_FEN).turn == chess.WHITE
    w, b = C.game_accuracy(wins, white_first=white_first)
    new = {"w": w, "b": b}
    if record.get("accuracy") == new:
        return False
    record["accuracy"] = new
    return True


def run_accuracy() -> None:
    """Once per review: recompute the accuracy of reviews made before the ±10-pawn cap (see classify.WIN_CAP)."""
    todo = [s["id"] for s in storage.summaries() if (s.get("accCheck") or 0) < ACC_CHECK]
    changed = 0
    for gid in todo:
        def apply(record: dict) -> bool:
            nonlocal changed
            if (record.get("accCheck") or 0) >= ACC_CHECK:
                return False
            changed += reaccuracy(record)
            record["accCheck"] = ACC_CHECK
            return True
        try:
            storage.update(gid, apply)
        except Exception:  # one odd review must not stop the rest
            log.exception("accuracy recompute failed for %s", gid)
    if todo:
        log.info("accuracy recompute: %d reviews, %d changed", len(todo), changed)


# --------------------------------------------------------------------------- #
#  Re-rating mates and misses (no engine needed)
# --------------------------------------------------------------------------- #

RATE_CHECK = analysis.RATE_CHECK  # bump it there to re-apply the mate / miss rules to every review

_GOOD_TEXT = {C.BEST: "{san} is the best move.",
              C.EXCELLENT: "{san} is excellent — practically as good as the engine's choice."}


def _mover_mate(ev: dict | None, color: str) -> int | None:
    """Stored eval (White's point of view) -> mate distance for the mover (see classify._mate_for)."""
    if not ev or ev.get("mate") is None:
        return None
    m = ev["mate"]
    if m == 0:
        return 0 if ev.get("winner") == color else -1
    return m if color == "w" else -m


def _pov(ev: dict) -> chess.engine.PovScore:
    if ev.get("mate") is not None:
        m = ev["mate"]
        return chess.engine.PovScore(chess.engine.Mate(m), chess.WHITE)
    return chess.engine.PovScore(chess.engine.Cp(ev.get("cp", 0)), chess.WHITE)


def _band(loss: float, sc: float) -> str:
    for limit, cls in ((0.005, C.BEST), (C.EXCELLENT_MAX, C.EXCELLENT), (C.GOOD_MAX, C.GOOD),
                       (C.INACCURACY_MAX, C.INACCURACY), (C.MISTAKE_MAX, C.MISTAKE)):
        if loss < limit * sc:
            return cls
    return C.BLUNDER


def rerate(record: dict) -> list[tuple[int, str, str, str]]:
    """Re-judge mates and misses in a stored review, in place. Returns (ply, san, old, new) per change."""
    k = (record.get("ratingModel") or {}).get("k") or C.LICHESS_K
    sc = k / C.LICHESS_K
    moves = record.get("moves", [])
    changed = []
    for i, m in enumerate(moves):
        old = m.get("cls")
        if old == C.GREAT:
            # Saving an attacked piece on its only safe square is not something you have to find.
            try:
                board = chess.Board(m["fenBefore"])
                obvious = C.obvious_retreat(board, chess.Move.from_uci(m["uci"]))
            except ValueError:
                obvious = False
            if obvious:
                m["cls"], m["text"] = C.BEST, _GOOD_TEXT[C.BEST].format(san=m["san"])
                changed.append((m["ply"], m["san"], old, C.BEST))
            continue
        if old in (C.BOOK, C.FORCED, C.BRILLIANT) or not m.get("bestEval") or not m.get("eval"):
            continue
        if m.get("uci") == m.get("bestUci"):
            continue
        board = chess.Board(m["fenBefore"])
        move = chess.Move.from_uci(m["uci"])
        after_board = board.copy(stack=False)
        after_board.push(move)
        if after_board.is_checkmate():
            continue
        loss = m.get("loss") or 0.0
        base = _band(loss, sc) if old == C.MISS else old  # a Miss is re-judged from its expected-points band
        ep_best, ep_after = m.get("epBest", 0.5), m.get("epAfter", 0.5)
        # The stored eval comes from a separate search of the position after the move; only trust a
        # mate there when the played move's own search (epAfter) agrees.
        after_mate = _mover_mate(m["eval"], m["color"])
        if after_mate is not None and not (ep_after <= 0.001 if after_mate < 0 else ep_after >= 0.999):
            after_mate = None
        best_cp = m["bestEval"].get("cp")
        if best_cp is not None and m["color"] == "b":
            best_cp = -best_cp

        hanging = None
        if base in (C.INACCURACY, C.MISTAKE, C.BLUNDER):
            sac, sq = C.sacrifice(board, move)
            if sac >= 2 and sq is not None and i + 1 < len(moves):
                reply = _sans(after_board, moves[i + 1].get("bestLine") or [moves[i + 1].get("bestSan")])
                if C._taken_soon(after_board, reply, sq):
                    hanging = (sq, after_board.piece_type_at(sq))
        prev_loss = moves[i - 1].get("loss") if i else None
        new = C.judge_mates_and_misses(
            base, ep_best=ep_best, ep_after=ep_after, sc=sc, best_mate=_mover_mate(m["bestEval"], m["color"]),
            after_mate=after_mate, prev_loss=prev_loss, best_cp=best_cp, hangs_material=hanging is not None)
        if new == old:
            continue
        if new in _GOOD_TEXT:
            text = _GOOD_TEXT[new].format(san=m["san"])
        else:
            best = C.Line(move=chess.Move.from_uci(m["bestUci"]), score=_pov(m["bestEval"]))
            verdict = C.Verdict(new, loss, m.get("epBest", 0.5), m.get("epAfter", 0.5), None,
                                hanging=hanging if new != C.MISS else None)
            text = analysis.explain(verdict, board, move, m["san"], best, _pov(m["eval"]), None)
        m["cls"], m["text"] = new, text
        changed.append((m["ply"], m["san"], old, new))
    if changed:
        counts: dict[str, dict[str, int]] = {"w": {}, "b": {}}
        for m in moves:
            counts[m["color"]][m["cls"]] = counts[m["color"]].get(m["cls"], 0) + 1
        record["counts"] = counts
    return changed


def run_rates() -> None:
    """Once per review: apply the current mate / miss rules to reviews rated by an older version."""
    todo = [s["id"] for s in storage.summaries() if (s.get("rateCheck") or 0) < RATE_CHECK]
    total = 0
    for gid in todo:
        def apply(record: dict) -> bool:
            nonlocal total
            if (record.get("rateCheck") or 0) >= RATE_CHECK:
                return False
            total += len(rerate(record))
            record["rateCheck"] = RATE_CHECK
            return True
        try:
            storage.update(gid, apply)
        except Exception:  # one odd review must not stop the rest
            log.exception("mate/miss re-rating failed for %s", gid)
    if todo:
        log.info("mate/miss re-rating: %d reviews, %d moves re-rated", len(todo), total)
