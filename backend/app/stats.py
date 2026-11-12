"""Progress dashboard and "when do you play best" statistics, from the insights cache (no engine).

Everything here is per game: results, ratings, activity, timing, sessions, game length, opponents,
personal records, and a "getting better / worse" comparison of your recent games with the ones before.
"""
from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime

from . import classify as C
from . import insights, storage
from .config import my_names

RECENT, BEFORE = 50, 200
SESSION_GAP = 45 * 60      # a pause longer than this starts a new session
SEVERE = {C.MISTAKE, C.BLUNDER, C.MISS}
_memo: tuple | None = None


def _sig():
    return hash((tuple(sorted(storage.index())), frozenset(my_names())))


def compute() -> dict:
    global _memo
    sig = _sig()
    if _memo and _memo[0] == sig:
        return _memo[1]
    out = _compute()
    _memo = (sig, out)
    return out


# --------------------------------------------------------------------------- #
#  Per-game facts
# --------------------------------------------------------------------------- #

def _facts(g, source: str | None) -> dict:
    mv = g.moves
    acc = (g.record.get("accuracy") or {}).get(g.me)
    phases = defaultdict(list)
    for m in mv:
        phases[m["phase"]].append(m["acc"])
    timed = [m for m in mv if m.get("remaining") is not None]
    return {
        "g": g, "id": g.record["id"], "ts": g.ts, "outcome": g.outcome, "tc": g.tc, "source": source or "pgn",
        "elo": g.elo, "opp": g.opp_elo, "acc": acc, "n": len(mv), "white": g.me == "w",
        "blunders": sum(m["cls"] == C.BLUNDER for m in mv), "mistakes": sum(m["cls"] == C.MISTAKE for m in mv),
        "misses": sum(m["cls"] == C.MISS for m in mv), "inacc": sum(m["cls"] == C.INACCURACY for m in mv),
        "brilliant": sum(m["cls"] == C.BRILLIANT for m in mv), "great": sum(m["cls"] == C.GREAT for m in mv),
        "phase": {k: sum(v) / len(v) for k, v in phases.items() if v}, "phase_n": {k: len(v) for k, v in phases.items()},
        "max_win": max(g.my_wins) if g.my_wins else 50, "min_win": min(g.my_wins) if g.my_wins else 50,
        "timed": bool(timed),
        "tt_blunders": sum(1 for m in timed if m["cls"] in SEVERE and m["remaining"] is not None and m["remaining"] < 30),
        "end": g.end, "white_name": g.record.get("white"), "black_name": g.record.get("black"),
        "date": g.record.get("date"), "opening": g.record.get("opening"),
    }


def _score(fs) -> float | None:
    rated = [f for f in fs if f["outcome"] in ("win", "draw", "loss")]
    if not rated:
        return None
    return round(sum(1 if f["outcome"] == "win" else 0.5 if f["outcome"] == "draw" else 0 for f in rated) / len(rated) * 100, 1)


def _acc(fs) -> float | None:
    rows = [(f["acc"], f["n"]) for f in fs if f["acc"] is not None and f["n"] >= 10]
    n = sum(w for _, w in rows)
    return round(sum(a * w for a, w in rows) / n, 1) if n else None


def _per_game(fs, key) -> float | None:
    return round(sum(f[key] for f in fs) / len(fs), 2) if fs else None


def _phase_acc(fs, phase) -> float | None:
    tot = sum(f["phase"].get(phase, 0) * f["phase_n"].get(phase, 0) for f in fs)
    n = sum(f["phase_n"].get(phase, 0) for f in fs)
    return round(tot / n, 1) if n >= 30 else None


def _rate(fs, cond, ok) -> float | None:
    pool = [f for f in fs if cond(f)]
    return round(sum(1 for f in pool if ok(f)) / len(pool) * 100, 1) if len(pool) >= 5 else None


def _block(fs) -> dict:
    """The headline numbers for a set of games."""
    return {"games": len(fs), "score": _score(fs), "accuracy": _acc(fs),
            "wins": sum(f["outcome"] == "win" for f in fs), "draws": sum(f["outcome"] == "draw" for f in fs),
            "losses": sum(f["outcome"] == "loss" for f in fs)}


# --------------------------------------------------------------------------- #
#  The report
# --------------------------------------------------------------------------- #

