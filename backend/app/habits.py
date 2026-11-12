"""Coaching: the bad habits behind your mistakes, and the mistakes you repeat move for move.

`tags()` labels one of your mistakes with the habits it shows (computed once per game inside the
insights cache). `compute()` turns them into a ranked coaching report: how often per 100 games,
whether it's getting better or worse lately, what it costs, real examples, and a fix.
"""
from __future__ import annotations

from collections import defaultdict

import chess

from . import classify as C

ERRORS = {C.INACCURACY, C.MISTAKE, C.MISS, C.BLUNDER}
SEVERE = {C.MISTAKE, C.MISS, C.BLUNDER}
RECENT_GAMES = 100   # "lately" = your last 100 games …
BEFORE_GAMES = 200   # … compared with the 200 before

HABITS: dict[str, dict[str, str]] = {
    "loose_piece": {
        "title": "Moving pieces to unprotected squares",
        "why": "You put a piece on a square where it can simply be taken – nothing defends it.",
        "fix": "Before you let go of a piece: can it be captured where it lands, and is it defended there?",
    },
    "pawn_range": {
        "title": "Putting pieces where a pawn can take them",
        "why": "A knight, bishop, rook or queen lands on a square an enemy pawn attacks – a pawn for a piece.",
        "fix": "Look at the two squares diagonally in front of every enemy pawn: never park a piece there.",
    },
    "ignored_threat": {
        "title": "Ignoring your opponent's threat",
        "why": "Your opponent's last move threatened something and you played your own plan instead of answering it.",
        "fix": "After every opponent move, ask first: what does that move want? Only then think about your plan.",
    },
    "removed_defender": {
        "title": "Moving a defender away",
        "why": "The piece you moved was guarding another one – after it left, that piece hangs.",
        "fix": "Before moving a piece, check what it is protecting right now.",
    },
    "allowed_mate": {
        "title": "Missing mating threats against you",
        "why": "After your move your opponent has a forced mate.",
        "fix": "Check every check your opponent could give after your move – especially on your back rank.",
    },
    "king_cover": {
        "title": "Weakening your king's pawn shield",
        "why": "You pushed a pawn in front of your castled king and it cost you – the holes let pieces in.",
        "fix": "Leave the three pawns in front of your castled king alone unless there's a concrete reason.",
    },
    "greedy": {
        "title": "Grabbing poisoned material",
        "why": "You captured something and it turned out to be a trap – the opponent wins more back.",
        "fix": "Before taking, look at your opponent's best reply after the capture: why is this left for you?",
    },
    "missed_mate": {
        "title": "Missing mates you could deliver",
        "why": "You had a forced mate and played something else.",
        "fix": "When the enemy king is exposed, look at all your checks first – every move.",
    },
    "missed_punish": {
        "title": "Not punishing your opponent's mistakes",
        "why": "Your opponent had just blundered and you didn't take advantage.",
        "fix": "When your opponent's move looks odd, look for what it left undefended before your own plan.",
    },
    "relaxing": {
        "title": "Relaxing when you're winning",
        "why": "You were clearly winning and gave a big part of it back with one move.",
        "fix": "When winning: trade pieces, kill counterplay, and check your opponent's checks and captures every move.",
    },
    "stalemate_win": {
        "title": "Stalemating when you're winning",
        "why": "You were winning and your move left your opponent with no legal move – stalemate, a draw.",
        "fix": "Far ahead? Before every move, check that your opponent will still have a legal move – especially when their king is boxed in.",
    },
    "repeat_win": {
        "title": "Repeating moves when you're winning",
        "why": "You repeated the position a third time while winning – the game was drawn.",
        "fix": "When you're winning and notice you've been here before, find a new plan instead of repeating checks.",
    },
    "early_queen": {
        "title": "Bringing the queen out too early",
        "why": "Early queen moves in the opening that cost you time or let your opponent develop with tempo.",
        "fix": "Develop knights and bishops and castle first – the queen comes out once the minor pieces are out.",
    },
    "tilt": {
        "title": "Blundering again right after a blunder",
        "why": "After one mistake you make another within a few moves – frustration and rushing.",
        "fix": "After a mistake: take a breath, re-evaluate the new position calmly, then look for the best defence.",
    },
    "hasty": {
        "title": "Moving too fast in critical moments",
        "why": "Many of your blunders are played in under 3 seconds – no time to see the threat.",
        "fix": "When there are captures or checks on the board, spend at least a few seconds on a blunder check.",
    },
}


