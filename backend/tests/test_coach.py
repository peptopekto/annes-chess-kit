import chess

from app import classify as C
from app import coach, tactics
from app.analysis import game_rating


def test_k_for_rating_curve():
    assert C.k_for_rating(None) == C.LICHESS_K
    assert C.k_for_rating(400) == C.k_for_rating(600) == 0.0018
    assert C.k_for_rating(2400) == C.LICHESS_K
    assert 0.0018 < C.k_for_rating(1300) < C.LICHESS_K


def test_flatter_curve_for_beginners():
    # The same +300 is less decisive for a beginner than for a strong player.
    s = chess.engine.PovScore(chess.engine.Cp(300), chess.WHITE).white()
    assert C.expected_points(s, C.k_for_rating(800)) < C.expected_points(s, C.LICHESS_K)


def test_game_rating_shifts_chesscom():
    assert game_rating({"WhiteElo": "1000", "BlackElo": "1000", "Site": "Chess.com"}) == 1350
    assert game_rating({"WhiteElo": "1500", "BlackElo": "1700", "Site": "https://lichess.org/abc"}) == 1600
    assert game_rating({"WhiteElo": "?"}) is None


def test_describe_basic_ideas():
    b = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3")
    assert coach.describe(b, b.parse_san("Nc3")) == ["develops the knight"]
    b = chess.Board("4k3/8/8/3q4/8/8/8/3QK3 w - - 0 1")
    assert any("wins the queen" in p for p in coach.describe(b, b.parse_san("Qxd5")))
    b = chess.Board("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")
    assert coach.describe(b, b.parse_san("Ra8#")) == ["delivers checkmate"]


def test_eval_label():
    assert coach.eval_label({"cp": 0}, True) == "equal"
    assert coach.eval_label({"cp": 500}, False) == "losing"
    assert coach.eval_label({"mate": -3}, False) == "winning (forced mate)"


def _line(board, sans):
    b = board.copy()
    out = []
    for s in sans:
        m = b.parse_san(s)
        out.append(m)
        b.push(m)
    return out


def test_sacrifice_accepted_counts():
    # Greek gift: Bxh7+ Kxh7 Ng5+ – White stays a piece down for a while.
    b = chess.Board("r1bq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 8")
    line = _line(b, ["Bxh7+", "Kxh7", "Ng5+", "Kg8", "Qh5"])
    assert C.material_given(b, line)


def test_trade_is_not_a_sacrifice():
    # Bxc6 bxc6: bishop for knight, nothing given.
    b = chess.Board("r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")
    assert not C.material_given(b, _line(b, ["Bxc6", "dxc6", "O-O"]))
    # Rook takes rook, recaptured: even.
    b = chess.Board("3rk3/8/8/8/8/8/8/3RK3 w - - 0 1")
    assert not C.material_given(b, _line(b, ["Rxd8+", "Kxd8"]))


def test_declined_offer_needs_engine_confirmation():
    # Knight to a square a pawn attacks, opponent ignores it in the line.
    b = chess.Board("4k3/8/8/3p4/8/8/8/4K1N1 w - - 0 1")
    move = b.parse_san("Ne2")  # nothing offered at all
    assert not C.sacrifice_confirmed(b, move, None, [], None)
    # With no line to check, the static verdict stands.
    assert C.sacrifice_confirmed(b, move, None, None, None)

    # A real offer the line declines: the engine says taking is fine for them -> not brilliant.
    b = chess.Board("4k3/8/8/8/2p5/8/8/2N1K3 w - - 0 1")
    offer = b.parse_san("Nd3")  # cxd3 wins the knight
    sq = chess.parse_square("d3")
    good_for_them = lambda board: (chess.engine.PovScore(chess.engine.Cp(-400), chess.WHITE), [])
    assert not C.sacrifice_confirmed(b, offer, sq, [], good_for_them)
    # ...and if taking it loses for them (engine says White is fine afterwards), it counts.
    bad_for_them = lambda board: (chess.engine.PovScore(chess.engine.Cp(250), chess.WHITE), [chess.Move.from_uci("e1d2")])
    assert C.sacrifice_confirmed(b, offer, sq, [], bad_for_them)


