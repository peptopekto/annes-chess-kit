import json

import chess
import pytest

from app import cards
from app import concepts as K
from app import positional as P
from app.voice import voice_for

TAUGHT = [c for c in K.CONCEPTS if c not in P.NOT_TAUGHT]


def test_every_taught_concept_has_exactly_one_card():
    by_concept = {}
    for card in cards.load().values():
        by_concept.setdefault(card["concept"], []).append(card["id"])
    assert sorted(by_concept) == sorted(TAUGHT)
    assert all(len(ids) == 1 for ids in by_concept.values()), by_concept


@pytest.mark.parametrize("card_id", sorted(cards.load()))
def test_card_is_complete_and_its_examples_show_the_concept(card_id):
    card = cards.load()[card_id]
    assert card["level"] in cards.LEVELS and card["examples"] and card["exceptions"]
    assert len(card["explanation"].split(". ")) >= 2           # a few sentences, not a slogan
    for ex in card["examples"]:
        board = chess.Board(ex["fen"])
        assert board.is_valid()
        side = chess.WHITE if ex["side"] == "w" else chess.BLACK
        f = K.measure(board).features[card["concept"]]
        # The model position has to show its own concept – for the side the example is about.
        assert f.value[side] > 0 and f.value[side] >= f.value[not side], (card_id, ex["title"], f.value)
        after = board.copy()
        for san in ex["line"]:
            after.push_san(san)  # legal (also checked when loading)
    for side in ("own", "other"):
        assert card["your_chance"][side] and "{" not in card["your_chance"][side]
        for me in ("w", "b", None):
            text = card["in_your_game"][side].format(sq="e4", **P._words(voice_for(chess.WHITE, me)))
            assert "{" not in text and text.startswith("This ")


def test_broken_examples_fail_loudly(tmp_path):
    (tmp_path / "x.yaml").write_text("""
- id: x
  concept: passed_pawn
  title: X
  level: beginner
  phase: [endgame]
  principle: p
  explanation: e
  in_your_game: {own: This a., other: This b.}
  ask_yourself: q
  your_chance: {own: c., other: d.}
  exceptions: [none]
  source: s
  examples:
    - {title: t, fen: 8/8/8/3P4/8/8/8/k6K w - - 0 1, side: white, line: d6 Kb2 d8=Q}
""")
    with pytest.raises(cards.CardError, match="illegal line move"):
        cards.load.__wrapped__(tmp_path)


def test_level_factor():
    club = cards.load()["hanging-pawns"]
    beginner = cards.load()["back-rank"]
    assert cards.level_factor(club, 800) == 0.6 and cards.level_factor(club, 1200) == 0.8
    assert cards.level_factor(club, 1900) == 1.0 and cards.level_factor(club, None) == 1.0
    assert cards.level_factor(beginner, 2000) == 1.0


def test_feedback_is_kept_and_damps_the_concept(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "FEEDBACK_FILE", tmp_path / "fb.json")
    for ply in (10, 12):
        cards.feedback("g1", ply, "holes", False)
    cards.feedback("g1", 12, "holes", True)                  # changing your mind replaces the verdict
    s = cards.feedback("g2", 5, "holes", False)
    assert s == {"holes": {"fits": 1, "doesntFit": 2}}
    assert cards.verdicts("g1") == {"10:holes": False, "12:holes": True}
    assert P.tuning() == {"holes": pytest.approx(1 - 0.4 * 2 / 3)}
    assert len(json.loads((tmp_path / "fb.json").read_text())) == 3
    with pytest.raises(ValueError):
        cards.feedback("g1", 1, "nonsense", True)