def _opp_mates(ev: dict | None, opp: chess.Color) -> bool:
    mate = (ev or {}).get("mate")
    return mate is not None and mate != 0 and (mate > 0) == (opp == chess.WHITE)


def tags(moves: list[dict], i: int) -> list[str]:
    """Habits shown by your move moves[i] (one of your inaccuracies/mistakes/blunders)."""
    m = moves[i]
    if m["cls"] not in ERRORS:
        return []
    severe = m["cls"] in SEVERE and m["loss"] >= 0.06
    board = chess.Board(m["fenBefore"])
    me, opp = board.turn, not board.turn
    move = chess.Move.from_uci(m["uci"])
    moved = board.piece_type_at(move.from_square)
    after = board.copy(stack=False)
    after.push(move)
    out: list[str] = []

    if m["cls"] == C.MISS:
        my_mate = (m.get("bestEval") or {}).get("mate")
        had_mate = bool(my_mate) and (my_mate > 0) == (me == chess.WHITE)
        out.append("missed_mate" if had_mate else "missed_punish")
    if moved == chess.QUEEN and board.fullmove_number <= 10 and m["loss"] >= 0.04:
        out.append("early_queen")
    if not severe:
        return out
    if (m.get("epBest") or 0) >= 0.85 and m["loss"] >= 0.15:
        out.append("relaxing")
    # Throwing a win away by the rules: stalemate, or a third repetition.
    if (m.get("epBest") or 0) >= 0.75:
        if after.is_stalemate():
            out.append("stalemate_win")
        elif m.get("fen"):
            key = " ".join(m["fen"].split()[:4])
            seen = sum(1 for x in moves[:i + 1] if x.get("fen") and " ".join(x["fen"].split()[:4]) == key)
            if seen >= 3:
                out.append("repeat_win")

    nxt = moves[i + 1] if i + 1 < len(moves) else None
    if nxt is None:
        return out
    if _opp_mates(nxt.get("bestEval"), opp) and not _opp_mates(m.get("bestEval"), opp):
        out.append("allowed_mate")

    try:
        ref = chess.Move.from_uci(nxt["bestUci"])
    except (KeyError, ValueError):
        return out
    if ref not in after.legal_moves:
        return out
    target = ref.to_square
    hanging = C._en_prise(after, me)
    victim = after.piece_type_at(target)

    # Before your move, with the opponent to move (= what they were already threatening).
    nb = None
    if not board.is_check():
        nb = board.copy(stack=False)
        nb.push(chess.Move.null())

    if after.is_capture(ref) and target == move.to_square and moved not in (chess.PAWN, chess.KING):
        if after.piece_type_at(ref.from_square) == chess.PAWN and moved != chess.PAWN:
            out.append("pawn_range")
        elif target in hanging:
            out.append("loose_piece")
    elif after.is_capture(ref) and victim and victim != chess.PAWN and target in hanging:
        # Already threatened = it could already be won before your move (not merely attacked but defended).
        threatened_before = (nb is not None and ref in nb.legal_moves and nb.piece_type_at(target) == victim
                             and target in C._en_prise(nb, me))
        if threatened_before:
            out.append("ignored_threat")
        elif move.from_square in board.attackers(me, target):
            out.append("removed_defender")
    if nb is not None and "ignored_threat" not in out and ref in nb.legal_moves:
        t = nb.copy(stack=False)
        t.push(ref)
        if t.is_checkmate():
            out.append("ignored_threat")  # the mate was already threatened

    # Pawn moves in front of your castled king.
    king = board.king(me)
    if moved == chess.PAWN and king is not None and chess.square_rank(king) == (0 if me == chess.WHITE else 7):
        kf, pf = chess.square_file(king), chess.square_file(move.from_square)
        if (kf >= 5 and pf >= 5) or (kf <= 2 and pf <= 2):
            out.append("king_cover")

    # Captures that backfire (not simple recaptures).
    if board.is_capture(move) and i > 0 and m["loss"] >= 0.10:
        prev = moves[i - 1]
        recapture = prev.get("capture") and chess.Move.from_uci(prev["uci"]).to_square == move.to_square
        if not recapture:
            out.append("greedy")
    return out


