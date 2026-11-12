import chess
import chess.engine
import pytest

from app import classify as C
from app import openings
from app.analysis import read_games

W, B = chess.WHITE, chess.BLACK


def cp(x, pov=W):
    return chess.engine.PovScore(chess.engine.Cp(x), pov)


def mate(n, pov=W):
    return chess.engine.PovScore(chess.engine.Mate(n), pov)


def line(board, san, score):
    return C.Line(move=board.parse_san(san), score=score)


def run(fen, played, lines, after, **kw):
    board = chess.Board(fen)
    ctx = C.MoveContext(board=board, move=board.parse_san(played),
                        lines=[line(board, s, sc) for s, sc in lines], after=after, **kw)
    return C.classify(ctx)


# Classic Greek gift setup: Bxh7+ wins.
GREEK = "r1bq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 8"
# Quiet middlegame position.
QUIET = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"


# --------------------------------------------------------------------------- #
#  Sacrifice detection
# --------------------------------------------------------------------------- #

def test_greek_gift_is_a_sacrifice():
    board = chess.Board(GREEK)
    sac, sq = C.sacrifice(board, board.parse_san("Bxh7+"))
    assert sac == 2 and sq == chess.H7


def test_even_trade_is_not_a_sacrifice():
    board = chess.Board("r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4")
    sac, _ = C.sacrifice(board, board.parse_san("Bxc6"))
    assert sac == 0


def test_hanging_queen_counts():
    # Qh5?? walks into ...Nxh5 – loses the queen for nothing.
    board = chess.Board("rnbqkb1r/pppp1ppp/5n2/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 2 3")
    sac, sq = C.sacrifice(board, board.parse_san("Qh5"))
    assert sac == 9 and sq == chess.H5


def test_piece_hanging_before_the_move_is_not_this_moves_sacrifice():
    # Black's knight on c6 is already attacked by the bishop; a quiet pawn move
    # doesn't "sacrifice" it again.
    board = chess.Board("r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 3 3")
    sac, _ = C.sacrifice(board, board.parse_san("a6"))
    assert sac == 0


def test_mate_is_not_a_sacrifice():
    board = chess.Board("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1")
    sac, _ = C.sacrifice(board, board.parse_san("Rd8#"))
    assert sac == 0


# --------------------------------------------------------------------------- #
#  Classification
# --------------------------------------------------------------------------- #

def test_brilliant():
    v = run(GREEK, "Bxh7+", [("Bxh7+", cp(250)), ("O-O", cp(40))], after=cp(250, W))
    assert v.cls == C.BRILLIANT and v.sacrifice == 2


def test_sacrifice_not_brilliant_when_already_crushing():
    v = run(GREEK, "Bxh7+", [("Bxh7+", cp(1500)), ("O-O", cp(1200))], after=cp(1500))
    assert v.cls == C.BEST


def test_sacrifice_not_brilliant_when_it_loses():
    v = run(GREEK, "Bxh7+", [("O-O", cp(40)), ("Bxh7+", cp(-150))], after=cp(-150))
    assert v.cls in (C.MISTAKE, C.INACCURACY)


def test_great_only_move():
    v = run(QUIET, "d3", [("d3", cp(30)), ("O-O", cp(-250))], after=cp(30))
    assert v.cls == C.GREAT


def test_best_with_alternatives():
    v = run(QUIET, "d3", [("d3", cp(30)), ("O-O", cp(25))], after=cp(30))
    assert v.cls == C.BEST


def test_excellent_and_good():
    assert run(QUIET, "O-O", [("d3", cp(30)), ("O-O", cp(15))], after=cp(10)).cls == C.EXCELLENT
    assert run(QUIET, "O-O", [("d3", cp(30)), ("O-O", cp(15))], after=cp(-20)).cls == C.GOOD


@pytest.mark.parametrize("after,expected", [(-60, C.INACCURACY), (-150, C.MISTAKE), (-500, C.BLUNDER)])
def test_error_thresholds(after, expected):
    assert run(QUIET, "Ng5", [("d3", cp(30)), ("O-O", cp(20))], after=cp(after)).cls == expected


