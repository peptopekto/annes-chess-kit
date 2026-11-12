"""Fetch games from Chess.com / Lichess public APIs (no auth needed)."""
from __future__ import annotations

import json
import re
from typing import Iterator

import httpx

UA = {"User-Agent": "AnnesChessKit/1.0 (local chess review)"}
TIMEOUT = httpx.Timeout(30.0)


def _result_for(color_result: str) -> str:
    return {"win": "win", "agreed": "draw", "repetition": "draw", "stalemate": "draw",
            "insufficient": "draw", "50move": "draw", "timevsinsufficient": "draw"}.get(color_result, "loss")


# --------------------------------------------------------------------------- #
#  Chess.com: one archive per month
# --------------------------------------------------------------------------- #

def chesscom_archives(client: httpx.Client, username: str) -> list[str]:
    """Monthly archive URLs, oldest first."""
    r = client.get(f"https://api.chess.com/pub/player/{username.strip().lower()}/games/archives")
    if r.status_code == 404:
        raise ValueError(f"Chess.com user '{username}' not found.")
    r.raise_for_status()
    return r.json().get("archives", [])


def chesscom_month(client: httpx.Client, url: str, username: str) -> list[dict]:
    """Games of one monthly archive, newest first."""
    r = client.get(url)
    r.raise_for_status()
    user = username.strip().lower()
    out = []
    for g in reversed(r.json().get("games", [])):
        if g.get("rules") != "chess" or not g.get("pgn"):
            continue
        white, black = g["white"], g["black"]
        me_white = white["username"].lower() == user
        mine = white if me_white else black
        out.append({
            "source": "chess.com",
            "url": g.get("url"),
            "white": white["username"], "black": black["username"],
            "whiteElo": str(white.get("rating", "")), "blackElo": str(black.get("rating", "")),
            "myColor": "w" if me_white else "b",
            "outcome": _result_for(mine.get("result", "")),
            "timeClass": g.get("time_class", ""),
            "endTime": g.get("end_time") or 0,
            "moves": move_count(g["pgn"]),
            "pgn": g["pgn"],
        })
    return out


def chesscom_client() -> httpx.Client:
    return httpx.Client(headers=UA, timeout=TIMEOUT, follow_redirects=True)


# --------------------------------------------------------------------------- #
#  Lichess: one NDJSON stream
# --------------------------------------------------------------------------- #

def lichess_stream(username: str, since_ms: int | None = None) -> Iterator[dict]:
    """Every (standard) game of the user, newest first, streamed as it downloads."""
    user = username.strip()
    params = {"pgnInJson": "true", "clocks": "true", "evals": "false", "opening": "false"}
    if since_ms:
        params["since"] = str(since_ms)
    headers = {**UA, "Accept": "application/x-ndjson"}
    with httpx.stream("GET", f"https://lichess.org/api/games/user/{user}", params=params,
                      headers=headers, timeout=httpx.Timeout(30.0, read=120.0)) as r:
        if r.status_code == 404:
            raise ValueError(f"Lichess user '{username}' not found.")
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.strip():
                continue
            g = json.loads(line)
            if g.get("variant") != "standard" or not g.get("pgn"):
                continue
            players = g["players"]
            wname = players["white"].get("user", {}).get("name", "Anonymous")
            bname = players["black"].get("user", {}).get("name", "Anonymous")
            me_white = wname.lower() == user.lower()
            winner = g.get("winner")
            outcome = "draw" if winner is None else ("win" if (winner == "white") == me_white else "loss")
            yield {
                "source": "lichess",
                "url": f"https://lichess.org/{g['id']}",
                "white": wname, "black": bname,
                "whiteElo": str(players["white"].get("rating", "")),
                "blackElo": str(players["black"].get("rating", "")),
                "myColor": "w" if me_white else "b",
                "outcome": outcome,
                "timeClass": g.get("speed", ""),
                "endTime": (g.get("lastMoveAt") or g.get("createdAt") or 0) // 1000,
                "createdAt": g.get("createdAt") or 0,
                "moves": (len(g.get("moves", "").split()) + 1) // 2 or move_count(g["pgn"]),
                "pgn": g["pgn"],
            }


# --------------------------------------------------------------------------- #

MOVE_NO = re.compile(r"(?:^|\s)(\d+)\.")


def move_count(pgn: str) -> int:
    """Full moves in a PGN (largest move number in the movetext)."""
    movetext = pgn.split("\n\n", 1)[-1]
    nums = [int(n) for n in MOVE_NO.findall(movetext)]
    return max(nums, default=0)


LICHESS_GAME = re.compile(r"lichess\.org/([A-Za-z0-9]{8})")


def from_url(url: str) -> str | None:
    """PGN for a single game URL (Lichess only – Chess.com has no single-game API)."""
    m = LICHESS_GAME.search(url)
    if not m:
        return None
    r = httpx.get(f"https://lichess.org/game/export/{m.group(1)}", headers=UA, timeout=TIMEOUT,
                  params={"clocks": "true", "evals": "false"})
    r.raise_for_status()
    return r.text