METRICS = [
    # key, label, unit, higher is better, how to compute
    ("accuracy", "Accuracy", "%", True, lambda fs: _acc(fs)),
    ("score", "Score", "%", True, lambda fs: _score(fs)),
    ("blunders", "Blunders per game", "", False, lambda fs: _per_game(fs, "blunders")),
    ("mistakes", "Mistakes per game", "", False, lambda fs: _per_game(fs, "mistakes")),
    ("misses", "Missed chances per game", "", False, lambda fs: _per_game(fs, "misses")),
    ("opening", "Opening accuracy", "%", True, lambda fs: _phase_acc(fs, "opening")),
    ("middlegame", "Middlegame accuracy", "%", True, lambda fs: _phase_acc(fs, "middlegame")),
    ("endgame", "Endgame accuracy", "%", True, lambda fs: _phase_acc(fs, "endgame")),
    ("convert", "Winning positions converted", "%", True,
     lambda fs: _rate(fs, lambda f: f["max_win"] >= insights.WINNING_PCT, lambda f: f["outcome"] == "win")),
    ("save", "Lost positions saved", "%", True,
     lambda fs: _rate(fs, lambda f: f["min_win"] <= insights.LOSING_PCT, lambda f: f["outcome"] in ("win", "draw"))),
    ("time_trouble", "Time-trouble errors per game", "", False,
     lambda fs: _per_game([f for f in fs if f["timed"]], "tt_blunders")),
    ("brilliant", "Brilliant + great moves per game", "", True,
     lambda fs: round(sum(f["brilliant"] + f["great"] for f in fs) / len(fs), 2) if fs else None),
]


