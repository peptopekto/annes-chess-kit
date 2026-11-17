"""Opening trainer: your repertoire for an opening, and where you go wrong in it.

The repertoire tree combines three sources:
  * theory  – every named line of the opening in the Lichess openings book (all book moves count)
  * you     – what you and your opponents actually play (all imported + reviewed games);
              beyond the book your usual move stays your repertoire move if it's sound
  * Stockfish – checks moves beyond the book and replaces them only when clearly worse
"""
from __future__ import annotations

import json
import pickle
import re
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

import chess

from . import analysis, engine, openings, progress, storage
from . import classify as C
from .config import USERDATA, write_atomic

MAX_PLY = 24          # train the first 12 moves
MIN_VISITS = 2        # positions you reached at least this often are worth training
MAX_REPLIES = 5       # opponent replies kept per position
TOLERANCE = 0.03      # a move within 3% expected points of the best is fine
MISTAKE_MIN = 0.05    # report a habit as a mistake only if it costs at least this much
DEPTH = 16

CACHE_DIR = USERDATA / "cache"
STATS_FILE = USERDATA / "opening_stats.json"
_lock = threading.Lock()


# --------------------------------------------------------------------------- #
#  Corpus: opening moves from all your games
# --------------------------------------------------------------------------- #

_TOKEN_JUNK = re.compile(r"\{[^}]*\}|\([^)]*\)|\$\d+|\d+\.(\.\.)?|1-0|0-1|1/2-1/2|\*")


def _sans(pgn: str, limit: int = MAX_PLY) -> list[str]:
    movetext = pgn.split("\n\n", 1)[-1]
    return _TOKEN_JUNK.sub(" ", movetext).split()[:limit]


