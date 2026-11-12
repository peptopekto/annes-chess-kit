"""'Is it safe?' – a blunder-check drill built from your own games.

Each card is a position plus a candidate move (one you actually played). Unsafe
cards are your real blunders that lost material or allowed mate; safe cards are
sound moves of yours, preferably ones that *look* risky (a piece landing on an
attacked square, captures, checks) so the drill trains real checking, not guessing.
Cards you answer wrong come back first next time.
"""
from __future__ import annotations

import json
import random
import threading
import time

import chess

from . import classify as C
from . import storage, tactics
from .config import USERDATA, write_atomic

STATS_FILE = USERDATA / "safety_stats.json"
TACTICAL = {"free_piece", "fork", "pin", "skewer", "discovered", "trapped", "mate", "back_rank", "promotion"}
_lock = threading.Lock()


def _stats() -> dict:
    try:
        return json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"cards": {}, "sessions": []}


def _looks_risky(board: chess.Board, move: chess.Move) -> bool:
    """A sound move that a nervous player might still doubt."""
    if board.is_capture(move) or board.gives_check(move):
        return True
    after = board.copy(stack=False)
    after.push(move)
    return after.is_attacked_by(not board.turn, move.to_square)


def _names(board: chess.Board, squares, color: chess.Color) -> str:
    pieces = sorted({chess.piece_name(board.piece_type_at(sq)) for sq in squares},
                    key=lambda n: ["pawn", "knight", "bishop", "rook", "queen", "king"].index(n))
    side = "white" if color == chess.WHITE else "black"
    if not pieces:
        return ""
    return f"the {side} " + (" and ".join(pieces) if len(pieces) <= 2 else ", ".join(pieces[:-1]) + " and " + pieces[-1])


def _why_safe(board: chess.Board, move: chess.Move) -> str:
    """Plain-language reason the moved piece isn't simply lost."""
    me = board.turn
    after = board.copy(stack=False)
    after.push(move)
    sq = move.to_square
    piece = chess.piece_name(after.piece_type_at(sq))
    where = chess.square_name(sq)
    if after.is_checkmate():
        return "It's checkmate."
    attackers = [a for a in after.attackers(not me, sq) if after.is_legal(chess.Move(a, sq))]
    if not attackers:
        if after.is_check():
            return f"It gives check and nothing can take your {piece} on {where}."
        return f"Nothing can take your {piece} on {where}."
    defenders = list(after.attackers(me, sq))
    if board.is_capture(move) and not board.is_en_passant(move):
        took = board.piece_type_at(sq)
        if C.PIECE_VALUES[took] >= C.PIECE_VALUES[after.piece_type_at(sq)]:
            return (f"It's a fair trade: you take a {chess.piece_name(took)}, and if they take back on {where} "
                    f"you've lost nothing.")
    if defenders:
        return (f"Your {piece} on {where} is attacked by {_names(after, attackers, not me)} but defended by "
                f"{_names(after, defenders, me).replace('the white ', 'your ').replace('the black ', 'your ')} – "
                f"taking it doesn't win anything.")
    return (f"Your {piece} on {where} can be taken by {_names(after, attackers, not me)}, but the engine says "
            f"that's fine for you – it's a deliberate offer, not a blunder.")


def _cards_from(record: dict) -> list[dict]:
    me = record.get("me")
    if not me:
        return []
    moves = record["moves"]
    out = []
    for i, m in enumerate(moves):
        if m["color"] != me:
            continue
        board = chess.Board(m["fenBefore"])
        if board.fullmove_number <= 6 or m["cls"] in (C.BOOK, C.FORCED):
            continue
        move = chess.Move.from_uci(m["uci"])
        base = {"id": f"{record['id']}-{m['ply']}", "gameId": record["id"], "ply": m["ply"], "fen": m["fenBefore"],
                "uci": m["uci"], "san": m["san"], "date": record.get("date")}
        if m["cls"] in (C.MISTAKE, C.BLUNDER) and m["loss"] >= 0.15 and i + 1 < len(moves):
            nxt = moves[i + 1]
            line = nxt.get("bestLine") or [nxt["bestSan"]]
            theme = tactics.theme_of_line(chess.Board(m["fen"]), line, chess.Board(m["fenBefore"]))
            if theme in TACTICAL:
                out.append({**base, "safe": False, "theme": theme, "label": tactics.THEMES[theme],
                            "refute": {"san": nxt["bestSan"], "uci": nxt["bestUci"], "line": line[:6]},
                            "tip": tactics.TIPS[theme]})
        elif m["cls"] in (C.BEST, C.EXCELLENT, C.GOOD, C.GREAT, C.BRILLIANT) and m["epAfter"] >= 0.35:
            out.append({**base, "safe": True, "risky": _looks_risky(board, move), "why": _why_safe(board, move)})
    return out


def _rebuild(card_ids: list[str]) -> list[dict]:
    """Cards answered before payloads were stored ('<gameId>-<ply>'): rebuild them from the review."""
    by_game: dict[str, set[str]] = {}
    for cid in card_ids:
        by_game.setdefault(cid.rsplit("-", 1)[0], set()).add(cid)
    out = []
    for gid, want in by_game.items():
        try:
            r = storage.load(gid)
        except ValueError:
            continue
        if r:
            out += [c for c in _cards_from(r) if c["id"] in want]
    return out


