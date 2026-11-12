import json
from datetime import date, timedelta

from app import training


def _use(tmp_path, monkeypatch, days=None, goal=10):
    f = tmp_path / "training.json"
    f.write_text(json.dumps({"goal": goal, "days": days or {}, "bestStreak": 0}))
    monkeypatch.setattr(training, "FILE", f)


def test_goal_and_streak(tmp_path, monkeypatch):
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    before = (date.today() - timedelta(days=2)).isoformat()
    _use(tmp_path, monkeypatch, {yesterday: {"points": 12}, before: {"points": 3}})
    s = training.summary(games=[])
    # Today is still open: yesterday's goal keeps the streak alive.
    assert s["streak"] == 1 and not s["goalMet"]
    training.log("safety", 6)
    training.log("puzzle", 2, first=2)
    s = training.summary(games=[])
    assert s["today"]["points"] == 10 and s["goalMet"] and s["streak"] == 2
    assert s["bestStreak"] == 2 and s["nextMilestone"] == 3
    assert len(s["calendar"]) == 84 and s["calendar"][-1]["points"] == 10


def test_goal_must_be_one_of_the_choices(tmp_path, monkeypatch):
    _use(tmp_path, monkeypatch)
    monkeypatch.setattr(training, "mastery", lambda data=None, games=None: [])
    assert training.set_goal(40)["goal"] == 40
    assert training.set_goal(7)["goal"] == training.DEFAULT_GOAL


def test_woodpecker_progress_logs_only_new_puzzles(tmp_path, monkeypatch):
    _use(tmp_path, monkeypatch)
    puzzles = [{"id": "a", "pattern": {"key": "fork"}}, {"id": "b", "pattern": {"key": "fork"}},
               {"id": "c", "pattern": {"key": "pin"}}]
    old = {"stats": {"puzzles_data": {"a": {"correct_first": True, "time": 5}}}}
    new = {"stats": {"puzzles_data": {"a": {"correct_first": True, "time": 5},
                                      "b": {"correct_first": True, "time": 8},
                                      "c": {"correct_first": False, "time": 20}}}}
    training.woodpecker_progress(puzzles, old, new)
    day = json.loads(training.FILE.read_text())["days"][date.today().isoformat()]
    assert day["counts"]["puzzle"] == 2 and day["points"] == 3       # 2 solved, 1 on the first try
    assert day["patterns"] == {"fork": [1, 1], "pin": [1, 0]}
    # Saving the same progress again (or a finished run with the same stats) adds nothing.
    training.woodpecker_progress(puzzles, new, new["stats"], final=True)
    assert json.loads(training.FILE.read_text())["days"][date.today().isoformat()]["counts"]["puzzle"] == 2