def _corpus_sources() -> list[tuple[str, str, str]]:
    """(game key, my colour, pgn) for every game we know – imported libraries and reviews."""
    out, seen = [], set()
    for f in sorted((USERDATA / "imports").glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for g in data.get("games", []):
            key = g.get("id") or g.get("url")
            if key and key not in seen and g.get("pgn"):
                seen.add(key)
                out.append((key, g.get("myColor") or "w", g["pgn"]))
    for gid, _ in storage.index():
        if gid in seen:
            continue
        r = storage.load(gid)
        if r and r.get("me") and r.get("startFen") == chess.STARTING_FEN:
            seen.add(gid)
            out.append((gid, r["me"], r["pgn"]))
    return out


def _corpus() -> dict:
    """{colour: {epd: Counter(uci)}} plus review losses {(colour, epd, uci): [loss…]}, cached on disk."""
    sig = (len(storage.index()),
           tuple(sorted((f.name, f.stat().st_mtime) for f in (USERDATA / "imports").glob("*.json"))))
    cache = CACHE_DIR / "opening_corpus.pkl"
    try:
        with cache.open("rb") as fh:
            saved_sig, data = pickle.load(fh)
        if saved_sig == sig:
            return data
    except (OSError, pickle.PickleError, EOFError, ValueError):
        pass

    task = progress.track("repertoire", "Collecting the moves of your games")
    try:
        return _build_corpus(cache, sig, task)
    finally:
        task.close()


def _build_corpus(cache, sig, task: progress.Task) -> dict:
    moves: dict[str, dict[str, Counter]] = {"w": defaultdict(Counter), "b": defaultdict(Counter)}
    for _, color, pgn in _corpus_sources():
        b = chess.Board()
        for san in _sans(pgn):
            try:
                m = b.parse_san(san)
            except ValueError:
                break
            moves[color][b.epd()][m.uci()] += 1
            b.push(m)

    losses: dict[tuple, list[float]] = defaultdict(list)
    index = storage.index()
    task.step(0, len(index), "Reading your reviews")
    for i, (gid, _) in enumerate(index):
        task.step(i)
        r = storage.load(gid)
        if not r or not r.get("me") or r.get("startFen") != chess.STARTING_FEN:
            continue
        for m in r["moves"][:MAX_PLY]:
            if m["color"] == r["me"]:
                losses[(r["me"], chess.Board(m["fenBefore"]).epd(), m["uci"])].append(m["loss"])

    data = {"moves": {c: dict(v) for c, v in moves.items()}, "losses": dict(losses)}
    write_atomic(cache, pickle.dumps((sig, data), protocol=pickle.HIGHEST_PROTOCOL))
    return data


def my_openings(limit: int = 6) -> list[dict]:
    """Your most-played openings (family + colour), by reviewed games."""
    c: Counter = Counter()
    for s in storage.summaries():
        if s.get("me") and s.get("opening"):
            fam = openings.family_of(s["opening"]["name"])
            if openings.family_roots().get(fam):
                c[(fam, s["me"])] += 1
    return [{"family": f, "color": col, "games": n} for (f, col), n in c.most_common(limit)]


# --------------------------------------------------------------------------- #
#  Engine helpers
# --------------------------------------------------------------------------- #

def _evaluate(fen: str, candidates: list[str]) -> dict:
    """Expected points (for the side to move) of the engine's top moves and of each candidate."""
    board = chess.Board(fen)
    pov = board.turn
    with engine.batch.acquire() as eng:
        lines = analysis.analyse_lines(eng, board, DEPTH, multipv=3, max_time=4.0)
        ep = {ln.move.uci(): C.expected_points(ln.score.pov(pov)) for ln in lines}
        for u in candidates:
            if u not in ep:
                mv = chess.Move.from_uci(u)
                if mv in board.legal_moves:
                    got = analysis.analyse_lines(eng, board, DEPTH, multipv=1, max_time=4.0, root_moves=[mv])
                    if got:
                        ep[u] = C.expected_points(got[0].score.pov(pov))
    best = max(ep, key=ep.get) if ep else None
    return {"ep": ep, "best": best}


# --------------------------------------------------------------------------- #
#  Repertoire tree
# --------------------------------------------------------------------------- #

def _san(board: chess.Board, uci: str) -> str:
    try:
        return board.san(chess.Move.from_uci(uci))
    except (ValueError, AssertionError):
        return uci


def build(family: str, color: str) -> dict:
    fb = openings.family_book(family)
    if not fb["root"]:
        raise ValueError(f"No book lines for '{family}'.")
    corpus = _corpus()
    seen_moves = corpus["moves"][color]
    losses = corpus["losses"]
    book_next = fb["next"]
    root = fb["root"]
    names = openings.book()
    me = chess.WHITE if color == "w" else chess.BLACK

    with progress.track("repertoire", "Checking your moves with the engine", MAX_PLY + 1) as task:
        return _build_tree(family, color, seen_moves, losses, book_next, root, names, me, task)


def _build_tree(family: str, color: str, seen_moves, losses, book_next, root, names, me, task: progress.Task) -> dict:
    nodes: dict[str, dict] = {}
    level = [(chess.Board(), None, None, "")]
    for ply in range(MAX_PLY + 1):
        task.step(ply)
        if not level:
            break
        # 1) create nodes for this level
        todo_engine = []
        for board, parent, via, name in level:
            epd = board.epd()
            if epd in nodes:
                continue
            here_name = names.get(epd, ("", ""))[1] or name
            counts = seen_moves.get(epd, Counter())
            node = {"epd": epd, "fen": board.fen(), "ply": ply, "user": board.turn == me,
                    "parent": parent, "via": via, "viaSan": None, "name": here_name,
                    "visits": sum(counts.values()), "children": {}}
            if parent is not None:
                node["viaSan"] = _san(chess.Board(nodes[parent]["fen"]), via)
            nodes[epd] = node
            if ply >= MAX_PLY:
                continue
            in_root = ply < len(root)
            book = book_next.get(epd, {})
            if node["user"]:
                played = [(u, n) for u, n in counts.most_common() if n >= MIN_VISITS]
                node["played"] = [{"uci": u, "san": _san(board, u), "count": n} for u, n in played]
                if in_root:
                    node.update(main=root[ply], allowed=[root[ply]], source="book")
                elif book:
                    by_use = sorted(book, key=lambda u: -counts.get(u, 0))
                    node.update(main=by_use[0], allowed=list(book), source="book")
                    # Need an engine opinion only if you usually play something else here.
                    if played and played[0][0] not in book:
                        todo_engine.append(node)
                elif node["visits"] >= MIN_VISITS:
                    todo_engine.append(node)
            else:
                if in_root:
                    node["replies"] = [{"uci": root[ply], "count": counts.get(root[ply], 0), "book": True}]
                else:
                    reps = {u: {"uci": u, "count": counts.get(u, 0), "book": True} for u in book}
                    for u, n in counts.most_common():
                        if n >= MIN_VISITS and u not in reps:
                            reps[u] = {"uci": u, "count": n, "book": False}
                    node["replies"] = sorted(reps.values(), key=lambda r: -r["count"])[:MAX_REPLIES]

        # 2) engine checks for this level, in parallel
        def check(node: dict) -> None:
            cands = [p["uci"] for p in node["played"]]
            res = _evaluate(node["fen"], cands)
            ep, best = res["ep"], res["best"]
            if best is None:
                return
            node["eval"] = {u: round(v, 4) for u, v in ep.items()}
            fine = [u for u, v in ep.items() if v >= ep[best] - TOLERANCE]
            if node.get("source") == "book":
                node["allowed"] = sorted(set(node["allowed"]) | set(fine))
                return
            yours = next((p["uci"] for p in node["played"] if ep.get(p["uci"], 0) >= ep[best] - TOLERANCE), None)
            node.update(main=yours or best, allowed=sorted(set(fine) | {yours or best}),
                        source="yours" if yours else "engine")

        if todo_engine:
            with ThreadPoolExecutor(max_workers=engine.batch.size) as pool:
                list(pool.map(check, todo_engine))

        # 3) expand to the next level
        nxt = []
        for board, parent, via, name in level:
            node = nodes.get(board.epd())
            if node is None or node["ply"] != ply or ply >= MAX_PLY:
                continue
            here_name = node["name"]
            moves = ([node["main"]] if node.get("main") else []) if node["user"] else \
                [r["uci"] for r in node.get("replies", [])]
            for u in moves:
                child = board.copy(stack=False)
                child.push_uci(u)
                cepd = child.epd()
                # Stop where neither theory nor your games go any further.
                if not book_next.get(cepd) and sum(seen_moves.get(cepd, Counter()).values()) < MIN_VISITS \
                        and ply + 1 >= len(root):
                    nodes[node["epd"]]["children"][u] = None
                    continue
                node["children"][u] = cepd
                nxt.append((child, node["epd"], u, here_name))
        level = nxt

    # SAN labels for the UI.
    for node in nodes.values():
        b = chess.Board(node["fen"])
        if node.get("main"):
            node["mainSan"] = _san(b, node["main"])
            node["allowedSan"] = [_san(b, u) for u in node.get("allowed", [])]
        for r in node.get("replies", []):
            r["san"] = _san(b, r["uci"])

    b = chess.Board()
    for u in root:
        b.push_uci(u)
    family_node = nodes.get(b.epd())
    return {"family": family, "color": color, "root": chess.Board().epd(), "nodes": nodes,
            "mistakes": _mistakes(nodes, losses, color), "built": int(time.time()),
            "games": family_node["visits"] if family_node else 0}


def _mistakes(nodes: dict, losses: dict, color: str) -> list[dict]:
    """Positions you reach repeatedly where your usual move isn't a repertoire move and costs you."""
    out = []
    for n in nodes.values():
        if not n["user"] or not n.get("main"):
            continue
        allowed = set(n.get("allowed", []))
        ev = n.get("eval", {})
        best_ep = max(ev.values()) if ev else None
        for p in n.get("played", []):
            u = p["uci"]
            if u in allowed:
                continue
            seen = losses.get((color, n["epd"], u))
            if seen:
                loss = sum(seen) / len(seen)
            elif best_ep is not None and u in ev:
                loss = max(0.0, best_ep - ev[u])
            else:
                continue
            if loss < MISTAKE_MIN:
                continue
            parent = nodes.get(n["parent"]) if n["parent"] else None
            out.append({
                "epd": n["epd"], "fen": n["fen"], "ply": n["ply"], "name": n["name"],
                "parentFen": parent["fen"] if parent else None, "via": n["via"], "viaSan": n["viaSan"],
                "played": u, "playedSan": p["san"], "count": p["count"], "loss": round(loss, 3),
                "main": n["main"], "mainSan": n["mainSan"], "allowed": n.get("allowed", []),
                "allowedSan": n.get("allowedSan", []), "source": n.get("source"),
                "path": _path(nodes, n),
            })
    out.sort(key=lambda m: -(m["count"] * m["loss"]))
    return out[:40]


def _path(nodes: dict, node: dict) -> list[str]:
    """SAN moves from the start to this position."""
    sans = []
    while node and node.get("parent"):
        sans.append(node["viaSan"])
        node = nodes.get(node["parent"])
    return list(reversed(sans))


def get(family: str, color: str, rebuild: bool = False) -> dict:
    """Cached repertoire (rebuilt when asked, or when many new games came in)."""
    safe = re.sub(r"[^A-Za-z0-9]+", "_", family)
    f = CACHE_DIR / "repertoire" / f"{safe}-{color}.json"
    if f.exists() and not rebuild:
        rep = json.loads(f.read_text(encoding="utf-8"))
        if rep.get("version") == 2:
            return rep
    with _lock:
        rep = build(family, color)
        rep["version"] = 2
        write_atomic(f, json.dumps(rep))
    return rep


# --------------------------------------------------------------------------- #
#  Training stats (line trainer) and drill sets
# --------------------------------------------------------------------------- #

def _stats_all() -> dict:
    try:
        return json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def stats(family: str, color: str) -> dict:
    return _stats_all().get(f"{family}|{color}", {})


def record(family: str, color: str, epd: str, ok: bool) -> dict:
    with _lock:
        data = _stats_all()
        s = data.setdefault(f"{family}|{color}", {}).setdefault(epd, {"ok": 0, "fail": 0})
        s["ok" if ok else "fail"] += 1
        s["last"] = int(time.time())
        write_atomic(STATS_FILE, json.dumps(data))
    return s


def drill(family: str, color: str, amount: int = 30) -> dict:
    """Woodpecker set: the positions where you usually go wrong – find the repertoire move."""
    from . import woodpecker

    rep = get(family, color)
    puzzles, seen = [], set()
    for m in rep["mistakes"]:
        if not m["parentFen"] or m["epd"] in seen:
            continue
        seen.add(m["epd"])
        puzzles.append({
            "id": f"op-{len(puzzles)}-{m['epd'][:20]}",
            "fen": m["parentFen"],
            "moves": [m["via"], m["main"]],
            "rating": None, "length": 2,
            "themes": ["opening", m["name"] or family],
            "altSteps": [m["allowed"]], "alternatives": m["allowed"],
            "tip": f"Repertoire: {m['mainSan']}" + (f" ({m['name']})" if m["name"] else "")
                   + f". You usually played {m['playedSan']} here ({m['count']}×).",
            "played": m["playedSan"],
        })
        if len(puzzles) >= amount:
            break
    if not puzzles:
        raise ValueError("No recurring opening mistakes found for this opening – nice!")
    return woodpecker._new_set(f"{family} fixes ({len(puzzles)})", puzzles, {"source": "opening", "family": family})