# --------------------------------------------------------------------------- #
#  The coaching report
# --------------------------------------------------------------------------- #

def _ref(g, m: dict) -> dict:
    r = g.record
    return {"gameId": r["id"], "ply": m["ply"], "san": m["san"], "cls": m["cls"], "bestSan": m["bestSan"],
            "fenBefore": m["fenBefore"], "uci": m.get("uci"), "bestUci": m.get("bestUci"),
            "white": r.get("white"), "black": r.get("black"), "date": r.get("date"), "loss": m["loss"]}


_memo: tuple | None = None  # (reviews signature, report)


def compute() -> dict:
    """The coaching report (cached until a review changes)."""
    global _memo
    from . import storage
    from .config import my_names
    sig = hash((tuple(sorted(storage.index())), frozenset(my_names())))
    if _memo and _memo[0] == sig:
        return _memo[1]
    report = _compute()
    _memo = (sig, report)
    return report


def _compute() -> dict:
    from . import insights  # late import: insights calls tags() while building its cache

    games = sorted(insights._games(), key=lambda g: g.ts)
    if not games:
        return {"games": 0, "habits": [], "repeats": [], "checklist": []}
    n = len(games)
    recent_ids = {id(g) for g in games[-RECENT_GAMES:]}
    before_ids = {id(g) for g in games[-(RECENT_GAMES + BEFORE_GAMES):-RECENT_GAMES]}

    hits: dict[str, list[tuple]] = defaultdict(list)
    seen_pos: dict[str, int] = defaultdict(int)          # how often you reached a position (your move)
    repeat: dict[tuple[str, str], list[tuple]] = defaultdict(list)
    # Serious errors per move while the game is alive: within three moves of the last one, and otherwise.
    # Errors cluster partly by chance (sharp positions); "tilt" is only the part above your normal rate.
    rate = {True: [0, 0], False: [0, 0]}
    for g in games:
        last_bad = -99
        for j, m in enumerate(g.moves):
            epd = " ".join(m["fenBefore"].split()[:4])  # position without move counters
            seen_pos[epd] += 1
            severe = m["cls"] in SEVERE and m["loss"] >= 0.06
            # Not in an already-lost position.
            alive = g.my_wins[m["ply"] - 1] >= 30 if m["ply"] - 1 < len(g.my_wins) else True
            if alive:
                r = rate[j - last_bad <= 3]
                r[0] += 1
                r[1] += severe
            if m["cls"] not in ERRORS:
                continue
            for t in m.get("habits") or []:
                hits[t].append((g, m))
            if severe:
                # Another one within three moves – while the game was still alive.
                if j - last_bad <= 3 and alive:
                    hits["tilt"].append((g, m))
                last_bad = j
                if m.get("spent") is not None and m["spent"] <= 3 and g.tc not in ("bullet", "unknown"):
                    hits["hasty"].append((g, m))
            if m["loss"] >= 0.05:
                repeat[(epd, m["san"])].append((g, m))

    after_err, otherwise = (rate[k][1] / rate[k][0] if rate[k][0] else 0.0 for k in (True, False))
    # Share of the "another error right after" cases that your normal error rate doesn't explain.
    tilt_share = max(0.0, 1 - otherwise / after_err) if after_err else 0.0
    if after_err < 1.3 * otherwise:
        hits.pop("tilt", None)  # no more errors after an error than at other times: not a habit

    habits = []
    n_recent = sum(1 for g in games if id(g) in recent_ids)
    n_before = sum(1 for g in games if id(g) in before_ids)
    recent_n = max(1, n_recent)
    for key, pairs in hits.items():
        if key not in HABITS or len(pairs) < 3:
            continue
        ids = {g.record["id"] for g, _ in pairs}
        recent_g = {g.record["id"] for g, _ in pairs if id(g) in recent_ids}
        before_g = {g.record["id"] for g, _ in pairs if id(g) in before_ids}
        cost = sum(m["loss"] for _, m in pairs) / len(pairs)
        share = tilt_share if key == "tilt" else 1.0  # tilt: only what goes beyond chance counts
        newest = sorted(pairs, key=lambda p: (-p[0].ts, p[1]["ply"]))
        # History: share of games showing it, per block of 100 games (oldest first, last 10 blocks).
        hist = []
        for start in range(max(0, n - 1000), n, 100):
            block = {g.record["id"] for g in games[start:start + 100]}
            if len(block) >= 50:
                hist.append(round(len(ids & block) / len(block) * 100, 1))
        info = dict(HABITS[key])
        if key == "tilt":
            info["why"] = (f"After a serious mistake you make another within your next 3 moves {after_err:.0%} of the time "
                           f"– at other times only {otherwise:.0%} of your moves are one. Frustration and rushing.")
        habits.append({
            "key": key, **info, "history": hist,
            "count": len(pairs), "games": len(ids),
            # Share of your games it shows up in: overall, lately, and in the games before that.
            "pct": round(len(ids) / n * 100, 1),
            "recentPct": round(len(recent_g) / recent_n * 100, 1) if n_recent else None,
            "beforePct": round(len(before_g) / n_before * 100, 1) if n_before >= 30 else None,
            "cost": round(cost, 3),
            # What it costs you per game on average (expected points) – overall and in your recent games.
            "impact": round(len(pairs) / n * cost * share, 4),
            "recentImpact": round(sum(1 for g, _ in pairs if id(g) in recent_ids) / recent_n * cost * share, 4) if n_recent else None,
            "examples": [_ref(g, m) for g, m in newest[:60]],
            # What "Drill these positions" builds from: the examples are only the newest few, and just some
            # positions make a clear puzzle.
            "drill": [[g.record["id"], m["ply"]] for g, m in newest[:400]],
        })
    # Rank by what it costs you *now* (recent games) more than by your whole history.
    habits.sort(key=lambda h: -(0.65 * (h["recentImpact"] if h["recentImpact"] is not None else h["impact"]) + 0.35 * h["impact"]))

    repeats = []
    for (epd, san), pairs in repeat.items():
        if len({g.record["id"] for g, _ in pairs}) < 2:
            continue
        g0, m0 = max(pairs, key=lambda p: p[0].ts)
        reached = seen_pos[epd]
        repeats.append({
            "fenBefore": m0["fenBefore"], "san": san, "uci": m0.get("uci"), "bestSan": m0["bestSan"],
            "bestUci": m0.get("bestUci"), "times": len(pairs), "reached": reached,
            "cost": round(sum(m["loss"] for _, m in pairs) / len(pairs), 3),
            "moveNo": m0["ply"] // 2 + 1, "lastGame": g0.record["id"], "lastPly": m0["ply"],
            "refs": [_ref(g, m) for g, m in pairs],
        })
    repeats.sort(key=lambda r: -(r["times"] * r["cost"]))

    checklist = [{"key": h["key"], "question": h["fix"]} for h in habits[:4]]
    return {"games": n, "recentGames": n_recent, "beforeGames": n_before, "habits": habits,
            "repeats": repeats[:24], "repeatTotal": len(repeats), "checklist": checklist}


def game_habits(record: dict) -> list[dict]:
    """Habits you showed in one game (for the review summary), with the moves where they happened."""
    me = record.get("me")
    if not me:
        return []
    moves = record.get("moves", [])
    found: dict[str, list[int]] = defaultdict(list)
    last_bad = -99
    mine = 0
    for i, m in enumerate(moves):
        if m["color"] != me:
            continue
        mine += 1
        if m["cls"] not in ERRORS:
            continue
        try:
            for t in tags(moves, i):
                found[t].append(m["ply"])
        except (KeyError, ValueError):
            continue
        if m["cls"] in SEVERE and m["loss"] >= 0.06:
            alive = (m.get("epBest") or 0) >= 0.3
            if mine - last_bad <= 3 and alive:
                found["tilt"].append(m["ply"])
            last_bad = mine
    order = sorted(found.items(), key=lambda kv: -len(kv[1]))
    return [{"key": k, "title": HABITS[k]["title"], "fix": HABITS[k]["fix"], "plies": v} for k, v in order if k in HABITS]
