import chess
import chess.engine
import pytest

from app import classify as C
from app import nightmare as N


class FakeMaia:
    def __init__(self, pol):
        self.pol = pol

    def policy(self, board):
        return [(chess.Move.from_uci(u), p) for u, p in self.pol]


def _setup(monkeypatch, pol, cp=None, trap=None):
    """Maia's probabilities; Stockfish's eval (centipawns, bot's view) per move; trap value per move."""
    cp, trap = cp or {}, trap or {}
    calls = []
    monkeypatch.setattr(N, "profile", lambda: N.Profile(rating=1200, k=C.LICHESS_K, themes={}, theme_counts=[],
                                                        book={}, base_err=0.1, games=0, built=0))
    monkeypatch.setattr(N, "nearest_level", lambda r: 1200)
    monkeypatch.setattr(N, "maia", lambda lv: FakeMaia(pol))
    monkeypatch.setattr(N, "_trouble", lambda p, b: None)

    def search(board, depth, moves=None):
        calls.append(moves)
        ms = moves or [max(cp, key=cp.get) if cp else chess.Move.from_uci(pol[0][0])]
        if not moves and cp:
            ms = [chess.Move.from_uci(max(cp, key=cp.get))]
        return [C.Line(move=m, score=chess.engine.PovScore(chess.engine.Cp(cp.get(m.uci(), 0)), board.turn), pv=[m])
                for m in ms]
    monkeypatch.setattr(N, "_search", search)
    monkeypatch.setattr(N, "_trap", lambda after, lv, k, p: (
        {"value": trap[after.peek().uci()]} if after.peek().uci() in trap else None))
    return calls


def test_plain_maia_plays_its_most_likely_move_without_any_search(monkeypatch):
    calls = _setup(monkeypatch, [("e2e4", 0.45), ("d2d4", 0.40), ("g1f3", 0.15)])
    for _ in range(20):                          # no dice: always the top move
        r = N.choose([], focus=0)
        assert r["uci"] == "e2e4" and r["rank"] == 1
    assert calls == []


def test_nightmare_switches_only_for_a_trap_on_a_plausible_sound_move(monkeypatch):
    pol = [("e2e4", 0.50), ("d2d4", 0.30), ("g1f3", 0.04)]
    # no bonus anywhere: top move
    _setup(monkeypatch, pol, cp={"e2e4": 30, "d2d4": 25, "g1f3": 20})
    assert N.choose([], focus=0.6)["uci"] == "e2e4"
    # a strong trap behind the second most likely move: Sneaky plays it
    _setup(monkeypatch, pol, cp={"e2e4": 30, "d2d4": 25, "g1f3": 20}, trap={"d2d4": 0.2})
    r = N.choose([], focus=0.6)
    assert r["uci"] == "d2d4" and r["rank"] == 2 and r["trap"]
    # …but not when it's unsound (loses a lot by Stockfish)
    _setup(monkeypatch, pol, cp={"e2e4": 30, "d2d4": -400, "g1f3": 20}, trap={"d2d4": 0.2})
    assert N.choose([], focus=0.6)["uci"] == "e2e4"
    # …and never a move a player at this level hardly plays (4% vs 50%)
    _setup(monkeypatch, pol, cp={"e2e4": 30, "d2d4": 25, "g1f3": 20}, trap={"g1f3": 0.5})
    assert N.choose([], focus=0.9)["uci"] == "e2e4"


@pytest.mark.parametrize("focus,expected", [(0.2, "e2e4"), (0.9, "d2d4")])
def test_focus_sets_how_big_a_trap_must_be(monkeypatch, focus, expected):
    _setup(monkeypatch, [("e2e4", 0.50), ("d2d4", 0.25)], cp={"e2e4": 30, "d2d4": 28}, trap={"d2d4": 0.06})
    assert N.choose([], focus=focus)["uci"] == expected


def test_opening_variety_picks_among_common_moves_only(monkeypatch):
    _setup(monkeypatch, [("e2e4", 0.45), ("d2d4", 0.40), ("g1f3", 0.10), ("b2b4", 0.05)])
    seen = {N.choose([], focus=0, variety=True)["uci"] for _ in range(200)}
    assert seen == {"e2e4", "d2d4"}                  # g1f3 is under 30% of the top move: never
    # after the opening: the most likely move again
    moves = ["g1f3", "g8f6", "f3g1", "f6g8"] * 3     # 12 plies
    assert {N.choose(moves, focus=0, variety=True)["uci"] for _ in range(20)} == {"e2e4"}


