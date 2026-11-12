"""Every concept detector on a textbook position: it fires for the right side, on the right squares,
and stays quiet where the concept doesn't apply."""
import time

import chess

from app import concepts as K

W, B = chess.WHITE, chess.BLACK


def prof(fen):
    return K.measure(chess.Board(fen))


def val(fen, cid, color):
    return prof(fen).features[cid].value[color]


def squares(fen, cid, color):
    return prof(fen).features[cid].squares[color]


START = chess.STARTING_FEN


def test_start_position_is_balanced():
    p = prof(START)
    assert p.phase == K.OPENING
    for cid in K.CONCEPTS:
        assert p.balance(cid, W) == 0, cid


def test_phase():
    assert K.phase_of(chess.Board(START)) == K.OPENING
    assert K.phase_of(chess.Board("r2q1rk1/5ppp/8/8/8/6P1/5P2/R2Q1RK1 w - - 0 20")) == K.MIDDLEGAME
    assert K.phase_of(chess.Board("8/8/8/4k3/8/4K3/8/8 w - - 0 50")) == K.ENDGAME


# --- pawn structure -------------------------------------------------------- #

IQP = "r1bq1rk1/pp2bppp/2n1pn2/8/3P4/2N2N2/PP2BPPP/R1BQ1RK1 w - - 0 10"


def test_isolated_queen_pawn_and_the_square_in_front_of_it():
    assert val(IQP, "isolated_pawn", W) == 1 and squares(IQP, "isolated_pawn", W) == [chess.D4]
    assert val(IQP, "isolated_pawn", B) == 0
    # d5, in front of the isolani, is a square Black's knights can use for good (Nimzowitsch's blockade)
    assert chess.D5 in squares(IQP, "outpost_squares", B)


def test_doubled_pawns_and_islands():
    fen = "4k3/8/8/8/8/2P5/2P5/4K3 w - - 0 1"
    assert val(fen, "doubled_pawn", W) == 1
    assert val("4k3/8/8/8/8/8/P1P1P3/4K3 w - - 0 1", "pawn_islands", W) == 2


def test_backward_pawn():
    # d6 can't be supported by a pawn and d5 is covered by White's e4 pawn
    fen = "4k3/8/3p4/4p3/4P3/8/8/4K3 w - - 0 1"
    assert squares(fen, "backward_pawn", B) == [chess.D6]
    assert val(fen, "backward_pawn", W) == 0


def test_hanging_pawns():
    fen = "4k3/pp3ppp/8/8/2PP4/8/P4PPP/4K3 w - - 0 1"
    assert val(fen, "hanging_pawns", W) == 1


def test_passed_protected_and_connected():
    fen = "4k3/8/8/2P5/3P4/8/8/4K3 w - - 0 1"
    assert val(fen, "passed_pawn", W) > 0
    assert squares(fen, "protected_passer", W) == [chess.C5]
    assert val(fen, "connected_passers", W) == 1


def test_blockade_by_a_knight():
    fen = "4k3/8/8/8/3p4/3N4/8/4K3 w - - 0 1"
    assert val(fen, "blockade", W) == 1.5 and squares(fen, "blockade", W) == [chess.D3]


def test_holes_around_a_fianchetto_without_the_bishop():
    fen = "rnbq1rk1/ppppbp1p/5np1/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 6"
    assert chess.H6 in squares(fen, "holes", B)
    assert val(fen, "holes", W) == 0