def test_losing_position_stays_losing_is_not_a_blunder():
    v = run(QUIET, "Ng5", [("d3", cp(-900)), ("O-O", cp(-950))], after=cp(-1100))
    assert v.cls in (C.EXCELLENT, C.GOOD)


def test_book_and_forced():
    assert run(QUIET, "d3", [("d3", cp(30))], after=cp(30), in_book=True).cls == C.BOOK
    board = chess.Board("k7/8/8/8/8/8/1r6/K7 w - - 0 1")  # Ka1 attacked: only Kxb2... or nothing else
    assert board.legal_moves.count() == 1
    only = next(iter(board.legal_moves))
    v = C.classify(C.MoveContext(board=board, move=only, lines=[C.Line(only, cp(0))], after=cp(0)))
    assert v.cls == C.FORCED


def test_miss_after_opponent_blunder():
    v = run(QUIET, "d3", [("Ng5", cp(400)), ("d3", cp(30))], after=cp(30), prev_loss=0.3)
    assert v.cls == C.MISS


def test_missed_mate():
    v = run(QUIET, "d3", [("Ng5", mate(2)), ("d3", cp(800))], after=cp(800))
    assert v.cls == C.MISS


def test_allowing_mate_is_a_blunder_even_when_already_lost():
    # -7.5 is lost, so few expected points are left to lose – walking into mate is still a blunder.
    v = run(QUIET, "Ng5", [("d3", cp(-750)), ("O-O", cp(-800))], after=mate(-1))
    assert v.cls == C.BLUNDER


def test_allowing_a_longer_mate_is_a_blunder_too():
    v = run(QUIET, "Ng5", [("d3", cp(-550)), ("O-O", cp(-600))], after=mate(-2))
    assert v.cls == C.BLUNDER


def test_a_long_mate_in_a_long_lost_ending_is_not_a_blunder():
    # Already -11: walking into a mate in 8 is graded like Lichess does, not a blunder.
    v = run(QUIET, "Ng5", [("d3", cp(-1100)), ("O-O", cp(-1150))], after=mate(-8))
    assert v.cls == C.INACCURACY


def test_missing_mate_in_two_but_staying_better_is_a_miss():
    v = run(QUIET, "d3", [("Ng5", mate(2)), ("d3", cp(290))], after=cp(290))
    assert v.cls == C.MISS


def test_getting_mated_anyway_is_not_a_blunder():
    v = run(QUIET, "Ng5", [("d3", mate(-3)), ("O-O", mate(-2))], after=mate(-1))
    assert v.cls != C.BLUNDER


def test_missing_mate_in_one_is_a_miss_even_when_still_winning():
    v = run(QUIET, "d3", [("Ng5", mate(1)), ("d3", cp(1500))], after=cp(1500))
    assert v.cls == C.MISS


def test_missing_a_long_mate_while_staying_crushing_is_not_a_miss():
    v = run(QUIET, "d3", [("Ng5", mate(9)), ("d3", cp(1500))], after=cp(1500))
    assert v.cls in (C.BEST, C.EXCELLENT, C.GOOD)


def test_throwing_away_a_mate_is_rated_by_what_is_left():
    v = run(QUIET, "d3", [("Ng5", mate(4)), ("d3", cp(50))], after=cp(50))
    assert v.cls == C.BLUNDER


def test_blunder_after_opponent_error_that_leaves_you_worse_is_not_a_miss():
    # Their error took you to +4; your reply drops you to -3 – worse than before their error.
    v = run(QUIET, "d3", [("Ng5", cp(400)), ("d3", cp(30))], after=cp(-300), prev_loss=0.3)
    assert v.cls == C.BLUNDER


def test_judge_mates_and_misses_rules():
    j = C.judge_mates_and_misses
    assert j(C.INACCURACY, ep_best=0.06, ep_after=0.0, sc=1, best_mate=None, after_mate=-1, prev_loss=None) == C.BLUNDER
    assert j(C.MISTAKE, ep_best=0.8, ep_after=0.5, sc=1, best_mate=None, after_mate=None, prev_loss=0.3) == C.MISS
    assert j(C.MISTAKE, ep_best=0.8, ep_after=0.4, sc=1, best_mate=None, after_mate=None, prev_loss=0.3) == C.MISTAKE
    assert j(C.BLUNDER, ep_best=0.8, ep_after=0.5, sc=1, best_mate=None, after_mate=None, prev_loss=0.3,
             hangs_material=True) == C.BLUNDER
    assert j(C.BOOK, ep_best=0.5, ep_after=0.0, sc=1, best_mate=None, after_mate=-1, prev_loss=None) == C.BOOK