def test_rating_comes_from_your_latest_games_on_the_site_you_play_now(tmp_path, monkeypatch):
    monkeypatch.setattr(N, "STATS_FILE", tmp_path / "nightmare.json")
    games = [{"me": "w", "whiteElo": str(e), "source": "lichess", "playedAt": t} for t, e in
             [(100, 1100), (200, 1200), (300, 1300), (400, 1380), (500, 1400), (600, 1410), (700, 1420), (800, 1390)]]
    games += [{"me": "b", "blackElo": "900", "source": "chess.com", "playedAt": 50},
              {"me": "w", "whiteElo": "", "source": "nightmare", "playedAt": 900}]
    monkeypatch.setattr(N.storage, "summaries", lambda: games)
    info = N.rating_info()
    assert info["site"] == "lichess" and info["auto"] == round((1380 + 1400 + 1410 + 1420 + 1390) / 5)
    assert not info["manual"] and N._rating() == pytest.approx(1400)
    monkeypatch.setattr(N, "summary", lambda: {})
    N.set_rating(1450)
    assert N.rating_info()["manual"] and N._rating() == 1450
    N.set_rating(None)
    assert not N.rating_info()["manual"]


def test_a_hanging_piece_is_not_a_trap(monkeypatch):
    # After 1.e4 e5 2.Nf3 the likely reply ...Qg5?? just hangs the queen: no trap.
    b = chess.Board()
    for s in ["e4", "e5", "Nf3"]:
        b.push_san(s)
    monkeypatch.setattr(N, "maia", lambda lv: FakeMaia([("d8g5", 0.5)]))

    def search(board, depth, moves=None):
        mv = (moves or [chess.Move.from_uci("b8c6")])[0]
        score = -900 if moves else 30
        pv = [mv, chess.Move.from_uci("f3g5")] if moves else [mv]
        return [C.Line(move=mv, score=chess.engine.PovScore(chess.engine.Cp(score), board.turn), pv=pv)]
    monkeypatch.setattr(N, "_search", search)
    monkeypatch.setattr(N.tactics, "theme_of_line", lambda *a: "free_piece")
    prof = N.Profile(rating=1200, k=C.LICHESS_K, themes={}, theme_counts=[], book={}, base_err=0.1, games=0, built=0)
    assert N._trap(b, 1200, C.LICHESS_K, prof) is None
    monkeypatch.setattr(N.tactics, "theme_of_line", lambda *a: "fork")
    assert N._trap(b, 1200, C.LICHESS_K, prof)["bad"][0]["theme"] == "fork"


def _game(gid, outcome, end, wins, me="w"):
    from app.insights import Game
    plies = len(wins) - 1
    moves = [{"ply": p, "fenBefore": f"7k/8/8/8/8/8/8/K7 w - - 0 {p}", "loss": 0.5 if p == plies - (plies % 2 == 0) else 0.01,
              "san": f"m{p}", "cls": "blunder", "bestSan": "x"} for p in range(1, plies + 1) if (p % 2 == 1) == (me == "w")]
    return Game(record={"id": gid, "white": "me", "black": "opp", "date": "2026.11.01"}, me=me, tc="rapid",
                moves=moves, my_wins=wins, outcome=outcome, ts=1000.0, elo=1300, opp_elo=1320, end=end)


def test_thrown_wins_start_where_you_were_last_clearly_winning(monkeypatch):
    wins = [50, 55, 72, 80, 85, 82, 75, 60, 30, 10, 5]          # winning, then it slipped away
    games = [_game("a", "loss", "resignation", wins), _game("b", "loss", "time", wins),
             _game("c", "win", "resignation", wins), _game("d", "draw", "agreement", wins),
             _game("e", "loss", "checkmate", [50, 52, 60, 55, 40, 20])]           # never clearly winning
    monkeypatch.setattr(N.insights, "_games", lambda: games)
    monkeypatch.setattr(N.storage, "summaries", lambda: [{"id": g.record["id"], "source": "lichess"} for g in games])
    t = N.thrown_wins(70)
    assert [x["gameId"] for x in t] == ["a"]                       # lost on time / won / drawn / never winning: out
    # your last move with ≥70% before it: ply 7 (position index 6 = 75%)
    assert t[0]["ply"] == 7 and t[0]["win"] == 75 and t[0]["fen"].endswith(" 7") and t[0]["moveNumber"] == 7 and t[0]["peak"] == 85
    assert [x["gameId"] for x in N.thrown_wins(70, draws=True)] == ["a", "d"]
    assert N.thrown_wins(90) == []
