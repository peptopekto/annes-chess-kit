"""The coach's lesson cards: one per positional concept, stored as YAML in backend/data/coach/.

Each card holds the principle, an explanation in the app's own words, the templates for "what happened in
your game", the question to ask at the board, when the rule doesn't hold, the book it comes from and model
positions that show it (replayed with python-chess when loaded). See data/coach/pawns.yaml for the format.
"""
from __future__ import annotations

import json
import threading
import time
from functools import lru_cache
from pathlib import Path

import chess
import yaml

from . import concepts as K
from .config import DATA, USERDATA, write_atomic

COACH_DIR = DATA / "coach"
FEEDBACK_FILE = USERDATA / "coach_feedback.json"

LEVELS = ("beginner", "improver", "club")
REQUIRED = ("id", "concept", "title", "level", "phase", "principle", "explanation", "in_your_game",
            "ask_yourself", "your_chance", "exceptions", "source", "examples")


class CardError(ValueError):
    pass


def _example(card_id: str, ex: dict) -> dict:
    """Replay a card's example: the position to show, the line in SAN, and the squares to mark."""
    board = chess.Board(ex["fen"]) if ex.get("fen") else chess.Board()
    try:
        for san in str(ex.get("moves") or "").split():
            board.push_san(san)
    except ValueError as e:
        raise CardError(f"{card_id}: example '{ex.get('title')}' has an illegal setup move: {e}") from e
    fen = board.fen()
    line, after = [], board.copy()
    try:
        for san in str(ex.get("line") or "").split():
            after.push_san(san)
            line.append(san)
    except ValueError as e:
        raise CardError(f"{card_id}: example '{ex.get('title')}' has an illegal line move: {e}") from e
    side = {"white": chess.WHITE, "black": chess.BLACK}.get(ex.get("side"))
    if side is None:
        raise CardError(f"{card_id}: example '{ex.get('title')}' needs side: white or black")
    return {"title": ex["title"], "fen": fen, "line": line, "side": "w" if side else "b",
            "note": " ".join(str(ex.get("note", "")).split())}


def _check(card: dict) -> dict:
    missing = [k for k in REQUIRED if k not in card]
    if missing:
        raise CardError(f"card {card.get('id', '?')}: missing {', '.join(missing)}")
    if card["concept"] not in K.CONCEPTS:
        raise CardError(f"card {card['id']}: unknown concept {card['concept']}")
    if card["level"] not in LEVELS:
        raise CardError(f"card {card['id']}: level must be one of {', '.join(LEVELS)}")
    for key in ("in_your_game", "your_chance"):
        if not {"own", "other"} <= set(card[key]):
            raise CardError(f"card {card['id']}: {key} needs 'own' and 'other'")
    out = {k: (" ".join(v.split()) if isinstance(v, str) else v) for k, v in card.items()}
    out["exceptions"] = [" ".join(str(e).split()) for e in card["exceptions"]]
    out["related"] = list(card.get("related") or [])
    out["examples"] = [_example(card["id"], ex) for ex in card["examples"]]
    return out


@lru_cache(maxsize=1)
def load(folder: Path = COACH_DIR) -> dict[str, dict]:
    """All cards by id (checked once; a broken card raises CardError so it fails the tests, not a review)."""
    cards: dict[str, dict] = {}
    for f in sorted(folder.glob("*.yaml")):
        for raw in yaml.safe_load(f.read_text(encoding="utf-8")) or []:
            card = _check(raw)
            card["family"] = f.stem
            if card["id"] in cards:
                raise CardError(f"duplicate card id {card['id']}")
            cards[card["id"]] = card
    for card in cards.values():
        unknown = [r for r in card["related"] if r not in cards]
        if unknown:
            raise CardError(f"card {card['id']}: related cards not found: {', '.join(unknown)}")
    return cards


def for_concept(concept: str) -> dict | None:
    for card in load().values():
        if card["concept"] == concept:
            return card
    return None


def band(rating: int | None) -> str | None:
    """The player's level for picking cards: under 1000, 1000–1600, above 1600."""
    if not rating:
        return None
    return "beginner" if rating < 1000 else "improver" if rating <= 1600 else "club"


def level_factor(card: dict, rating: int | None) -> float:
    """Cards above the player's level need clearer evidence; those at or below it count fully."""
    b = band(rating)
    if b is None:
        return 1.0
    gap = LEVELS.index(card["level"]) - LEVELS.index(b)
    return {1: 0.8, 2: 0.6}.get(gap, 1.0)


def public(card: dict) -> dict:
    """What the review shows (no templates)."""
    keep = ("id", "concept", "title", "level", "phase", "principle", "explanation", "ask_yourself", "exceptions",
            "source", "related", "examples", "family")
    return {k: card[k] for k in keep}


# --------------------------------------------------------------------------- #
#  "Doesn't fit" – feedback on a lesson shown in a review, kept locally to tune the thresholds
# --------------------------------------------------------------------------- #
_lock = threading.Lock()


def _read_feedback() -> list[dict]:
    try:
        return json.loads(FEEDBACK_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def feedback(game: str, ply: int, concept: str, fits: bool, strength: float | None = None) -> dict:
    """Record (or replace) your verdict on the principle shown for one move."""
    if concept not in K.CONCEPTS:
        raise ValueError(f"unknown concept {concept}")
    with _lock:
        items = [i for i in _read_feedback() if not (i["game"] == game and i["ply"] == ply and i["concept"] == concept)]
        items.append({"game": game, "ply": int(ply), "concept": concept, "fits": bool(fits),
                      "strength": strength, "at": int(time.time())})
        write_atomic(FEEDBACK_FILE, json.dumps(items, indent=1))
    return feedback_summary(items)


def feedback_summary(items: list[dict] | None = None) -> dict:
    """Per concept: how often the lesson fit and how often it didn't."""
    out: dict[str, dict[str, int]] = {}
    for i in items if items is not None else _read_feedback():
        s = out.setdefault(i["concept"], {"fits": 0, "doesntFit": 0})
        s["fits" if i["fits"] else "doesntFit"] += 1
    return out


def verdicts(game: str) -> dict[str, bool]:
    """Your earlier verdicts for one game, keyed "ply:concept"."""
    return {f"{i['ply']}:{i['concept']}": i["fits"] for i in _read_feedback() if i["game"] == game}
