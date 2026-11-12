import chess

from app import positional as P

# Rook endgame: after ...Qd4 White must take back. exd4 keeps the black c-pawn blocked by c3;
# cxd4 hands Black a passed pawn on c4 that walks down the board.
FEN = "8/5ppp/2r5/R7/2pqk3/2P1P1P1/5P1P/5K2 w - - 0 42"


def _moves(**over):
    b = chess.Board(FEN)
    b.push_san("cxd4")
    m = {"ply": 83, "san": "cxd4", "uci": "c3d4", "color": "w", "fenBefore": FEN, "fen": b.fen(),
         "cls": "mistake", "bestUci": "e3d4", "bestSan": "exd4", "bestLine": ["exd4", "Rd6", "Ke2", "h6"],
         "bestEval": {"cp": 20}, "eval": {"cp": -150}}
    m.update(over)
    reply = {"ply": 84, "san": "c3", "uci": "c4c3", "color": "b", "fenBefore": b.fen(), "cls": "best",
             "bestLine": ["c3", "Ra1", "c2"]}
    return [m, reply]


def test_passed_pawn_is_taught_with_the_square():
    p = P.explain(_moves(), 0, me="w")
    assert p and p["phase"] == "endgame"
    c = p["concepts"][0]
    assert c["concept"] == "passed_pawn" and c["side"] == "other"
    assert c["squares"] == ["c4"]                       # marked on the board right after the move
    assert c["inGame"] == "This lets your opponent get a passed pawn (c4)."
    assert c["principle"] and c["ask_yourself"] and "Nimzowitsch" in c["source"]


def test_words_follow_who_moved():
    # Your opponent's move (you are Black): the same lesson, told about them – plus how to use it.
    c = P.explain(_moves(), 0, me="b")["concepts"][0]
    assert c["inGame"] == "This lets you get a passed pawn (c4)."
    assert c["chance"].startswith("You have a passed pawn") and c["replyLine"] == "42...c3 43.Ra1 c2"
    # Your own move: no "your chance", the question to ask yourself instead.
    assert "chance" not in P.explain(_moves(), 0, me="w")["concepts"][0]
    # No side known: colours.
    assert P.explain(_moves(), 0)["concepts"][0]["inGame"] == "This lets Black get a passed pawn (c4)."


def test_nothing_taught_when_a_tactic_or_material_explains_it():
    assert P.explain(_moves(missed={"theme": "fork", "label": "Fork"}), 0) is None
    assert P.explain(_moves(refute={"san": "Rxc4", "theme": "pin"}), 0) is None
    assert P.explain(_moves(bestEval={"mate": 4}), 0) is None          # calculation, not principles
    assert P.explain(_moves(bestEval={"cp": 900}), 0) is None          # already decided
    assert P.explain(_moves(cls="good"), 0) is None
    # Down the engine's line Black wins a pawn: the difference is material.
    moves = _moves()
    moves[1]["bestLine"] = ["Rd6", "Ke2", "Rxd4"]
    assert P.explain(moves, 0) is None


def test_needs_the_engine_line_to_confirm():
    moves = _moves()
    assert P.explain(moves[:1], 0) is None          # last move of the game: no reply line
    moves[0]["bestLine"] = ["exd4", "Qxx9"]          # broken line
    assert P.explain(moves, 0) is None


def test_enrich_adds_principle_only_where_found():
    record = {"me": "w", "moves": _moves()}
    P.enrich(record)
    assert "principle" in record["moves"][0] and "principle" not in record["moves"][1]


def test_lesson_comes_from_the_card():
    c = P.explain(_moves(), 0, me="w")["concepts"][0]
    assert c["card"] == "passed-pawn" and c["principle"] and c["explanation"] and c["ask_yourself"]
    assert c["examples"] and c["examples"][0]["fen"] and c["level"] == "beginner"


def test_rating_and_feedback_damp_a_lesson():
    strong = P.explain(_moves(), 0, me="w")["concepts"][0]["strength"]
    damped = P.explain(_moves(), 0, me="w", damp={"passed_pawn": 0.6})["concepts"][0]["strength"]
    assert damped < strong
    # mostly "doesn't fit": the lesson isn't taught any more
    rest = P.explain(_moves(), 0, me="w", damp={"passed_pawn": 0.2}) or {"concepts": []}
    assert "passed_pawn" not in [c["concept"] for c in rest["concepts"]]
