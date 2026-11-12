from app import config, engine, main
from app.analysis import BATCH_TIME_CAP, Limits, limits_text


def test_limits_cover_existing_reviews():
    assert Limits(depth=16).covers({"depth": 18})
    assert not Limits(depth=20).covers({"depth": 16})
    # A time-limited review counts with the depth it actually reached.
    assert Limits(depth=20).covers({"depth": 30, "moveTime": 1.0, "depthReached": 22.5})
    assert not Limits(depth=24).covers({"depth": 30, "moveTime": 1.0, "depthReached": 22.5})
    # In time mode existing reviews are kept (redo one with "Re-analyze").
    assert Limits(depth=30, move_time=2.0).covers({"depth": 12})


def test_time_cap():
    assert Limits(depth=16).time_cap == BATCH_TIME_CAP
    assert Limits(depth=30, move_time=1.0).time_cap == 1.0


def test_limits_from_settings(monkeypatch):
    settings = dict(config.DEFAULT_SETTINGS)
    monkeypatch.setattr(main, "load_settings", lambda: settings)
    assert main._limits() == Limits(depth=16)
    settings.update(analysis_mode="time", move_time=1.5, max_depth=28)
    assert main._limits() == Limits(depth=28, move_time=1.5)
    assert main._limits(depth=22) == Limits(depth=22)                    # "Re-analyze deeper": fixed depth
    assert main._limits(move_time=3.0) == Limits(depth=28, move_time=3.0)
    assert main._limits(depth=99) == Limits(depth=30)                    # clamped


def test_settings_are_validated():
    cur = config.DEFAULT_SETTINGS
    assert config._clean("depth", 99, cur["depth"]) == 30
    assert config._clean("depth", "nonsense", 16) == 16
    assert config._clean("move_time", 0, 1.0) == 0.1
    assert config._clean("analysis_mode", "fast", "depth") == "depth"
    assert config._clean("aliases", [" otb ", ""], []) == ["otb"]


def test_limits_text():
    assert limits_text({"depth": 16}) == "depth 16"
    assert limits_text({"depth": 30, "moveTime": 1.0, "depthReached": 22.5}) == "1 s per move, avg depth 22.5"


def test_pool_resizes():
    pool = engine.EnginePool(size=3, threads=1, hash_mb=16)   # engines start lazily: no processes here
    pool.resize(5)
    assert pool.size == 5 and len(pool.engines) == 5
    with pool.acquire(), pool.acquire():   # two engines busy, three idle
        pool.resize(1)                     # the idle surplus goes at once…
        assert pool.size == 1 and len(pool.engines) == 2
    assert len(pool.engines) == 1          # …and a busy one when it's released
    assert engine.engines_for(0) == engine.AUTO_ENGINES
    assert engine.engines_for(10_000) == engine.CPUS


def test_only_local_hosts_are_served():
    from fastapi.testclient import TestClient
    client = TestClient(main.app)  # no `with`: the startup work (engines, caches) doesn't run
    assert client.post("/api/ping").status_code == 200
    assert client.post("/api/ping", headers={"host": "127.0.0.1:8765"}).status_code == 200
    assert client.post("/api/ping", headers={"host": "evil.example"}).status_code == 400  # DNS rebinding


def test_checkmate_eval_says_who_won():
    import chess
    import chess.engine
    from app.analysis import eval_json, fill_mate_winner
    assert eval_json(chess.engine.PovScore(chess.engine.Mate(0), chess.BLACK)) == {"mate": 0, "winner": "w"}
    assert eval_json(chess.engine.PovScore(chess.engine.Mate(0), chess.WHITE)) == {"mate": 0, "winner": "b"}
    rec = fill_mate_winner({"moves": [{"color": "b", "eval": {"mate": 0}}]})
    assert rec["moves"][0]["eval"] == {"mate": 0, "winner": "b"}


def test_first_special_check_is_tidied():
    from app import analysis, recheck, classify as C
    record = {"specialCheck": 1, "moves": [
        {"cls": "good", "loss": 0.12, "bestUci": "d2d4", "secondUci": "d2d4"},
        {"cls": "good", "loss": 0.03, "bestUci": "e2e4", "secondUci": "d2d4"},
    ]}
    assert recheck._tidy_special(record)
    assert record["moves"][0]["secondUci"] is None and record["moves"][0]["loss"] < C.GOOD_MAX
    assert record["moves"][1] == {"cls": "good", "loss": 0.03, "bestUci": "e2e4", "secondUci": "d2d4"}
    assert record["specialCheck"] == analysis.SPECIAL_CHECK
    assert not recheck._tidy_special(record)            # done once
    assert not recheck._tidy_special({"moves": []})     # never checked: needs the engine, not a tidy-up


def test_special_moves_are_confirmed_deeper(monkeypatch):
    import chess
    import chess.engine
    from app import analysis, classify as C
    board = chess.Board()
    e4, d4 = board.parse_san("e4"), board.parse_san("d4")
    cp = lambda v: chess.engine.PovScore(chess.engine.Cp(v), chess.WHITE)  # noqa: E731
    deep = {"top": [C.Line(move=d4, score=cp(100), pv=[d4]), C.Line(move=e4, score=cp(-200), pv=[e4])]}

    def fake(eng, b, depth, multipv, max_time=None, root_moves=None, game=None, reached=None):
        if root_moves:
            return [next(ln for ln in deep["top"] if ln.move == root_moves[0])]
        return deep["top"][:multipv]
    monkeypatch.setattr(analysis, "analyse_lines", fake)

    def move(cls):
        return {"ply": 1, "san": "e4", "uci": e4.uci(), "fenBefore": board.fen(), "cls": cls, "sacrifice": 3,
                "color": "w", "bestSan": "e4", "bestUci": e4.uci(), "bestLine": ["e4"], "loss": 0}
    # Deeper, e4 is clearly worse than d4: the "brilliant" becomes Good, and d4 is shown as best.
    ms = [move("brilliant")]
    assert analysis.confirm_special(ms, C.LICHESS_K, 16) == [(1, "e4", "brilliant", "good")]
    assert ms[0]["bestSan"] == "d4" and ms[0]["sacrifice"] == 0
    # e4 is best deeper too, with a big gap to the next move: Great holds.
    deep["top"] = [C.Line(move=e4, score=cp(100), pv=[e4]), C.Line(move=d4, score=cp(-300), pv=[d4])]
    ms = [move("great")]
    assert analysis.confirm_special(ms, C.LICHESS_K, 16) == [] and ms[0]["cls"] == "great"
    # Best, but another move is just as good: not the only good move, so plain Best.
    deep["top"] = [C.Line(move=e4, score=cp(100), pv=[e4]), C.Line(move=d4, score=cp(95), pv=[d4])]
    ms = [move("great")]
    assert analysis.confirm_special(ms, C.LICHESS_K, 16) == [(1, "e4", "great", "best")]