def deck(count: int = 20, mode: str = "mixed") -> list[dict]:
    """A session. mixed: half unsafe / half safe (risky-looking first), past misses first.
    review: only cards you got wrong last time."""
    data = _stats()
    stats = data["cards"]
    missed_cards = [c["card"] for c in stats.values() if c.get("lastWrong") and c.get("card")]
    missed_cards += _rebuild([cid for cid, c in stats.items() if c.get("lastWrong") and not c.get("card")])
    if mode == "review":
        random.shuffle(missed_cards)
        return missed_cards[:count]

    ids = [gid for gid, _ in storage.index()]
    random.shuffle(ids)
    unsafe, safe, risky = [], [], []
    missed_ids = {c["id"] for c in missed_cards}
    for gid in ids[:250]:
        r = storage.load(gid)
        if not r:
            continue
        for c in _cards_from(r):
            if c["id"] in missed_ids:
                continue
            (unsafe if not c["safe"] else risky if c.get("risky") else safe).append(c)
        if len(unsafe) >= count and len(risky) >= count:
            break
    random.shuffle(unsafe); random.shuffle(risky); random.shuffle(safe)
    half = count // 2
    review = missed_cards[: max(0, count // 4)]  # up to a quarter of the session is old misses
    want_unsafe = max(0, half - sum(1 for c in review if not c["safe"]))
    chosen = review + unsafe[:want_unsafe]
    chosen += (risky + safe)[: count - len(chosen)]
    random.shuffle(chosen)
    return chosen


def answer(card: dict, said_safe: bool) -> dict:
    correct = said_safe == card["safe"]
    with _lock:
        data = _stats()
        s = data["cards"].setdefault(card["id"], {"right": 0, "wrong": 0})
        s["right" if correct else "wrong"] += 1
        s["lastWrong"] = not correct
        s["last"] = int(time.time())
        s["safe"], s["theme"] = card["safe"], card.get("theme")
        s["card"] = card  # kept so missed cards can be replayed in review mode
        data.setdefault("answers", []).append({"at": int(time.time()), "safe": card["safe"], "theme": card.get("theme"),
                                               "saidSafe": said_safe, "correct": correct})
        data["answers"] = data["answers"][-5000:]
        write_atomic(STATS_FILE, json.dumps(data))
    return {"correct": correct, **{k: v for k, v in s.items() if k != "card"}}


def finish(right: int, total: int, seconds: float, mode: str = "mixed") -> dict:
    with _lock:
        data = _stats()
        data["sessions"].append({"at": int(time.time()), "right": right, "total": total,
                                 "seconds": round(seconds), "mode": mode})
        write_atomic(STATS_FILE, json.dumps(data))
    return summary()


def summary() -> dict:
    s = _stats()
    sessions = s["sessions"][-30:]
    return {"sessions": sessions,
            "best": max((x["right"] / x["total"] * 100 for x in sessions if x["total"]), default=None),
            "toReview": sum(1 for c in s["cards"].values() if c.get("lastWrong"))}


def hub() -> dict:
    """Everything for the Blunder-check hub: sessions, progress, and *how* you go wrong."""
    s = _stats()
    answers = s.get("answers", [])
    unsafe = [a for a in answers if not a["safe"]]
    safe = [a for a in answers if a["safe"]]
    by_theme: dict[str, list[dict]] = {}
    for a in unsafe:
        by_theme.setdefault(a.get("theme") or "other", []).append(a)
    themes = sorted(({"theme": t, "label": tactics.THEMES.get(t, "Other"), "seen": len(v),
                      "spotted": sum(x["correct"] for x in v),
                      "rate": round(sum(x["correct"] for x in v) / len(v) * 100)} for t, v in by_theme.items()),
                    key=lambda r: r["rate"])
    sessions = s.get("sessions", [])
    # Sessions are the full record (the per-answer log only started later), so totals come from them.
    answered = sum(x["total"] for x in sessions)
    correct = sum(x["right"] for x in sessions)
    recent_right = recent_total = 0
    for x in reversed(sessions):
        if recent_total >= 100:
            break
        recent_right += x["right"]
        recent_total += x["total"]
    return {
        "sessions": sessions[-100:],
        "totals": {"sessions": len(sessions), "answered": answered, "correct": correct,
                   "seconds": sum(x.get("seconds", 0) for x in sessions)},
        # Missed dangers = said "safe" to a blunder (careless); false alarms = said "unsafe" to a good move (over-cautious).
        "missedDangers": {"n": len(unsafe), "missed": sum(not a["correct"] for a in unsafe)},
        "falseAlarms": {"n": len(safe), "wrong": sum(not a["correct"] for a in safe)},
        "recentAccuracy": round(recent_right / recent_total * 100) if recent_total else None,
        "themes": themes,
        "toReview": sum(1 for c in s["cards"].values() if c.get("lastWrong")),
        "seenCards": len(s["cards"]),
    }