def test_nightmare_castling_from_lc0_notation():
    from app.nightmare import _legal
    b = chess.Board("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")
    assert _legal(b, "e1h1") == chess.Move.from_uci("e1g1")  # Lc0 writes castling as king-takes-rook
    b = chess.Board("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1")
    assert _legal(b, "e8a8") == chess.Move.from_uci("e8c8")
    assert _legal(b, "e8e1") is None


def test_recapture_is_a_trade_not_a_free_piece():
    # 6...Bxd3 7.Qxd3: White only takes back the bishop that just captured – no material is won.
    before = chess.Board("r2qkbnr/pp2pppp/2n5/2PpPb2/5P2/3B4/PPP3PP/RNBQK1NR b KQkq - 2 6")
    after = before.copy()
    after.push_san("Bxd3")
    line = ["Qxd3", "e6", "Be3", "d4"]
    assert tactics.theme_of_line(after, line, before) is None
    # A really undefended piece is still a free piece.
    hanging = chess.Board("4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1")
    assert tactics.theme_of_line(hanging, ["Qxd5"], hanging) == "free_piece"


def _moves(sans):
    b, out = chess.Board(), []
    for s in sans:
        mv = b.parse_san(s)
        out.append({"fenBefore": b.fen(), "uci": mv.uci(), "san": s})
        b.push(mv)
    return out


def test_capture_wording_follows_the_exchange():
    # 3...Bxf3 4.Qxf3: taking back the bishop that just took the knight is a trade, not a free piece.
    ms = _moves(["e4", "d6", "d4", "Bg4", "Nf3", "Bxf3", "Qxf3"])
    b = chess.Board(ms[6]["fenBefore"])
    assert "recaptures the bishop" in coach.describe(b, b.parse_san("Qxf3"), ["Nf6"], coach.prev_capture(ms, 6))
    assert coach.prev_capture(ms, 5) is None  # Nf3 wasn't a capture
    # A really undefended piece, and the reply doesn't win anything back.
    b = chess.Board("4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1")
    assert coach.describe(b, b.parse_san("Qxd5"), ["Ke7"])[0] == "wins the knight for free"
    # ...Qxd5 takes the queen, but Nxc7+ forks king and queen and wins it back: a queen trade.
    b = chess.Board("3qk3/2p5/8/1N1Q4/8/8/8/4K3 b - - 0 1")
    assert coach.describe(b, b.parse_san("Qxd5"), ["Nxc7+", "Kd7", "Nxd5"])[0] == "trades queens"
    # A pawn promotes and the rook takes the new queen; the knight then takes the rook – that wins a rook for a pawn.
    b = chess.Board("4k3/8/8/8/8/2n5/3p4/R6K b - - 0 1")
    ms = []
    for san in ("d1=Q+", "Rxd1"):
        ms.append({"fenBefore": b.fen(), "uci": b.parse_san(san).uci()})
        b.push_san(san)
    ms.append({"fenBefore": b.fen(), "uci": b.parse_san("Nxd1").uci()})
    rook = chess.Board(ms[1]["fenBefore"])
    assert coach.describe(rook, rook.parse_san("Rxd1"), ["Nxd1"], coach.prev_capture(ms, 1))[0] == "takes the new queen"
    assert coach.describe(b, b.parse_san("Nxd1"), ["Kg2"], coach.prev_capture(ms, 2))[0] == "wins the rook"


