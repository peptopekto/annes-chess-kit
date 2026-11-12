import chess
import chess.pgn
import pytest

from app import botprogress as B
from app import classify as C


@pytest.fixture(autouse=True)
def _file(tmp_path, monkeypatch):
    monkeypatch.setattr(B, "FILE", tmp_path / "bot_progress.json")


def test_levels():
    assert [B.xp_for_level(n) for n in (1, 2, 3, 4, 5)] == [0, 100, 300, 600, 1000]
    assert [B.level_of(x) for x in (0, 99, 100, 299, 300, 600, 999, 1000)] == [1, 1, 2, 2, 3, 4, 4, 5]
    info = B.level_info(450)
    assert info["level"] == 3 and info["into"] == 150 and info["needed"] == 300 and info["title"] == "Apprentice"


def test_xp():
    assert B.game_xp("win", 0, {}, 0) == 100
    assert B.game_xp("win", 400, {}, 0) == 200          # stronger bot: more
    assert B.game_xp("win", -200, {}, 0) == 50
    assert B.game_xp("loss", 0, {C.BEST: 20, C.MISTAKE: 1}, 0) == 10
    # clean game bonus + a brilliant move, halved for takebacks
    assert B.game_xp("draw", 0, {C.BEST: 20, C.BRILLIANT: 1}, 0) == 40 + 25 + 20
    assert B.game_xp("draw", 0, {C.BEST: 20, C.BRILLIANT: 1}, 2) == 42


def _mark(board, san, cls, loss=0.0):
    mv = board.parse_san(san)
    return {"uci": mv.uci(), "cls": cls, "loss": loss}


def test_record_summary_and_reset(monkeypatch):
    # White: 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6 4.Qxf7#  – marks for all of White's moves, so no engine is needed
    sans = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"]
    board, marks = chess.Board(), {}
    cls = {1: C.BOOK, 3: C.INACCURACY, 5: C.BEST, 7: C.GREAT}
    for i, san in enumerate(sans, 1):
        if i in cls:
            marks[i] = _mark(board, san, cls[i], 0.05 if cls[i] == C.INACCURACY else 0.0)
        board.push_san(san)
    game = chess.pgn.Game.from_board(board)
    monkeypatch.setattr(B.analysis, "check_move", lambda *a, **k: pytest.fail("all moves were rated already"))
    r = B.record("win", "w", 1300, 100, 0.0, str(game), marks)
    assert r["gained"] == int(round(100 * 1.25)) + 10 + 20      # win vs +100, a Great move, clean game
    assert r["collected"][0]["san"] == "Qxf7#" and r["collected"][0]["cls"] == C.GREAT
    s = B.summary()
    assert s["record"] == {"played": 1, "won": 1, "drawn": 0, "lost": 0}
    assert s["counts"] == {C.BOOK: 1, C.INACCURACY: 1, C.BEST: 1, C.GREAT: 1}
    assert s["levels"] == [{"maia": 1300, "games": 1, "score": 100.0, "accuracy": s["accuracy"]}]
    assert 80 < s["accuracy"] < 100 and s["collectionSize"] == 1
    assert {a["id"]: a["earned"] for a in s["achievements"]}["first-win"]
    assert s["xp"] == r["gained"]
    s = B.reset()
    assert s["xp"] == 0 and s["record"]["played"] == 0 and s["collection"] == []


def test_unrated_moves_are_rated_at_the_end(monkeypatch):
    board = chess.Board()
    for san in ["d4", "d5", "c4"]:
        board.push_san(san)
    game = chess.pgn.Game.from_board(board)
    calls = []

    def check(fen, uci, depth, k, prev_uci, prev_loss, book=False):
        calls.append((uci, depth, book))
        return {"cls": C.BEST, "loss": 0.0}
    monkeypatch.setattr(B.analysis, "check_move", check)
    r = B.record("draw", "w", 1500, 0, 0.6, str(game), {})
    assert [c[0] for c in calls] == ["d2d4", "c2c4"] and calls[0][1] == B.SCORE_DEPTH and calls[0][2]
    assert r["game"]["counts"] == {C.BEST: 2}


def test_game_from_a_position_with_black_to_move(monkeypatch):
    # Convert practice: the game starts from a set-up position, Black (you) to move – ply 1 is yours.
    board = chess.Board("6k1/5ppp/8/8/8/8/q4PPP/6K1 b - - 0 30")
    game = chess.pgn.Game()
    game.setup(board)
    node = game
    for san in ["Qa1#"]:
        mv = node.board().parse_san(san)
        node = node.add_variation(mv)
    marks = {1: {"uci": "a2a1", "cls": C.BEST, "loss": 0.0}}
    monkeypatch.setattr(B.analysis, "check_move", lambda *a, **k: pytest.fail("your only move was rated already"))
    r = B.record("win", "b", 1300, 0, 0.0, str(game), marks, mode="convert")
    assert r["game"]["counts"] == {C.BEST: 1} and r["game"]["mode"] == "convert"
    s = B.summary()
    assert s["convert"] == {"tried": 1, "positions": 1, "won": 1, "drawn": 0, "lost": 0}
    assert {a["id"]: a["earned"] for a in s["achievements"]}["convert-1"]


def _mate_game():
    board = chess.Board("6k1/5ppp/8/8/8/8/q4PPP/6K1 b - - 0 30")
    game = chess.pgn.Game()
    game.setup(board)
    game.add_variation(board.parse_san("Qa1#"))
    return str(game), {1: {"uci": "a2a1", "cls": C.GREAT, "loss": 0.0}}


def test_a_convert_position_pays_once(monkeypatch):
    pgn, marks = _mate_game()
    monkeypatch.setattr(B.analysis, "check_move", lambda *a, **k: pytest.fail("rated already"))
    full = B.game_xp("win", 0, {C.GREAT: 1}, 0)
    first = B.record("win", "b", 1300, 0, 0.0, pgn, marks, takebacks=2, mode="convert", spot="g1-40")
    assert first["gained"] == first["earned"] == full // 2 and not first["repeat"]
    again = B.record("win", "b", 1300, 0, 0.0, pgn, marks, mode="convert", spot="g1-40")
    assert again["earned"] == full and again["gained"] == full - full // 2 and again["repeat"]  # only the improvement
    third = B.record("win", "b", 1300, 0, 0.0, pgn, marks, mode="convert", spot="g1-40")
    assert third["gained"] == 0 and third["previous"] == full
    other = B.record("win", "b", 1300, 0, 0.0, pgn, marks, mode="convert", spot="g2-12")
    assert other["gained"] == full                                   # a different position pays normally
    s = B.summary()
    assert s["xp"] == 2 * full and s["convert"]["tried"] == 4 and s["convert"]["positions"] == 2 and s["convert"]["won"] == 2
    assert s["collectionSize"] == 1                                  # the same move isn't collected twice
    st = B.convert_status()
    assert st["g1-40"] == {"tries": 3, "best": "win", "xp": full}


def test_exploring_counts_like_a_takeback():
    assert B.game_xp("win", 0, {}, 0, explored=True) == 50
    assert B.game_xp("win", 0, {}, 3, explored=True) == 50


def test_duplicates_in_an_older_file_are_shown_once():
    move = {"at": 1, "ply": 1, "fen": "8/8/8/8/8/8/8/K6k w - - 0 1", "san": "Ka2", "uci": "a1a2", "cls": C.GREAT, "maia": 1300, "color": "w"}
    B._write({"xp": 0, "games": [], "collection": [move, {**move, "at": 2}], "since": 0})
    s = B.summary()
    assert s["collectionSize"] == 1 and s["collection"][0]["at"] == 1
