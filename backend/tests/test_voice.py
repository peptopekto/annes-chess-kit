import chess

from app import coach
from app.voice import render, voice_for


def test_voice_for_sides():
    assert voice_for(chess.WHITE, "w").mine is True
    assert voice_for(chess.BLACK, "w").mine is False
    unknown = voice_for(chess.BLACK, None)
    assert unknown.mine is None and unknown.mover.subj == "Black" and unknown.other.subj == "White"


def test_render_stored_texts():
    text = "Bxf7+ is brilliant!! It offers the bishop – and taking it would cost your opponent dearly."
    assert render(text, voice_for(chess.WHITE, "w")) == text
    assert render(text, voice_for(chess.WHITE, "b")).endswith("would cost you dearly.")
    assert render(text, voice_for(chess.WHITE, None)).endswith("would cost Black dearly.")
    assert render("Qg7 misses the chance to punish your opponent. Qh8 was the move.",
                  voice_for(chess.BLACK, "w")) == "Qg7 misses the chance to punish you. Qh8 was the move."


def _blunder(color: str) -> dict:
    # A lone blunder at the end of the game: the coach falls back to "… position goes from … to …".
    fen = "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1" if color == "w" else "4k3/4q3/8/8/8/8/8/4K3 b - - 0 1"
    board = chess.Board(fen)
    move = board.parse_san("Qa6" if color == "w" else "Qa3")
    best = board.parse_san("Kd1" if color == "w" else "Kd8")
    after = board.copy()
    after.push(move)
    return {"fenBefore": fen, "fen": after.fen(), "uci": move.uci(), "san": board.san(move), "color": color,
            "bestUci": best.uci(), "bestSan": board.san(best), "bestLine": [board.san(best)], "cls": "blunder",
            "eval": {"cp": 0}, "bestEval": {"cp": 900 if color == "w" else -900}, "text": ""}


def test_coach_speaks_to_the_right_side():
    mine = coach.coach_move([_blunder("w")], 0, None, "w")
    theirs = coach.coach_move([_blunder("w")], 0, None, "b")
    unknown = coach.coach_move([_blunder("w")], 0, None, None)
    assert mine["why"].startswith("Your position goes from")
    assert theirs["why"].startswith("Your opponent's position goes from")
    assert unknown["why"].startswith("White's position goes from")


def test_describe_is_neutral():
    board = chess.Board("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    assert "castles the king to safety" in coach.describe(board, board.parse_san("O-O"))