def test_black_perspective():
    fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 2"
    assert run(fen, "Nf6", [("Nf6", cp(-20)), ("d6", cp(-10))], after=cp(-20)).cls == C.BEST
    assert run(fen, "f5", [("Nf6", cp(-20)), ("d6", cp(-10))], after=cp(400)).cls == C.BLUNDER


# --------------------------------------------------------------------------- #
#  Accuracy, book, PGN
# --------------------------------------------------------------------------- #

def test_accuracy_perfect_and_terrible():
    w, b = C.game_accuracy([50, 50, 50, 50, 50, 50])
    assert w > 99 and b > 99
    w, b = C.game_accuracy([50, 20, 20, 5, 5, 1])  # white keeps blundering
    assert w < 50 and b > 99


def test_book():
    board = chess.Board()
    for san in ["e4", "e5", "Nf3", "Nc6", "Bb5"]:
        board.push_san(san)
    eco, name = openings.lookup(board)
    assert "Ruy Lopez" in name


def test_read_games_multi():
    pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5 *\n\n[White "c"]\n[Black "d"]\n\n1. d4 d5 *\n'
    assert len(read_games(pgn)) == 2


def test_annotated_pgn_marks_moves():
    from app.analysis import annotated_pgn
    pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5 2. Qh5 Nc6 *\n'
    def mv(uci, san, cls, best="Nf3", line=("Nf3", "Nc6")):
        return {"uci": uci, "san": san, "cls": cls, "eval": {"cp": 20}, "bestSan": best,
                "bestUci": "g1f3", "bestLine": list(line)}
    record = {"pgn": pgn, "depth": 16, "accuracy": {"w": 80.0, "b": 90.0}, "opening": None, "moves": [
        mv("e2e4", "e4", "book"), mv("e7e5", "e5", "book"),
        mv("d1h5", "Qh5", "inaccuracy"), mv("b8c6", "Nc6", "brilliant"),
    ]}
    out = annotated_pgn(record)
    assert "Qh5 $6" in out and "Nc6 $3" in out and "Best was Nf3" in out  # ?! and !!
    assert "( 2. Nf3" in out  # engine line as a variation


def test_time_class():
    from app.insights import time_class
    assert time_class("60+0") == "bullet"
    assert time_class("180+2") == "blitz"
    assert time_class("600") == "rapid"
    assert time_class("1/259200") == "daily"
    assert time_class("-") == "unknown"


def test_library_merge_dedupes_and_sorts(tmp_path, monkeypatch):
    from app import library
    monkeypatch.setattr(library, "LIB_DIR", tmp_path)
    monkeypatch.setattr(library, "_mem", {})
    monkeypatch.setattr(library.storage, "review_index", lambda: {})  # never touch the real reviews
    pgn = '[White "me"]\n[Black "you"]\n\n1. e4 e5 *\n'
    g = lambda url, t: {"url": url, "endTime": t, "pgn": pgn, "white": "me", "black": "you", "myColor": "w",
                        "outcome": "win", "timeClass": "blitz", "moves": 1, "source": "lichess",
                        "whiteElo": "", "blackElo": ""}
    key = library._key("lichess", "Me")
    assert library._merge(key, [g("a", 1), g("b", 3)]) == 2
    assert library._merge(key, [g("b", 3), g("c", 2)]) == 1  # "b" already there
    listing = library.listing("lichess", "me")
    assert [x["url"] for x in listing["games"]] == ["b", "c", "a"]  # newest first
    assert all(x["id"] for x in listing["games"]) and "pgn" not in listing["games"][0]


