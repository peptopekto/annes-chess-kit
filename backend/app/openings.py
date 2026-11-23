"""Opening book built from lichess-org/chess-openings (CC0).

Positions are keyed by EPD so transpositions are recognised as book too.
"""
import io
import json
from functools import lru_cache

import chess
import chess.pgn

from .config import DATA, FROZEN, USERDATA

TSV = DATA / "openings.tsv"
# The single-file app unpacks its program files afresh for every run (with new dates), so its cache lives in
# the data folder, named after the book's size: a different book in an update gets its own cache.
CACHE = USERDATA / "cache" / f"openings-{TSV.stat().st_size}.json" if FROZEN else DATA / "openings.cache.json"


@lru_cache(maxsize=1)
def book() -> dict[str, tuple[str, str]]:
    if CACHE.exists() and (FROZEN or CACHE.stat().st_mtime >= TSV.stat().st_mtime):
        return {k: tuple(v) for k, v in json.loads(CACHE.read_text(encoding="utf-8")).items()}

    positions: dict[str, tuple[str, str]] = {}
    for line in TSV.read_text(encoding="utf-8").splitlines():
        eco, name, pgn = line.split("\t")
        game = chess.pgn.read_game(io.StringIO(pgn))
        if game is None:
            continue
        board = game.board()
        for move in game.mainline_moves():
            board.push(move)
            # Every prefix of a named line is book; it keeps an empty name
            # unless some (shorter) line names it explicitly.
            positions.setdefault(board.epd(), ("", ""))
        positions[board.epd()] = (eco, name)

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(positions), encoding="utf-8")
    return positions


def lookup(board: chess.Board) -> tuple[str, str] | None:
    return book().get(board.epd())


# --------------------------------------------------------------------------- #
#  Line structure (for the opening trainer)
# --------------------------------------------------------------------------- #

@lru_cache(maxsize=1)
def lines() -> list[tuple[str, str, list[str]]]:
    """Every book line as (eco, name, [uci, …])."""
    out = []
    for line in TSV.read_text(encoding="utf-8").splitlines():
        eco, name, pgn = line.split("\t")
        game = chess.pgn.read_game(io.StringIO(pgn))
        if game is not None:
            out.append((eco, name, [m.uci() for m in game.mainline_moves()]))
    return out


def family_of(name: str | None) -> str:
    """'Caro-Kann Defense: Advance Variation' and 'Rapport-Jobava System, with e6' → their family."""
    return (name or "").split(":")[0].split(",")[0].strip()


@lru_cache(maxsize=1)
def family_roots() -> dict[str, list[str]]:
    """family -> the moves every book line of that family shares (one pass over the book)."""
    by_family: dict[str, list[list[str]]] = {}
    for _, name, ucis in lines():
        by_family.setdefault(family_of(name), []).append(ucis)
    roots = {}
    for fam, fam_lines in by_family.items():
        root = []
        for moves in zip(*fam_lines):
            if all(m == moves[0] for m in moves):
                root.append(moves[0])
            else:
                break
        roots[fam] = root
    return roots


@lru_cache(maxsize=None)  # ~100 families: small, and rebuilding one costs ~0.1 s
def family_book(family: str) -> dict:
    """Theory of one opening family.

    Returns {"root": [uci…] (moves every line of the family shares),
             "next": {epd: {uci: name-or-""}}  (book moves from each position)}.
    """
    fam_lines = [ucis for _, name, ucis in lines() if family_of(name) == family]
    if not fam_lines:
        return {"root": [], "next": {}}
    root = []
    for moves in zip(*fam_lines):
        if all(m == moves[0] for m in moves):
            root.append(moves[0])
        else:
            break
    nxt: dict[str, dict[str, str]] = {}
    names = book()
    for ucis in fam_lines:
        b = chess.Board()
        for u in ucis:
            epd = b.epd()
            b.push_uci(u)
            nxt.setdefault(epd, {})[u] = names.get(b.epd(), ("", ""))[1]
    return {"root": root, "next": nxt}
