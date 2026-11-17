"""Progress of slow jobs: visible while running, gone afterwards."""
from app import progress


def test_task_reports_steps_and_disappears():
    with progress.track("demo", "Reading", 10) as t:
        t.step(4)
        snap = [x for x in progress.snapshot() if x["name"] == "demo"]
        assert snap and snap[0]["done"] == 4 and snap[0]["total"] == 10 and snap[0]["label"] == "Reading"
        t.step(12, label="Scoring")
        snap = [x for x in progress.snapshot() if x["name"] == "demo"][0]
        assert snap["done"] == 10 and snap["label"] == "Scoring"  # never past the total
    assert not [x for x in progress.snapshot() if x["name"] == "demo"]


def test_task_is_removed_on_error():
    try:
        with progress.track("boom", "Working"):
            raise RuntimeError
    except RuntimeError:
        pass
    assert not [x for x in progress.snapshot() if x["name"] == "boom"]