def _compute() -> dict:
    sources = {s["id"]: s.get("source") for s in storage.summaries()}
    games = sorted(insights._games(), key=lambda g: g.ts)
    fs = [_facts(g, sources.get(g.record["id"])) for g in games]
    if not fs:
        return {"games": 0}
    recent, before = fs[-RECENT:], fs[-(RECENT + BEFORE):-RECENT]

    # ---- record & streaks ------------------------------------------------------------------
    cur = {"kind": None, "n": 0}
    best_win = best_unbeaten = run_w = run_u = 0
    for f in fs:
        o = f["outcome"]
        run_w = run_w + 1 if o == "win" else 0
        run_u = run_u + 1 if o in ("win", "draw") else 0
        best_win, best_unbeaten = max(best_win, run_w), max(best_unbeaten, run_u)
    for f in reversed(fs):
        if cur["kind"] is None:
            cur = {"kind": f["outcome"], "n": 1}
        elif f["outcome"] == cur["kind"]:
            cur["n"] += 1
        else:
            break
    record = {"all": _block(fs), "recent": _block(recent),
              "white": _block([f for f in fs if f["white"]]), "black": _block([f for f in fs if not f["white"]]),
              "streak": cur, "bestWinStreak": best_win, "bestUnbeaten": best_unbeaten}

    # ---- ratings per platform & time control -----------------------------------------------
    series: dict[tuple, list] = defaultdict(list)
    for f in fs:
        if f["elo"]:
            series[(f["source"], f["tc"])].append((f["ts"], f["elo"]))
    now = time.time()
    ratings = []
    for (src, tc), pts in sorted(series.items(), key=lambda kv: -len(kv[1]))[:4]:
        if len(pts) < 5:
            continue
        monthly: dict[str, int] = {}
        for ts, elo in pts:
            monthly[datetime.fromtimestamp(ts).strftime("%Y-%m")] = elo  # last game of the month
        ago90 = [e for ts, e in pts if ts <= now - 90 * 86400]
        ratings.append({"source": src, "tc": tc, "games": len(pts), "current": pts[-1][1],
                        "peak": max(e for _, e in pts), "low": min(e for _, e in pts),
                        "change90": pts[-1][1] - ago90[-1] if ago90 else None,
                        "points": [{"month": k, "elo": v} for k, v in sorted(monthly.items())]})

    # ---- activity calendar (last year) --------------------------------------------------------
    cal: dict[str, list] = defaultdict(lambda: [0, 0])  # date -> games, points
    for f in fs:
        if f["ts"] >= now - 371 * 86400:
            d = datetime.fromtimestamp(f["ts"]).strftime("%Y-%m-%d")
            cal[d][0] += 1
            cal[d][1] += 1 if f["outcome"] == "win" else 0.5 if f["outcome"] == "draw" else 0
    activity = [{"date": d, "games": v[0], "score": round(v[1] / v[0] * 100)} for d, v in sorted(cal.items())]

    # ---- when do you play best ----------------------------------------------------------------
    timed = [f for f in fs if f["ts"] % 86400 != 43200]  # no clock time in the PGN → can't place it in the day
    def bucket_rows(groups: dict[str, list], order: list[str]) -> list[dict]:
        rows = []
        for k in order:
            g = groups.get(k, [])
            if len(g) >= 5:
                rows.append({"bucket": k, **_block(g), "blunders": _per_game(g, "blunders")})
        return rows
    hours: dict[str, list] = defaultdict(list)
    for f in timed:
        h = datetime.fromtimestamp(f["ts"]).hour
        hours["Night (0–6)" if h < 6 else "Morning (6–12)" if h < 12 else "Afternoon (12–18)" if h < 18 else "Evening (18–24)"].append(f)
    days: dict[str, list] = defaultdict(list)
    for f in timed:
        days[datetime.fromtimestamp(f["ts"]).strftime("%a")].append(f)
    # Sessions: game 1, 2, 3 … of a sitting.
    session_idx: dict[str, list] = defaultdict(list)
    after: dict[str, list] = defaultdict(list)
    prev = None
    k = 0
    for f in timed:
        if prev is None or f["ts"] - prev["ts"] > SESSION_GAP:
            k = 1
        else:
            k += 1
            after["After a win" if prev["outcome"] == "win" else "After a loss" if prev["outcome"] == "loss" else "After a draw"].append(f)
        session_idx["1st" if k == 1 else "2nd" if k == 2 else "3rd" if k == 3 else "4th–5th" if k <= 5 else "6th+"].append(f)
        prev = f
    timing = {
        "hours": bucket_rows(hours, ["Morning (6–12)", "Afternoon (12–18)", "Evening (18–24)", "Night (0–6)"]),
        "weekdays": bucket_rows(days, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
        "session": bucket_rows(session_idx, ["1st", "2nd", "3rd", "4th–5th", "6th+"]),
        "after": bucket_rows(after, ["After a win", "After a draw", "After a loss"]),
    }

    # ---- game length & opponents --------------------------------------------------------------
    length: dict[str, list] = defaultdict(list)
    for f in fs:
        n = f["n"]
        length["< 20 moves" if n < 20 else "20–34" if n < 35 else "35–49" if n < 50 else "50–69" if n < 70 else "70+"].append(f)
    opp: dict[str, list] = defaultdict(list)
    for f in fs:
        if f["elo"] and f["opp"]:
            d = f["opp"] - f["elo"]
            opp["−200 or weaker" if d <= -200 else "−199 to −75" if d < -75 else "about equal" if d <= 75 else "+75 to +199" if d < 200 else "+200 or stronger"].append(f)
    tcs: dict[str, list] = defaultdict(list)
    for f in fs:
        tcs[f["tc"]].append(f)
    breakdown = {
        "length": bucket_rows(length, ["< 20 moves", "20–34", "35–49", "50–69", "70+"]),
        "opponent": bucket_rows(opp, ["−200 or weaker", "−199 to −75", "about equal", "+75 to +199", "+200 or stronger"]),
        "timeControl": bucket_rows(tcs, ["bullet", "blitz", "rapid", "classical", "daily"]),
    }

    # ---- personal records ---------------------------------------------------------------------------
    def ref(f, extra=None):
        opp_name = f["black_name"] if f["white"] else f["white_name"]
        return {"gameId": f["id"], "opponent": opp_name, "date": f["date"], **(extra or {})}
    long_enough = [f for f in fs if f["n"] >= 20 and f["acc"] is not None]
    records = []
    if long_enough:
        b = max(long_enough, key=lambda f: f["acc"])
        records.append({"key": "accuracy", "title": "Most accurate game", "value": f"{b['acc']:.1f}%", **ref(b, {"detail": f"{b['n']} moves"})})
    if fs:
        b = max(fs, key=lambda f: (f["brilliant"], f["great"]))
        if b["brilliant"] + b["great"]:
            records.append({"key": "brilliant", "title": "Most brilliant game", "value": f"{b['brilliant']}!! {b['great']}!", **ref(b)})
    upsets = [f for f in fs if f["outcome"] == "win" and f["elo"] and f["opp"]]
    if upsets:
        b = max(upsets, key=lambda f: f["opp"] - f["elo"])
        if b["opp"] > b["elo"]:
            records.append({"key": "upset", "title": "Biggest upset win", "value": f"+{b['opp'] - b['elo']}", **ref(b, {"detail": f"vs {b['opp']}"})})
    comebacks = [f for f in fs if f["outcome"] == "win"]
    if comebacks:
        b = min(comebacks, key=lambda f: f["min_win"])
        if b["min_win"] <= insights.LOSING_PCT:
            records.append({"key": "comeback", "title": "Greatest comeback", "value": f"{b['min_win']:.0f}%", **ref(b, {"detail": "lowest win chance, then won"})})
    mates = [f for f in fs if f["outcome"] == "win" and f["end"] == "checkmate"]
    if mates:
        b = min(mates, key=lambda f: f["n"])
        records.append({"key": "fastmate", "title": "Fastest checkmate", "value": f"{b['n']} moves", **ref(b)})
    if fs:
        b = max(fs, key=lambda f: f["n"])
        records.append({"key": "longest", "title": "Longest game", "value": f"{b['n']} moves", **ref(b, {"detail": b["outcome"]})})
    if fs:
        records.append({"key": "streak", "title": "Longest win streak", "value": f"{best_win} games"})

    # ---- getting better / worse ----------------------------------------------------------------------
    trend = []
    for key, label, unit, higher, fn in METRICS:
        now_v, then_v, all_v = fn(recent), fn(before) if len(before) >= 30 else None, fn(fs)
        if now_v is None or (now_v == 0 and not then_v):
            continue  # nothing to say (e.g. you never get into time trouble)
        delta = None if then_v is None else round(now_v - then_v, 2)
        better = None if delta is None else (delta > 0) == higher if delta != 0 else None
        # Relative size of the change, to tell real movement from noise.
        rel = abs(delta) / max(abs(then_v), 1e-9) if delta is not None and then_v else 0
        trend.append({"key": key, "label": label, "unit": unit, "higherBetter": higher, "recent": now_v,
                      "before": then_v, "all": all_v, "delta": delta, "better": better,
                      "notable": delta is not None and rel >= 0.08})

    return {"games": len(fs), "recentGames": len(recent), "beforeGames": len(before), "record": record,
            "ratings": ratings, "activity": activity, "timing": timing, "breakdown": breakdown,
            "records": records, "trend": trend}


# --------------------------------------------------------------------------- #
#  Coaching conclusions: strengths, warning signs and a short training plan
# --------------------------------------------------------------------------- #

def _row(rows: list[dict], bucket: str) -> dict | None:
    return next((r for r in rows if r["bucket"] == bucket), None)


def coach_extras(habit_report: dict) -> dict:
    s = compute()
    if not s.get("games"):
        return {"strengths": [], "warnings": [], "plan": []}
    overall = s["record"]["all"]["score"] or 50
    warnings, strengths = [], []
    t, b = s["timing"], s["breakdown"]

    # Sessions: does your level drop after many games in a row?
    late, first = _row(t["session"], "6th+"), _row(t["session"], "1st")
    if late and first and late["games"] >= 30 and late["score"] is not None and first["score"] is not None \
            and late["score"] <= first["score"] - 7:
        warnings.append({"key": "session", "title": "You get worse in long sessions",
                         "text": f"Your 6th+ game of a sitting scores {late['score']:.0f}% – your first game {first['score']:.0f}%.",
                         "tip": "Stop after 5 games in a row, or take a real break before the next one."})
    # Tilt between games.
    lost, won = _row(t["after"], "After a loss"), _row(t["after"], "After a win")
    if lost and won and lost["games"] >= 50 and lost["score"] is not None and won["score"] is not None \
            and lost["score"] <= won["score"] - 3:
        warnings.append({"key": "after_loss", "title": "Losses follow losses",
                         "text": f"Right after a loss you score {lost['score']:.0f}%, after a win {won['score']:.0f}%.",
                         "tip": "After a loss, review it briefly (or do 5 blunder-check cards) before queueing again."})
    # Time of day.
    hrs = [r for r in t["hours"] if r["games"] >= 40 and r["score"] is not None]
    if len(hrs) >= 2:
        best, worst = max(hrs, key=lambda r: r["score"]), min(hrs, key=lambda r: r["score"])
        if best["score"] - worst["score"] >= 6:
            warnings.append({"key": "time_of_day", "title": f"{worst['bucket'].split(' ')[0]} games go worse",
                             "text": f"{worst['bucket']}: {worst['score']:.0f}% score – {best['bucket']}: {best['score']:.0f}%.",
                             "tip": f"Play your serious games in the {best['bucket'].split(' ')[0].lower()}."})
        if best["score"] >= overall + 2:
            strengths.append({"key": "best_time", "title": f"You play best in the {best['bucket'].split(' ')[0].lower()}",
                              "text": f"{best['score']:.0f}% score over {best['games']} games."})
    # Time controls.
    tcs = [r for r in b["timeControl"] if r["games"] >= 20 and r["score"] is not None]
    if len(tcs) >= 2:
        best, worst = max(tcs, key=lambda r: r["score"]), min(tcs, key=lambda r: r["score"])
        if best["score"] - worst["score"] >= 10:
            warnings.append({"key": "tc", "title": f"{worst['bucket'].capitalize()} isn't working for you",
                             "text": f"{worst['bucket'].capitalize()}: {worst['score']:.0f}% score – {best['bucket']}: {best['score']:.0f}%.",
                             "tip": f"Focus on {best['bucket']} for rating, or review your {worst['bucket']} losses for a pattern."})
    # Short games: early collapses.
    short = _row(b["length"], "< 20 moves")
    if short and short["games"] >= 50 and short["score"] is not None and short["score"] <= overall - 6:
        warnings.append({"key": "short", "title": "Too many games end early",
                         "text": f"{short['games']} games ended within 20 of your moves – you score {short['score']:.0f}% in them.",
                         "tip": "Early losses usually come from opening traps and hanging pieces: train your openings and the blunder check."})
    longer = _row(b["length"], "50–69")
    if longer and longer["games"] >= 30 and longer["score"] is not None and longer["score"] >= overall + 5:
        strengths.append({"key": "long", "title": "You're strong in long games",
                          "text": f"Games of 50–69 moves: {longer['score']:.0f}% score – patience pays off for you."})

    # Recent trend: what's improving, what's slipping.
    for m in s["trend"]:
        if not m["notable"] or m["before"] is None or m["better"] is None:
            continue
        unit = m["unit"]
        line = f"{m['before']}{unit} → {m['recent']}{unit} (last {s['recentGames']} games vs the {s['beforeGames']} before)."
        if m["better"]:
            strengths.append({"key": f"up_{m['key']}", "title": f"Improving: {m['label'].lower()}", "text": line})
        else:
            warnings.append({"key": f"down_{m['key']}", "title": f"Slipping: {m['label'].lower()}", "text": line,
                             "tip": _TREND_TIPS.get(m["key"], "Look at your recent games in Insights for this one.")})
    # Best phase.
    phases = [m for m in s["trend"] if m["key"] in ("opening", "middlegame", "endgame") and m["all"] is not None]
    if phases:
        best = max(phases, key=lambda m: m["all"])
        strengths.append({"key": "phase", "title": f"Your {best['key']} is your strongest phase",
                          "text": f"{best['all']:.1f}% move accuracy across all your games."})

    # A short plan: the most expensive habit, your repeated mistakes, the biggest warning sign, the Nightmare.
    plan = []
    habits = habit_report.get("habits") or []
    if habits:
        h = habits[0]
        plan.append({"key": "habit", "title": f"Drill: {h['title'].lower()}",
                     "why": f"Your most expensive habit – in {h['pct']}% of your games.", "action": "drill-habit", "habit": h["key"]})
    if habit_report.get("repeats"):
        plan.append({"key": "repeats", "title": "Fix the moves you keep repeating",
                     "why": f"{habit_report.get('repeatTotal', 0)} positions where you played the same bad move in different games.",
                     "action": "drill-repeats"})
    if warnings:
        w = warnings[0]
        plan.append({"key": "warning", "title": w["title"], "why": w.get("tip") or w["text"],
                     "action": _WARNING_ACTION.get(w["key"], "none")})
    plan.append({"key": "nightmare", "title": "Play the Nightmare",
                 "why": "An opponent at your level that aims at exactly these weaknesses – then review the traps.",
                 "action": "nightmare"})
    return {"strengths": strengths[:6], "warnings": warnings[:6], "plan": plan[:4]}


_TREND_TIPS = {
    "convert": "Winning positions slip away: when ahead, trade pieces, stop counterplay and check every capture before moving.",
    "score": "Your results dipped lately – the habits below are the most likely reason.",
    "mistakes": "More mistakes lately: slow down in critical moments and run your blunder check.",
    "blunders": "More blunders lately: practise the blunder check before every move with captures or checks on the board.",
    "misses": "You let more chances slip: look for what your opponent's last move left undefended.",
    "endgame": "Endgames got worse: drill basic endgames and play them out slowly.",
    "middlegame": "Middlegame accuracy dropped: before each move, check captures, checks and threats for both sides.",
    "opening": "Opening accuracy dropped: train your repertoire in the opening trainer.",
    "accuracy": "Accuracy dropped: review your last few losses for a pattern.",
}
_WARNING_ACTION = {"after_loss": "blunder-check", "short": "openings", "down_convert": "nightmare",
                   "down_blunders": "blunder-check", "down_mistakes": "blunder-check", "down_opening": "openings"}