def test_storage_cache_tracks_file_changes(tmp_path, monkeypatch):
    import json, os, time
    from app import storage
    monkeypatch.setattr(storage, "GAMES_DIR", tmp_path)
    monkeypatch.setattr(storage, "_cache", {})
    monkeypatch.setattr(storage, "_entries_snap", None)
    monkeypatch.setattr(storage, "_disk_loaded", False)  # cache file lands next to tmp_path, never in userdata
    monkeypatch.setattr(storage, "my_names", lambda: {"me"})
    def write(gid, cls, date):
        rec = {"id": gid, "white": "me", "black": "x", "date": date, "headers": {"UTCDate": date}, "plies": 2,
               "accuracy": {"w": 90.0, "b": 50.0}, "counts": {}, "analysedAt": 1,
               "moves": [{"ply": 1, "san": "e4", "uci": "e2e4", "color": "w", "cls": cls, "fenBefore": "f",
                          "bestUci": "e2e4", "bestSan": "e4", "text": "", "loss": 0}]}
        (tmp_path / f"{gid}.json").write_text(json.dumps(rec))
    write("aaa", "brilliant", "2026.01.01"); write("bbb", "great", "2026.02.01")
    assert [h["gameId"] for h in storage.highlights(("brilliant", "great"))] == ["bbb", "aaa"]  # newest game first
    write("aaa", "blunder", "2026.01.01")
    os.utime(tmp_path / "aaa.json", (time.time() + 5, time.time() + 5))  # make sure mtime changes
    assert [h["cls"] for h in storage.highlights(("brilliant", "great"))] == ["great"]
    (tmp_path / "bbb.json").unlink()
    assert [s["id"] for s in storage.summaries()] == ["aaa"] and storage.summaries()[0]["me"] == "w"
    # A fresh process starts from the disk cache and still sees the same reviews.
    monkeypatch.setattr(storage, "_cache", {})
    monkeypatch.setattr(storage, "_entries_snap", None)
    monkeypatch.setattr(storage, "_disk_loaded", False)
    assert storage._cache_file().exists()
    assert [s["id"] for s in storage.summaries()] == ["aaa"]


def test_tactic_needs_a_payoff():
    from app import tactics
    b = chess.Board("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1")
    # Nc7+ forks king and rook, and the line takes the rook: a fork.
    assert tactics.theme_of_line(b, ["Nc7+", "Kd7", "Nxa8", "Kc8"]) == "fork"
    # The same jump, but the line never wins anything with it: no fork to speak of.
    assert tactics.theme_of_line(b, ["Nc7+", "Kd7", "Nd5", "Kd6"]) is None


@pytest.mark.parametrize("fen,line,theme", [
    # Back-rank mate: Rd8#
    ("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", ["Rd8#"], "back_rank"),
    # Knight fork of king and queen: Nc7+
    ("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", ["Nc7+"], "fork"),
    # Pin: Bb5 pins the d7 knight to the king
    ("4k3/3n4/8/8/8/3B4/8/4K3 w - - 0 1", ["Bb5"], "pin"),
    # Free piece: taking an undefended knight
    ("4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1", ["Qxd5"], "free_piece"),
    # Skewer: Rd1+ hits the king, the queen behind it falls next
    ("3q4/8/8/3k4/8/8/8/R3K3 w - - 0 1", ["Rd1+"], "skewer"),
    # Quiet developing move: no theme
    ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", ["Nf3"], None),
])
def test_tactic_themes(fen, line, theme):
    from app.tactics import theme_of_line
    assert theme_of_line(chess.Board(fen), line) == theme


def test_puzzle_solution():
    from app.tactics import puzzle_solution
    # Back-rank mate in one is a one-move puzzle.
    assert puzzle_solution(chess.Board("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"), ["Rd8#"]) == ("back_rank", ["d1d8"])
    # A fork stops right after the forking move.
    theme, ucis = puzzle_solution(chess.Board("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1"), ["Nc7+", "Kd7", "Nxa8"])
    assert theme == "fork" and ucis == ["b5c7"]
    # A quiet developing move has no clear point → not a puzzle.
    assert puzzle_solution(chess.Board(), ["Nf3", "Nf6"]) is None


def test_mate_length_scales_with_rating():
    from app.tactics import max_mate_for_rating
    assert [max_mate_for_rating(r) for r in (900, 1300, 1700, 2100, None)] == [2, 3, 4, 5, 3]