def test_center_pawns_after_e4():
    assert val("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "center_pawns", W) == 1


# --- pieces ------------------------------------------------------------------ #

def test_knight_outpost():
    fen = "r4rk1/pp3ppp/3p4/3N4/4P3/8/PPP2PPP/R4RK1 w - - 0 20"
    assert squares(fen, "knight_outpost", W) == [chess.D5]
    assert val(fen, "knight_outpost", B) == 0


def test_bad_bishop_in_the_french():
    fen = "rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 0 4"
    bad = squares(fen, "bad_bishop", B)
    assert chess.C8 in bad and chess.F8 not in bad


def test_bishop_pair_and_minor_piece_fit():
    assert prof(START).features["bishop_pair"].value == {W: 1, B: 1}
    open_centre = "4k3/pp3ppp/2n5/8/8/2B5/PP3PPP/4K3 w - - 0 30"
    assert val(open_centre, "minor_piece_fit", W) == 1 and val(open_centre, "minor_piece_fit", B) == 0


def test_rooks_on_files_and_the_seventh():
    assert val("4k3/pp4pp/8/8/8/8/PP4PP/3RK3 w - - 0 30", "rook_open_file", W) == 1
    assert val("4k3/ppp3pp/8/8/8/8/PP4PP/2R1K3 w - - 0 30", "rook_half_open_file", W) == 1
    assert val("6k1/pR3ppp/8/8/8/8/5PPP/6K1 w - - 0 30", "rook_seventh", W) == 1
    assert val("4k3/pp4pp/8/8/8/8/PP1R2PP/3R2K1 w - - 0 30", "doubled_rooks", W) == 1


def test_rook_behind_a_passed_pawn():
    assert val("4k3/8/8/8/P7/8/8/R3K3 w - - 0 40", "rook_behind_passer", W) == 1
    # in front of the pawn it is not behind it
    assert val("4k3/8/8/R7/P7/8/8/4K3 w - - 0 40", "rook_behind_passer", W) == 0


def test_knight_on_the_rim_and_a_passive_bishop():
    assert val("4k3/8/8/8/8/N7/8/4K3 w - - 0 30", "knight_rim", W) == 1
    fen = "4k3/8/8/8/8/5P2/6P1/4K2B w - - 0 30"
    assert squares(fen, "passive_piece", W) == [chess.H1]


def test_undeveloped_pieces_count_only_after_the_first_moves():
    assert val(START, "undeveloped", W) == 0
    late = START.replace(" 0 1", " 0 10")
    assert val(late, "undeveloped", W) == 4


# --- the king ------------------------------------------------------------------ #

def test_king_in_the_centre_and_lost_castling():
    fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 12"
    assert val(fen, "king_center", W) >= 1
    walked = "rnbq1rk1/pppp1ppp/5n2/2b1p3/4P3/5N2/PPPP1PPP/RNBQ1K1R w - - 0 6"
    assert val(walked, "lost_castling", W) == 1 and val(walked, "lost_castling", B) == 0


def test_pawn_shield():
    fen = "r2q1rk1/5ppp/8/8/8/6P1/5P2/R2Q1RK1 w - - 0 20"
    assert val(fen, "king_shield", W) == 1.5   # h-pawn gone, g-pawn pushed
    assert val(fen, "king_shield", B) == 0


def test_open_lines_and_attackers_at_the_king():
    fen = "3q1r1k/5pp1/8/8/8/8/5PP1/3Q1RKR w - - 0 20"
    assert val(fen, "king_open_lines", B) >= 1.5
    assert chess.H1 in squares(fen, "king_attackers", B)


def test_back_rank():
    fen = "3r2k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 30"
    assert val(fen, "back_rank", W) == 1
    assert val(fen, "back_rank", B) == 0   # White has no rook or queen to use it


# --- centre and space ------------------------------------------------------------ #

def test_e4_gains_centre_and_space():
    after = prof("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    assert after.balance("center_control", W) > 0
    assert after.balance("space", W) > 0


# --- endgame --------------------------------------------------------------------- #

def test_king_activity_in_the_endgame():
    p = prof("8/8/8/4k3/8/8/8/K7 w - - 0 50")
    assert p.balance("king_activity", B) == 3


def test_opposition_belongs_to_the_side_not_to_move():
    assert val("8/8/8/4k3/8/4K3/8/8 w - - 0 50", "opposition", B) == 1
    assert val("8/8/8/4k3/8/4K3/8/8 b - - 0 50", "opposition", W) == 1


def test_rule_of_the_square():
    assert val("8/8/k7/8/8/8/6P1/7K w - - 0 50", "unstoppable_passer", W) == 1
    assert val("8/8/5k2/8/8/8/6P1/7K w - - 0 50", "unstoppable_passer", W) == 0


# --- compare ------------------------------------------------------------------------ #

def test_compare_names_what_a_move_gave_away():
    # Same position, once with White's c-pawn still there (after the best move), once without it
    best = prof("4k3/pp3ppp/2p1p3/8/3P4/2P5/PP3PPP/4K3 w - - 0 30")
    played = prof("4k3/pp3ppp/2p1p3/8/3P4/8/PP3PPP/4K3 w - - 0 30")
    worst = [c.concept for c in K.compare(best, played, W)[:3]]
    assert "isolated_pawn" in worst


def test_speed():
    board = chess.Board()
    moves = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7".split()
    t = time.perf_counter()
    for san in moves:
        board.push_san(san)
        K.measure(board)
    per = (time.perf_counter() - t) / len(moves)
    assert per < 0.01, f"{per * 1000:.1f} ms per position"
