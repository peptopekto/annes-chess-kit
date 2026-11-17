from app import insights


def _record(pgn: str, tc: str, n: int) -> dict:
    return {"pgn": pgn, "headers": {"TimeControl": tc}, "moves": [{}] * n}


def test_move_times_from_clock_comments():
    pgn = ('[TimeControl "180+2"]\n\n1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:01]} '
           '2. Nf3 {[%clk 0:02:55.5]} Nc6 {[%clk 0:02:41]} *')
    t = insights.move_times(_record(pgn, "180+2", 4))
    assert t["clock"] == [180.0, 181.0, 175.5, 161.0]
    # spent = previous clock of the same side - clock now + increment (the first move counts from the base)
    assert t["spent"] == [2.0, 1.0, 6.5, 22.0]
    assert t["base"] == 180.0 and t["inc"] == 2.0


def test_no_move_times_without_clocks_or_for_daily_games():
    assert insights.move_times(_record("1. e4 e5 *", "600", 2)) is None
    daily = '[TimeControl "1/86400"]\n\n1. e4 {[%clk 23:59:59]} e5 {[%clk 23:00:00]} *'
    assert insights.move_times(_record(daily, "1/86400", 2)) is None
