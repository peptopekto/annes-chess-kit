import json
import math

import chess
import chess.pgn
import pytest

from app import classify as C
from app import nightmare, peers


def _side(n=40, acc=80.0, blunders=0, elo=1000, outcome="win", **extra):
    s = peers._empty_side()
    s.update(n=n, acc=acc, elo=elo, outcome=outcome)
    s["cls"][C.BLUNDER] = blunders
    s["cls"][C.BEST] = n - blunders
    s.update(extra)
    return s


def _fact(i, me_elo, opp_elo, me_blunders=1, opp_blunders=3, source="chess.com"):
    return {"id": f"g{i}", "ts": 1_700_000_000 + i, "tc": "rapid", "white": "me", "black": f"opp{i}",
            "source": source, "w": _side(blunders=me_blunders, elo=me_elo),
            "b": _side(blunders=opp_blunders, elo=opp_elo, outcome="loss")}


def test_ratio_and_its_standard_error():
    sides = [_side(n=40, blunders=2), _side(n=60, blunders=1), _side(n=50, blunders=3)]
    s = peers._stat(sides, peers._per100(C.BLUNDER))
    assert s["games"] == 3 and s["value"] == pytest.approx(600 / 150)
    # cluster-robust SE of a ratio: sqrt( Σ(num - r·den)² / (G(G-1)) ) / mean den
    r = 4.0
    resid = [(200 - r * 40), (100 - r * 60), (300 - r * 50)]
    expect = math.sqrt(sum(x * x for x in resid) / (3 * 2)) / 50
    assert s["se"] == pytest.approx(expect)
    assert peers._stat([], peers._per100(C.BLUNDER)) is None


def test_z_points_the_right_way():
    a = {"value": 2.0, "se": 0.5, "games": 50}
    b = {"value": 4.0, "se": 0.5, "games": 50}
    assert peers._z(a, b, "lower") == pytest.approx(2 / math.sqrt(0.5), abs=0.01)   # fewer blunders: better
    assert peers._z(a, b, "higher") == pytest.approx(-2 / math.sqrt(0.5), abs=0.01)
    assert peers._z(a, b, None) is None


def test_groups_findings_and_expected_score(monkeypatch):
    facts = [_fact(i, 1000, 1000 + (i % 3 - 1) * 40) for i in range(40)]           # your level
    facts += [_fact(100 + i, 1000, 1250, opp_blunders=0) for i in range(20)]        # stronger, never blunder
    facts += [_fact(200 + i, 1000, 700, opp_blunders=6) for i in range(20)]         # weaker
    facts += [_fact(300 + i, 1000, 1600) for i in range(5)]                          # too far: left out
    # one game with a varying blunder count so the standard errors aren't zero
    for k, f in enumerate(facts):
        f["w"]["cls"][C.BLUNDER] = 1 + k % 2
        f["b"]["cls"][C.BLUNDER] += k % 2
    monkeypatch.setattr(peers, "_all_facts", lambda: facts)
    monkeypatch.setattr(peers, "my_names", lambda: {"me"})
    r = peers._compute("all", 0, 100)
    assert r["games"] == 85
    assert {k: v["games"] for k, v in r["groups"].items()} == {"level": 40, "stronger": 20, "weaker": 20}
    lvl = r["groups"]["level"]["results"]
    assert lvl["score"] == 100.0 and 49 < lvl["expected"] < 51
    strong = r["groups"]["stronger"]["results"]
    assert strong["expected"] == pytest.approx(100 / (1 + 10 ** (250 / 400)), abs=0.1)
    row = next(m for m in r["metrics"] if m["key"] == "blunders")
    assert row["you"] < row["level"] and row["vsLevel"] > 2                         # you blunder less: a strength
    assert any(f["key"] == "blunders" for f in r["findings"]["strengths"])
    assert r["platforms"] == ["chess.com"] and r["curve"]["chess.com"]


def test_bot_and_unrated_games_are_left_out(monkeypatch):
    f = _fact(1, 1000, 1000)
    f["b"]["elo"] = None
    monkeypatch.setattr(peers, "_all_facts", lambda: [f])
    monkeypatch.setattr(peers, "my_names", lambda: {"me"})
    assert peers._compute("all", 0, 100)["games"] == 0
    assert peers.facts({"source": "nightmare", "moves": [{}], "winPct": [50, 50]}) is None


def test_facts_from_a_review():
    # A tiny "review": 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#
    sans = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"]
    board, moves = chess.Board(), []
    wins = [50, 52, 50, 55, 50, 58, 2, 100]
    for i, san in enumerate(sans):
        before = board.fen()
        mv = board.parse_san(san)
        board.push(mv)
        bad = san == "Nf6"
        moves.append({"ply": i + 1, "san": san, "uci": mv.uci(), "color": "w" if i % 2 == 0 else "b",
                      "fenBefore": before, "fen": board.fen(), "cls": C.BLUNDER if bad else C.BEST,
                      "loss": 0.5 if bad else 0.0, "bestUci": "g7g6" if bad else mv.uci(),
                      "bestSan": "g6" if bad else san, "bestLine": ["g6"] if bad else [san],
                      "bestEval": {"cp": 50}, "eval": {"mate": 1} if bad else {"cp": 30}})
    record = {"id": "x", "white": "Me", "black": "Opp", "whiteElo": "1000", "blackElo": "980", "result": "1-0",
              "date": "2026.11.01", "headers": {"TimeControl": "600"}, "accuracy": {"w": 95.0, "b": 40.0},
              "moves": moves, "winPct": wins, "source": "lichess", "pgn": ""}
    f = peers.facts(record)
    assert f["w"]["n"] == 4 and f["b"]["n"] == 3
    assert f["b"]["cls"][C.BLUNDER] == 1 and f["b"]["tags"]["allowed_mate"] == 1
    assert f["b"]["firstError"] == 3 and f["w"]["firstError"] is None
    assert f["w"]["outcome"] == "win" and f["b"]["outcome"] == "loss" and f["w"]["elo"] == 1000
    assert f["w"]["chances"] == 1 and f["w"]["punished"] == 1                       # Qxf7# punished Nf6??
    assert f["w"]["habits"]["earlyQueen"] is True


def test_bot_games_list(tmp_path, monkeypatch):
    monkeypatch.setattr(nightmare, "STATS_FILE", tmp_path / "nightmare.json")
    monkeypatch.setattr(nightmare, "summary", lambda: {})
    monkeypatch.setattr(nightmare.storage, "summaries", lambda: [
        {"id": "old1", "source": "nightmare", "me": "b", "white": "Nightmare (Maia 1500)", "black": "me",
         "result": "0-1", "plies": 41, "playedAt": 100, "accuracy": {"b": 88.0}, "counts": {"b": {}}},
        {"id": "other", "source": "lichess"}])
    nightmare.finish("draw", "w", 1300, 1, 0, 0, "[White \"me\"]\n[Black \"Nightmare (Maia 1300)\"]\n\n*")
    nightmare.finish("loss", "w", 1100, 0, 0, 12)                                   # no PGN: not listed
    rows = nightmare.bot_games()
    assert [r["result"] for r in rows] == ["draw", "win"]
    assert rows[0]["pgn"] and rows[0]["review"] is None and rows[0]["level"] == 1300
    assert rows[1]["review"]["id"] == "old1" and rows[1]["level"] == 1500 and rows[1]["moves"] == 21
    assert json.loads((tmp_path / "nightmare.json").read_text())["games"][0]["id"]
