import chess
import yaml

from app import nightmare as N


def test_every_gambit_line_is_legal_and_complete():
    raw = yaml.safe_load(N.GAMBITS_FILE.read_text(encoding="utf-8"))
    ids = [g["id"] for g in raw]
    assert len(ids) == len(set(ids))
    for g in raw:
        assert g["bot"] in ("w", "b") and g["name"] and g["against"] and g["idea"] and g["lines"]
        bot = chess.WHITE if g["bot"] == "w" else chess.BLACK
        for line in g["lines"]:
            board = chess.Board()
            plays = 0
            for san in line.split():
                plays += board.turn == bot
                board.push_san(san)  # raises if illegal
            assert plays >= 1, g["id"]
    assert {"alien", "englund"} <= set(ids)


def _play(sans):
    b = chess.Board()
    for s in sans.split():
        b.push_san(s)
    return b


def test_bot_plays_the_gambit_by_position_any_move_order():
    # Alien Gambit: after 5...h6 the bot sacrifices on f7
    b = _play("e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6 Ng5 h6")
    mv, g = N.gambit_move(b, ["alien"])
    assert b.san(mv) == "Nxf7" and g["name"] == "Alien Gambit"
    # Same position, other move order (2.Nc3 d5 3.d4)
    b2 = _play("e4 c6 Nc3 d5 d4 dxe4 Nxe4 Nf6 Ng5 h6")
    assert b2.san(N.gambit_move(b2, ["alien"])[0]) == "Nxf7"
    # Not wanted, or off the line: nothing
    assert N.gambit_move(b, ["englund"]) is None
    assert N.gambit_move(_play("e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5"), ["alien"]) is None


def test_englund_as_black_and_the_trap_line():
    b = _play("d4")
    assert b.san(N.gambit_move(b, ["englund"])[0]) == "e5"
    b = _play("d4 e5 dxe5 Nc6 Nf3 Qe7 Bf4 Qb4+ Bd2 Qxb2 Bc3 Bb4 Qd2 Bxc3 Qxc3")
    assert b.san(N.gambit_move(b, ["all"])[0]) == "Qc1#"


def test_choose_prefers_the_gambit(monkeypatch):
    monkeypatch.setattr(N, "profile", lambda: N.Profile(rating=1200, k=0.004, themes={}, theme_counts=[], book={},
                                                        base_err=0.1, games=0, built=0))
    monkeypatch.setattr(N, "maia", lambda lv: (_ for _ in ()).throw(AssertionError("Maia not needed")))
    r = N.choose(["d2d4"], focus=0, gambits=["englund"])
    assert r["san"] == "e5" and r["gambit"]["id"] == "englund"


def _policy(table):
    """A stand-in for Maia at your level: {position after these moves: {reply: probability}}."""
    t = {" ".join(_play(k).fen().split()[:4]): {_play(k).parse_san(m).uci(): p for m, p in v.items()} for k, v in table.items()}
    return lambda board, level: t.get(" ".join(board.fen().split()[:4]), {})


def test_several_gambits_the_bot_keeps_the_likely_ones_alive(monkeypatch):
    # Alien (1.e4 … needs ...c6) or Blackmar-Diemer (1.d4 … needs ...d5): it opens with the one you're likely to allow.
    monkeypatch.setattr(N, "_reply_policy", _policy({"e4": {"c6": 0.9}, "d4": {"d5": 0.1}}))
    mv, g = N.gambit_move(chess.Board(), ["alien", "blackmar-diemer"], level=1200)
    assert chess.Board().san(mv) == "e4" and g["id"] == "alien"
    monkeypatch.setattr(N, "_reply_policy", _policy({"e4": {"c6": 0.05}, "d4": {"d5": 0.8}}))
    mv, g = N.gambit_move(chess.Board(), ["alien", "blackmar-diemer"], level=1200)
    assert chess.Board().san(mv) == "d4" and g["id"] == "blackmar-diemer"


def test_shared_first_move_is_labelled_with_the_likely_gambit(monkeypatch):
    # 1.e4 serves both the Alien and the King's Gambit; you mostly answer 1...e5, so it's heading for the King's Gambit.
    monkeypatch.setattr(N, "_reply_policy", _policy({"e4": {"e5": 0.7, "c6": 0.2}}))
    mv, g = N.gambit_move(chess.Board(), ["alien", "kings-gambit"], level=1200)
    assert chess.Board().san(mv) == "e4" and g["id"] == "kings-gambit"


def test_after_you_leave_one_gambit_another_one_that_fits_is_played():
    # 1.e4 was played for the Alien, but you answered 1...e5: the King's Gambit (also wanted) takes over.
    b = _play("e4 e5")
    mv, g = N.gambit_move(b, ["alien", "kings-gambit"])
    assert b.san(mv) == "f4" and g["id"] == "kings-gambit"
