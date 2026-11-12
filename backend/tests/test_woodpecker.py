import chess

from app import woodpecker


def test_material_puzzle_must_win_material():
    # Nd6+ forks king and queen, and the line goes on to win the queen: it pays off.
    board = chess.Board("2q1k3/8/8/5N2/8/8/8/4K3 w - - 0 1")
    assert woodpecker.pays_off(board, "fork", ["f5d6"], ["Nd6+", "Ke7", "Nxc8+"])
    # The same "fork", but the line never wins anything: not a puzzle with a point.
    assert not woodpecker.pays_off(board, "fork", ["f5d6"], ["Nd6+", "Ke7", "Nb5"])


def test_mate_puzzle_must_end_in_mate():
    board = chess.Board("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")
    assert woodpecker.pays_off(board, "back_rank", ["a1a8"], [])
    assert not woodpecker.pays_off(board, "mate", ["a1a7"], [])


def _puzzle():
    # Black's setup move, then White to find Ra8#.
    return {"fen": "6k1/1p3ppp/8/8/8/8/8/R5K1 b - - 0 1", "moves": ["b7b6", "a1a8"], "_mate": None}


def test_unconfirmed_or_ambiguous_puzzles_are_dropped(monkeypatch):
    p = {"fen": "4k3/8/8/8/8/8/3n4/R3K3 b - - 0 1", "moves": ["d2b3", "a1a8"], "_mate": None}
    # The deeper search confirms the solution and nothing else is as good: kept, with its answers.
    monkeypatch.setattr(woodpecker, "_step", lambda fen, left: (["a1a8"], True))
    assert woodpecker._finish(dict(p))["altSteps"] == [["a1a8"]]
    # The deeper search prefers other moves: the stored solution doesn't hold up.
    monkeypatch.setattr(woodpecker, "_step", lambda fen, left: (["e1d2"], True))
    assert woodpecker._finish(dict(p)) is None
    # Other moves are nearly as good: no single clear point to find.
    monkeypatch.setattr(woodpecker, "_step", lambda fen, left: (["a1a8"], False))
    assert woodpecker._finish(dict(p)) is None
    # A mating solution is always confirmed (any mate solves it).
    monkeypatch.setattr(woodpecker, "_step", lambda fen, left: ([], True))
    assert woodpecker._finish(_puzzle()) is not None


def test_setup_move_must_not_be_an_opponent_error():
    assert woodpecker.setup_is_sound({"cls": "best", "loss": 0.0}, 1.0)
    assert woodpecker.setup_is_sound({"cls": "good", "loss": 0.03}, 1.0)
    # They hung a rook / missed the mate you allowed: the position only exists because they erred.
    assert not woodpecker.setup_is_sound({"cls": "blunder", "loss": 0.45}, 1.0)
    assert not woodpecker.setup_is_sound({"cls": "miss", "loss": 0.3}, 1.0)
    assert not woodpecker.setup_is_sound({"cls": "excellent", "loss": 0.12}, 1.0)
    # An inaccuracy is an ordinary move, not a gift.
    assert woodpecker.setup_is_sound({"cls": "inaccuracy", "loss": 0.06}, 1.0)


def test_opponent_replies_must_be_stockfishs(monkeypatch):
    # Setup ...Kd8, then White Ra8+, Black's reply, White's second move.
    p = {"fen": "4k3/8/8/8/8/8/8/R3K2R b - - 0 1", "moves": ["e8d8", "a1a8", "d8c7", "h1h7"], "_mate": None}
    monkeypatch.setattr(woodpecker, "_step", lambda fen, left: (["a1a8", "h1h7"], True))
    monkeypatch.setattr(woodpecker, "_reply_ok", lambda fen, uci: True)
    assert woodpecker._finish(dict(p)) is not None
    # Stockfish would defend differently: the line isn't forced, so no puzzle.
    monkeypatch.setattr(woodpecker, "_reply_ok", lambda fen, uci: False)
    assert woodpecker._finish(dict(p)) is None


# --------------------------------------------------------------------------- #
#  Recurring patterns
# --------------------------------------------------------------------------- #

from types import SimpleNamespace


def _game(gid, ts, moves):
    return SimpleNamespace(record={"id": gid}, ts=ts, moves=moves)


def _mistake(ply, missed=None, fell=None, loss=0.3, fen="8/8/8/8/8/8/8/K6k w - - 0 1", san="Kb1"):
    return {"ply": ply, "cls": "blunder", "loss": loss, "missed": missed, "fellFor": fell,
            "fenBefore": fen, "san": san}


def test_pattern_keys_split_missed_and_allowed():
    assert woodpecker.pattern_keys({"missed": "fork", "fellFor": None}) == ["fork"]
    assert woodpecker.pattern_keys({"missed": "back_rank", "fellFor": "mate"}) == ["mate", "stop_mate"]
    assert woodpecker.pattern_keys({"missed": None, "fellFor": "pin"}) == ["save_piece"]
    assert woodpecker.pattern_keys({"missed": None, "fellFor": None}) == []


def test_patterns_weigh_recent_mistakes_and_find_repeats():
    now = 1_000_000_000.0
    year = 365 * 86400
    games = [
        _game("a", now, [_mistake(10, missed="fork", fen="r/1 w - -", san="Nc3")]),
        _game("b", now - year, [_mistake(12, missed="fork", fen="r/1 w - -", san="Nc3")]),
        _game("c", now, [_mistake(8, fell="mate", loss=0.05)]),  # too cheap to count
    ]
    stats, repeats = woodpecker.patterns(games, now=now)
    assert stats["fork"]["count"] == 2 and len(stats["fork"]["games"]) == 2
    assert 0.3 < stats["fork"]["weight"] < 0.6   # last year's mistake counts about a quarter
    assert "stop_mate" not in stats
    assert len(repeats[("r/1 w - -", "Nc3")]) == 2   # same position, same move, two games


def test_quotas_follow_cost_but_stay_balanced():
    stats = {"free_piece": {"count": 300, "weight": 80.0}, "fork": {"count": 40, "weight": 15.0},
             "pin": {"count": 6, "weight": 5.0}, "skewer": {"count": 2, "weight": 9.0}}
    q = woodpecker.quotas(stats, 50)
    assert "skewer" not in q                 # 2 mistakes: not a pattern of yours yet
    assert q["free_piece"] == 20             # capped at 40 % of the set
    assert q["fork"] > q["pin"] >= woodpecker.MIN_PER_PATTERN


def test_interleave_mixes_patterns():
    ps = [{"pattern": {"key": k}} for k in ["a"] * 4 + ["b"] * 2]
    order = [p["pattern"]["key"] for p in woodpecker._interleave(ps)]
    assert sorted(order) == ["a"] * 4 + ["b"] * 2
    assert order[:4] == ["a", "b", "a", "b"]
