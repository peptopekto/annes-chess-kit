"""Checks of the review maths against the rules it follows (Lichess accuracy, the deeper special-move check)."""
import chess
import chess.engine

from app import analysis, recheck, tactics
from app import classify as C


def test_accuracy_caps_evaluations_like_lichess():
    # White mates in a few (100 %), then plays a slower win at +15 (99.6 %): Lichess caps both at +10 pawns
    # (97.5 %), so that is no loss of accuracy.
    w, _ = C.game_accuracy([50, 99.99, 99.99, 99.6, 99.6, 99.6, 99.6])
    assert w == 100.0
    # Within the cap nothing changes: a real drop still costs accuracy.
    w, _ = C.game_accuracy([50, 50, 50, 20, 20, 20, 20])
    assert w < 80
    # The plain per-move formula (also used for expected-points losses elsewhere) is uncapped.
    assert C.move_accuracy(100.0, 95.0) < 100.0
    assert C.lichess_move_accuracy(100.0, 99.0) == 100.0


def test_older_reviews_get_the_capped_accuracy():
    record = {"winPct": [50, 99.99, 99.99, 99.6, 99.6], "accuracy": {"w": 97.0, "b": 100.0}}
    assert recheck.reaccuracy(record)
    assert record["accuracy"] == dict(zip("wb", C.game_accuracy(record["winPct"])))
    assert not recheck.reaccuracy(record)  # nothing left to change
    # A game set up with Black to move counts Black's moves first.
    fen = "4k3/8/8/8/8/8/8/4K3 b - - 0 1"
    record = {"winPct": [50, 50, 20, 20], "startFen": fen, "accuracy": None}
    recheck.reaccuracy(record)
    assert record["accuracy"]["w"] < record["accuracy"]["b"] == 100.0


def _deep(monkeypatch, top):
    def fake(eng, b, depth, multipv, max_time=None, root_moves=None, game=None, reached=None):
        if root_moves:
            return [next(ln for ln in top if ln.move == root_moves[0])]
        return top[:multipv]
    monkeypatch.setattr(analysis, "analyse_lines", fake)


def test_deep_check_applies_the_review_thresholds(monkeypatch):
    board = chess.Board()
    e4, d4 = board.parse_san("e4"), board.parse_san("d4")
    cp = lambda v: chess.engine.PovScore(chess.engine.Cp(v), chess.WHITE)  # noqa: E731

    def move(cls):
        return {"ply": 1, "san": "e4", "uci": e4.uci(), "fenBefore": board.fen(), "cls": cls, "sacrifice": 3,
                "color": "w", "bestSan": "e4", "bestUci": e4.uci(), "bestLine": ["e4"], "loss": 0}
    # Still the best move deeper, but you're worse after the sacrifice: not Brilliant.
    _deep(monkeypatch, [C.Line(move=e4, score=cp(-150), pv=[e4]), C.Line(move=d4, score=cp(-400), pv=[d4])])
    ms = [move("brilliant")]
    assert analysis.confirm_special(ms, C.LICHESS_K, 16) == [(1, "e4", "brilliant", "best")]
    # The only move, a bit worse but still holding: Great stays.
    _deep(monkeypatch, [C.Line(move=e4, score=cp(-100), pv=[e4]), C.Line(move=d4, score=cp(-600), pv=[d4])])
    ms = [move("great")]
    assert analysis.confirm_special(ms, C.LICHESS_K, 16) == [] and ms[0]["cls"] == "great"
    # The only move, but you're clearly worse with it too: just Best.
    _deep(monkeypatch, [C.Line(move=e4, score=cp(-300), pv=[e4]), C.Line(move=d4, score=cp(-900), pv=[d4])])
    ms = [move("great")]
    assert analysis.confirm_special(ms, C.LICHESS_K, 16) == [(1, "e4", "great", "best")]


def test_missed_tactic_is_named_for_every_mistake():
    # In a lower-rated game a Mistake can lose less than 0.10 expected points; it still gets its tactic named.
    before = chess.Board("4k3/8/8/3q4/8/8/8/3QK3 w - - 0 1")
    after = before.copy()
    after.push_uci("e1e2")
    record = {"moves": [{"ply": 1, "san": "Ke2", "uci": "e1e2", "color": "w", "fenBefore": before.fen(),
                         "fen": after.fen(), "cls": "mistake", "loss": 0.06, "bestSan": "Qxd5", "bestUci": "d1d5",
                         "bestLine": ["Qxd5"]}]}
    tactics.enrich(record)
    assert record["moves"][0]["missed"]["theme"] == "free_piece"