def test_small_wording_rules():
    b = chess.Board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
    assert coach.describe(b, b.parse_san("d4")) == ["grabs space in the centre"]
    assert "grabs space in the centre" not in coach.describe(b, b.parse_san("d3"))
    # A knight hitting two rooks attacks "both rooks", not "the rook at once".
    b = chess.Board("r3r1k1/8/8/3N4/8/8/8/7K w - - 0 1")
    assert "attacks both rooks" in coach.describe(b, b.parse_san("Nc7"))


def test_missed_mate_isnt_called_punishing_a_slip():
    fen = "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"
    b = chess.Board(fen)
    b.push_san("h3")
    m = {"fenBefore": fen, "fen": b.fen(), "uci": "h2h3", "san": "h3", "bestUci": "d1d8", "bestSan": "Rd8#",
         "bestLine": ["Rd8#"], "eval": {"cp": 500}, "bestEval": {"mate": 1}, "cls": "miss", "loss": 0.3, "color": "w"}
    c = coach.coach_move([m], 0, None, "w")
    assert c["why"] == "There was a forced mate in 1." and "forced mate" in c["better"]


def test_material_claims_need_the_evaluation_to_agree():
    m = {"fenBefore": chess.STARTING_FEN, "bestEval": {"cp": 40}, "eval": {"cp": -260}}
    assert coach._pawns_dropped(m) == 3.0                       # White to move: +0.4 -> -2.6
    m["fenBefore"] = chess.STARTING_FEN.replace(" w ", " b ")
    assert coach._pawns_dropped(m) == -3.0                      # same numbers are a gain for Black
    assert coach._pawns_dropped({**m, "eval": {"mate": 3}}) is None


def test_stale_hanging_claim_is_dropped():
    # Nc5?: best play takes the knight on c5, not the "hanging" bishop on b2.
    board = chess.Board("4k3/8/1n6/8/8/8/1B6/4K3 w - - 0 1")
    move = board.parse_san("Ba3")
    after = board.copy()
    after.push(move)
    moves = [{"fen": after.fen(), "bestSan": "Kd2", "text": "Ba3 is a mistake. It leaves the bishop on b2 hanging."},
             {"bestLine": ["Nd5", "Kd2"]}]
    assert coach._check_hanging(moves, 0) == "Ba3 is a mistake. Kd2 was best."
    moves[0]["text"] = "Ba3 is a mistake. It leaves the bishop on a3 hanging."
    moves[1]["bestLine"] = ["Nc4", "Kd1", "Nxa3"]
    assert coach._check_hanging(moves, 0).endswith("hanging.")  # taken on its second move: a real claim


def test_mating_move_is_labelled_won():
    assert coach.eval_label({"mate": 0, "winner": "w"}, True) == "won – checkmate"
    assert coach.eval_label({"mate": 0, "winner": "w"}, False) == "lost – checkmated"
    assert coach.eval_label({"mate": 0}, False) == "won – checkmate"   # old reviews: the mover gave mate
    assert coach.eval_label({"mate": 3}, True) == "winning (forced mate)"


def test_trapped_piece_theme():
    import chess
    from app import tactics
    # ...Bd6 allowed h5: the g6 bishop has no safe square.
    b = chess.Board("rn2k1nr/pp3ppp/2pbp1b1/8/4P1PP/3BN3/PPP2P2/R1B1K1NR w KQkq - 1 10")
    assert "trapped" in tactics.themes_of_move(b, b.parse_san("h5"))
    assert tactics.trapped_square(b, b.parse_san("h5")) == chess.G6
    # A queen with no squares after Be2.
    b = chess.Board("r4rk1/1p2bppp/p1n2n2/3p4/N1qP1B2/2P2B2/PP3PPP/R2QR1K1 w - - 1 16")
    assert tactics.trapped_square(b, b.parse_san("Be2")) == chess.C4
    # An attacked piece that can simply move away isn't trapped.
    b = chess.Board("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2")
    assert tactics.trapped_square(b, b.parse_san("d5")) is None
    assert "trapped" not in tactics.themes_of_move(chess.Board(), chess.Move.from_uci("e2e4"))
