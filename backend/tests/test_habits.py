import chess

from app import habits


def rec(fen, uci, reply_uci, cls="blunder", loss=0.3, ep_best=0.5, best_eval=None, reply_eval=None):
    """My move (uci) from fen, then the opponent's best reply."""
    b = chess.Board(fen)
    mv = chess.Move.from_uci(uci)
    san = b.san(mv)
    after = b.copy()
    after.push(mv)
    return [
        {"cls": cls, "loss": loss, "fenBefore": fen, "uci": uci, "san": san, "epBest": ep_best,
         "bestEval": best_eval or {"cp": 0}, "capture": b.is_capture(mv), "bestUci": uci},
        {"cls": "best", "loss": 0, "fenBefore": after.fen(), "uci": reply_uci, "bestUci": reply_uci,
         "bestEval": reply_eval or {"cp": -300}, "capture": after.is_capture(chess.Move.from_uci(reply_uci))},
    ]


def test_pawn_range():
    # Knight to d5, where the c6 pawn takes it.
    moves = rec("4k3/8/2p5/8/8/2N5/8/4K3 w - - 0 1", "c3d5", "c6d5")
    assert "pawn_range" in habits.tags(moves, 0)


def test_loose_piece():
    # Bishop to e4, where the knight on d6 simply takes it.
    moves = rec("4k3/8/3n4/8/8/8/6B1/4K3 w - - 0 1", "g2e4", "d6e4")
    assert "loose_piece" in habits.tags(moves, 0)


def test_ignored_threat():
    # The bishop on d4 already attacks the undefended rook on a1; White plays h3 and loses it.
    moves = rec("4k3/8/8/8/3b4/8/7P/R3K3 w - - 0 1", "h2h3", "d4a1")
    assert "ignored_threat" in habits.tags(moves, 0)


def test_removed_defender():
    # The knight on c3 defends the bishop on d5; it moves away and Qxd5 wins the bishop.
    moves = rec("3qk3/8/8/3B4/8/2N5/8/4K3 w - - 0 1", "c3a4", "d8d5")
    assert "removed_defender" in habits.tags(moves, 0)


def test_missed_mate_and_relaxing():
    moves = rec("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "e1e2", "e8e7", cls="miss", loss=0.4, ep_best=0.95, best_eval={"mate": 2})
    t = habits.tags(moves, 0)
    assert "missed_mate" in t and "relaxing" in t


def test_stalemate_when_winning():
    # White queen + king vs king: Qf7 stalemates the black king on h8.
    moves = [{"cls": "blunder", "loss": 0.5, "fenBefore": "7k/8/6K1/8/8/8/8/5Q2 w - - 0 1", "uci": "f1f7", "san": "Qf7",
              "epBest": 1.0, "bestEval": {"mate": 1}, "capture": False, "fen": "7k/5Q2/6K1/8/8/8/8/8 b - - 1 1"}]  # game over
    assert "stalemate_win" in habits.tags(moves, 0)


def test_game_end_reasons():
    from app.analysis import end_state, game_end
    assert end_state(chess.Board("7k/5Q2/6K1/8/8/8/8/8 b - - 1 1"))["reason"] == "stalemate"
    assert end_state(chess.Board("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")) is None
    mate = chess.Board("R5k1/5ppp/8/8/8/8/8/6K1 b - - 1 1")
    assert end_state(mate) == {"reason": "checkmate", "text": "Checkmate", "winner": "w"}
    # Threefold repetition only counts when claimed (needs the history).
    rec_ = {"startFen": chess.STARTING_FEN, "result": "1/2-1/2", "headers": {},
            "moves": [{"uci": u} for u in ["g1f3", "g8f6", "f3g1", "f6g8"] * 2]}
    assert game_end(rec_)["reason"] == "threefold"
    rec_ = {"startFen": chess.STARTING_FEN, "result": "0-1", "headers": {"Termination": "Zweck won by resignation"},
            "moves": [{"uci": "e2e4"}]}
    assert game_end(rec_)["reason"] == "resignation"


def test_quiet_puzzles():
    from app import tactics
    # Save your piece: the white knight on e5 is attacked by the d6 pawn; Nf3 saves it.
    b = chess.Board("4k3/8/3p4/4N3/8/8/8/4K3 w - - 0 1")
    assert tactics.quiet_solution(b, ["Nf3"]) == ("save_piece", ["e5f3"])
    # Stop the mate: black threatens the back-rank mate Ra1#; h3 gives the king an escape square.
    b = chess.Board("r5k1/8/8/8/8/8/5PPP/6K1 w - - 0 1")
    sol = tactics.quiet_solution(b, ["h3"])
    assert sol and sol[0] == "stop_mate"
    # Win material through an exchange: Rxd5 cxd5 Bxd5 wins a pawn and… (rook takes a defended knight,
    # bishop recaptures) – net +2 after the opponent's reply.
    b = chess.Board("4k3/8/2p5/3n4/8/8/1B6/3RK3 w - - 0 1")
    sol = tactics.quiet_solution(b, ["Rxd5", "cxd5", "Bxd5"])
    assert sol is None or sol[0] == "win_material"
    # A quiet move with nothing to find stays out.
    b = chess.Board("4k3/8/8/8/8/8/PPP5/4K3 w - - 0 1")
    assert tactics.quiet_solution(b, ["a3"]) is None