def test_opening_family_root_and_pgn_tokens():
    from app import openings, repertoire
    assert openings.family_book("Caro-Kann Defense")["root"] == ["e2e4", "c7c6"]
    assert openings.family_book("Rapport-Jobava System")["root"] == ["d2d4", "d7d5", "b1c3"]
    assert openings.family_of("Rapport-Jobava System, with e6") == "Rapport-Jobava System"
    pgn = '[White "a"]\n\n1. e4 {[%clk 0:10:00]} 1... c6 2. d4 (2. Nc3 d5) 2... d5 $1 3. e5 1-0'
    assert repertoire._sans(pgn) == ["e4", "c6", "d4", "d5", "e5"]


@pytest.mark.parametrize("fen,uci,expect", [
    # Knight lands on an attacked but defended square.
    ("4k3/8/8/3p4/8/2NP4/8/4K3 w - - 0 1", "c3e4", "defended"),
    # Nothing can take it.
    ("4k3/8/8/8/8/2N5/8/4K3 w - - 0 1", "c3d5", "Nothing can take"),
    # Bishop takes knight, pawn can take back: a trade.
    ("4k3/8/4p3/3n4/8/8/6B1/4K3 w - - 0 1", "g2d5", "fair trade"),
])
def test_why_safe(fen, uci, expect):
    from app.safety import _why_safe
    assert expect in _why_safe(chess.Board(fen), chess.Move.from_uci(uci))


def test_stored_reviews_are_re_rated_without_the_engine():
    from app import recheck
    # White's c3?? lets ...Re1# (the back rank is sealed by White's own pawns).
    fen = "4r1k1/5ppp/8/8/8/8/2P2PPP/6K1 w - - 0 1"
    record = {"ratingModel": {"k": C.LICHESS_K}, "counts": {}, "moves": [
        {"ply": 1, "san": "c3", "uci": "c2c3", "color": "w", "fenBefore": fen, "cls": C.GOOD, "loss": 0.03,
         "epBest": 0.03, "epAfter": 0.0, "bestUci": "h2h3", "bestSan": "h3", "bestLine": ["h3"],
         "bestEval": {"cp": -800}, "eval": {"mate": -1}, "text": "c3 is good. h3 was a little more precise."},
    ]}
    changed = recheck.rerate(record)
    assert changed == [(1, "c3", C.GOOD, C.BLUNDER)]
    assert "allows mate in 1" in record["moves"][0]["text"]
    assert record["counts"]["w"] == {C.BLUNDER: 1}


def test_only_safe_square_for_an_attacked_piece_is_not_a_great_move():
    # The b6 bishop is attacked by the a5 pawn and a7 is its only safe square: nothing to find.
    b = chess.Board("r1b2rk1/1ppp1ppp/pbn2q2/P3p3/1P2P3/2PP1N2/5PPP/RN1QKB1R b KQ - 0 9")
    assert C.obvious_retreat(b, chess.Move.from_uci("b6a7"))
    # A queen with several safe squares: choosing the right one can still be a Great move.
    b = chess.Board("r2qk2r/ppp2p1p/3b1np1/3pnQ2/8/1PN1P2P/P1P2PP1/R1B1KB1R w KQkq - 0 10")
    assert not C.obvious_retreat(b, chess.Move.from_uci("f5g5"))
    # A piece that wasn't attacked: not a retreat at all.
    assert not C.obvious_retreat(chess.Board(), chess.Move.from_uci("g1f3"))


def test_an_offer_they_could_just_as_well_take_is_not_a_sacrifice():
    # Knight to b5 can be taken by the queen; with best play they decline. Taking it must be an error for them.
    b = chess.Board("rn2qrk1/ppp1b3/3p1ppQ/3Pp1p1/4P3/2N5/PPP2PPP/R1B2RK1 w - - 2 14")
    mv = chess.Move.from_uci("c3b5")
    _, sq = C.sacrifice(b, mv)
    declined = [chess.Move.from_uci("e8f7")]
    score = lambda cp: (chess.engine.PovScore(chess.engine.Cp(cp), chess.WHITE), [])  # noqa: E731
    assert C.sacrifice_kind(b, mv, sq, declined, lambda board: score(20), ep_after=0.52) is None      # taking = about equal
    assert C.sacrifice_kind(b, mv, sq, declined, lambda board: score(600), ep_after=0.52) in (None, "offer")
