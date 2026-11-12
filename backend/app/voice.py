"""Who the review commentary is talking about.

Every comment is about one move. When it's your move the coach says "you"; when it's your
opponent's it says "your opponent" (and "you" for you); when it isn't known which side you
played (no username set) it uses the colours.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import chess


@dataclass(frozen=True)
class Person:
    subj: str   # "you" / "your opponent" / "White"
    poss: str   # "your" / "your opponent's" / "White's"
    was: str    # "were" / "was"
    has: str    # "have" / "has"

    @property
    def Subj(self) -> str:  # noqa: N802 - sentence start
        return self.subj[0].upper() + self.subj[1:]

    @property
    def Poss(self) -> str:  # noqa: N802
        return self.poss[0].upper() + self.poss[1:]


YOU = Person("you", "your", "were", "have")
OPPONENT = Person("your opponent", "your opponent's", "was", "has")


def _colour(c: chess.Color) -> Person:
    name = "White" if c == chess.WHITE else "Black"
    return Person(name, f"{name}'s", "was", "has")


@dataclass(frozen=True)
class Voice:
    mover: Person   # the side that played the move
    other: Person   # the side that didn't
    mine: bool | None  # your move / your opponent's / unknown


def voice_for(mover: chess.Color, me: str | None) -> Voice:
    """`me` is "w", "b" or None (the record's side for you)."""
    if me not in ("w", "b"):
        return Voice(_colour(mover), _colour(not mover), None)
    mine = (me == "w") == (mover == chess.WHITE)
    return Voice(YOU, OPPONENT, True) if mine else Voice(OPPONENT, YOU, False)


_OPP = re.compile(r"\b([Yy])our opponent\b")


def render(text: str, v: Voice) -> str:
    """Stored move texts are written for the mover ("…cost your opponent dearly"): reword them for `v`."""
    if v.mine is True or not text:
        return text
    return _OPP.sub(lambda m: v.other.Subj if m.group(1) == "Y" else v.other.subj, text)
