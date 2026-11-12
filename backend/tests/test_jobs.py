import threading
import time

from app import jobs


def test_two_at_a_time_and_priority(monkeypatch):
    running, peak, started = set(), [0], []
    lock = threading.Lock()

    def fake(pgn, depth, progress=None):
        with lock:
            running.add(pgn)
            started.append((pgn, set(running)))
            peak[0] = max(peak[0], len(running))
        time.sleep(0.4 if pgn != "now" else 1.2)
        with lock:
            running.discard(pgn)
        return {"id": pgn, "headers": {}, "moves": [], "white": "a", "black": "b", "result": "1-0",
                "accuracy": {"w": 80.0, "b": 70.0}, "counts": {"w": {}, "b": {}}}

    monkeypatch.setattr(jobs.analysis, "analyse_game", fake)
    monkeypatch.setattr(jobs.storage, "save", lambda r: r)
    monkeypatch.setattr(jobs.storage, "load", lambda gid: None)
    monkeypatch.setattr(jobs.storage, "review_index", lambda: {})
    q = jobs.AnalysisQueue()
    q.add([{"pgn": f"g{i}", "id": f"g{i}"} for i in range(6)], 16)
    time.sleep(0.2)
    q.add([{"pgn": "now", "id": "now"}], 16, front=True)
    deadline = time.time() + 15
    while time.time() < deadline and q.list()["counts"]["done"] < 7:
        time.sleep(0.1)
    assert q.list()["counts"]["done"] == 7
    assert peak[0] == 2                          # two games at a time
    now_start = next(i for i, (p, _) in enumerate(started) if p == "now")
    assert now_start <= 2                        # "analyse now" jumped the queue
    # While it ran, no *new* batch game started alongside it.
    t_now = [s for s in started[now_start + 1:] if "now" in s[1]]
    assert not t_now
