import chess

from app import endgames as E


def test_mating_material():
    assert E._mating_material(chess.Board("8/8/8/3k4/8/8/2R5/3K4 w - - 0 1"), chess.WHITE)
    assert E._mating_material(chess.Board("8/8/8/3k4/8/8/2BN4/3K4 w - - 0 1"), chess.WHITE)
    assert E._mating_material(chess.Board("8/8/8/3k4/8/8/2BB4/3K4 w - - 0 1"), chess.WHITE)       # c2 + d2: both colours
    assert not E._mating_material(chess.Board("8/8/8/3k4/8/8/1B1B4/3K4 w - - 0 1"), chess.WHITE)  # same colour
    assert not E._mating_material(chess.Board("8/8/8/3k4/8/8/2NN4/3K4 w - - 0 1"), chess.WHITE)
    assert not E._mating_material(chess.Board("8/8/8/3k4/3p4/8/2R5/3K4 w - - 0 1"), chess.WHITE)  # not a bare king


def test_status_rules():
    kq, kkp, kpk = E.BY_ID["kq"], E.BY_ID["kkp"], E.BY_ID["kpk"]
    win = E.Verdict("win", 900, None, None)
    draw = E.Verdict("draw", 0, None, None)
    mate = chess.Board("k1Q5/8/1K6/8/8/8/8/8 b - - 0 1")
    assert E._status(kq, mate, chess.WHITE, 1, 5, None)["result"] == "success"
    stalemate = chess.Board("k7/2Q5/1K6/8/8/8/8/8 b - - 0 1")
    assert E._status(kq, stalemate, chess.WHITE, 1, 5, None)["result"] == "fail"
    assert E._status(kkp, chess.Board("8/8/8/3k4/8/8/8/3K4 w - - 0 1"), chess.WHITE, 0, 3, None)["result"] == "success"
    promoted = chess.Board("4Q3/8/4K3/8/8/8/8/k7 b - - 0 1")
    assert E._status(kpk, promoted, chess.WHITE, 0, 6, win)["result"] == "success"
    assert E._status(kpk, promoted, chess.WHITE, 0, 6, draw) is None
    held = chess.Board("8/8/8/3k4/3P4/8/8/3K4 w - - 0 1")
    assert E._status(kkp, held, chess.BLACK, 0, kkp.survive, draw)["result"] == "success"
    assert E._status(kkp, held, chess.BLACK, 0, kkp.survive - 1, draw) is None


def test_placement_rules():
    # Defending king outside the pawn's square: a plain race, not a drill.
    assert not E._rule_ok("kpk", chess.Board("7k/8/8/8/8/8/P7/K7 w - - 0 1"))
    assert E._rule_ok("kpk", chess.Board("8/8/2k5/8/8/8/P7/K7 w - - 0 1"))
    # Stop-the-pawn: an undefended pawn next to your king would just be taken.
    assert not E._rule_ok("kkp", chess.Board("8/8/8/8/8/3p4/3K4/6k1 w - - 0 1"))
    assert E._rule_ok("kkp", chess.Board("8/8/8/8/4k3/3p4/8/3K4 w - - 0 1"))


def test_drills_are_consistent():
    for d in E.DRILLS:
        assert d.goal in E.GOALS
        assert bool(d.fens) != bool(d.you), d.id
        assert d.goal != "draw" or d.survive > 0, d.id
        for fen in d.fens:
            assert chess.Board(fen).is_valid(), d.id


def _mate_in(b, n, checks_only=False):
    """Is there a forced mate for the side to move in at most n moves? (small brute force, no engine)"""
    for m in list(b.legal_moves):
        if checks_only and not b.gives_check(m):
            continue
        b.push(m)
        ok = b.is_checkmate() or (n > 1 and not b.is_game_over() and all(_after_reply(b, r, n - 1, checks_only) for r in list(b.legal_moves)))
        b.pop()
        if ok:
            return True
    return False


def _after_reply(b, r, n, checks_only):
    b.push(r)
    try:
        return _mate_in(b, n, checks_only)
    finally:
        b.pop()


def test_mating_patterns_are_forced_mates():
    two = ["backrank", "arabian", "anastasia", "boden", "legal"]
    for drill in two:
        b = chess.Board(E.BY_ID[drill].fens[0])
        assert _mate_in(b, 2) and not _mate_in(b, 1), drill
    sm = chess.Board(E.BY_ID["smothered"].fens[0])
    assert _mate_in(sm, 5, checks_only=True) and not _mate_in(sm, 4, checks_only=True) and not _mate_in(sm, 3)
    # the Légal position is the real trap
    assert E.BY_ID["legal"].fens[0].startswith("rn1qkbnr/ppp2p1p/3p2p1/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w")


def test_new_placement_rules():
    # Rook vs pawn: the pawn with its king, your king some way off.
    assert E._rule_ok("rvp", chess.Board("R7/8/8/7K/8/2pk4/8/8 w - - 0 1"))
    assert not E._rule_ok("rvp", chess.Board("R7/8/8/4K3/8/2pk4/8/8 w - - 0 1"))   # your king already close
    # Wrong bishop: the a-pawn queens on a1 (dark), the bishop is light-squared, your king can reach the corner.
    assert E._rule_ok("wrongb", chess.Board("8/8/8/p7/8/2K5/4b3/6k1 w - - 0 1"))
    assert not E._rule_ok("wrongb", chess.Board("8/8/8/p7/8/2K5/5b2/6k1 w - - 0 1"))  # dark bishop: the right one
    # Opposite-coloured bishops only.
    assert E._rule_ok("ocb", chess.Board("8/8/3k4/2pp4/8/3b4/1B6/4K3 w - - 0 1"))
    assert not E._rule_ok("ocb", chess.Board("8/8/3k4/2pp4/8/8/1B1b4/4K3 w - - 0 1"))


def test_every_drill_has_a_lesson():
    L = E.lessons()
    assert set(L) == {d.id for d in E.DRILLS}
    for k, v in L.items():
        assert v["idea"] and len(v["steps"]) >= 2, k
        assert all(isinstance(x, str) and x for x in v["steps"] + v.get("spot", []) + v.get("mistakes", [])), k
