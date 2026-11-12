import contextlib

import chess
import chess.engine

from app import analysis, engine


def test_refuter_takes_limits_or_a_plain_depth(monkeypatch):
    # The Brilliant re-check passed a plain depth, and every check crashed on limits.depth.
    seen = []

    @contextlib.contextmanager
    def fake_acquire():
        yield object()

    def fake_lines(eng, board, depth, multipv=1, max_time=None, game=None):
        seen.append((depth, max_time))
        return [type("L", (), {"score": chess.engine.PovScore(chess.engine.Cp(30), board.turn), "pv": []})()]

    monkeypatch.setattr(engine.batch, "acquire", fake_acquire)
    monkeypatch.setattr(analysis, "analyse_lines", fake_lines)
    board = chess.Board()
    for limits in (16, analysis.Limits(depth=16)):
        score, pv = analysis.refuter(limits)(board)
        assert score.relative == chess.engine.Cp(30) and pv == []
    assert seen == [(16, analysis.Limits().time_cap)] * 2
