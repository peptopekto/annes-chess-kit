from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import chess.pgn
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, analysis, botprogress, bundled, cards, coach, endgames, engine, habits, importers, insights, jobs, library, nightmare, openings, peers, pieces, positional, progress, recheck, repertoire, safety, stats, storage, tactics, training, upgrade, woodpecker
from .config import FROZEN, FRONTEND_DIST, ROOT, USERDATA, load_settings, save_settings


@asynccontextmanager
async def lifespan(_app: FastAPI):
    bundled.start()  # single-file app: unpack the engines in the background on the first start
    engine.batch.resize(engine.engines_for(load_settings()["engine_threads"]))

    def warm():
        storage.warm()   # review summaries first – the start page needs them
        openings.book()  # then the opening book
        recheck.run()    # re-judge old brilliant moves with the stricter sacrifice rule (once)
        recheck.run_rates()  # re-rate mates and misses in older reviews (once, no engine needed)
        # …then (once, a few minutes in the background) confirm old Brilliant/Great moves with a deeper search.
        threading.Thread(target=recheck.run_special, daemon=True, name="special-recheck").start()
        upgrade.resume() # carry on with a re-analysis interrupted by closing the app
        # Pre-build what the slower pages need, so they open instantly when clicked.
        # (same arguments as the Insights page's default view, so the warm result is the one it asks for)
        for job in (lambda: insights.compute(tc="all", color="all", last=0, since=None, until=None, compare=True),
                    habits.compute, stats.compute, repertoire.my_openings, peers.compute,
                    lambda: nightmare.profile() if nightmare.available() else None,
                    # Opening trees for your most-played openings (built once, then saved on disk).
                    lambda: [repertoire.get(o["family"], o["color"]) for o in repertoire.my_openings()[:4]]):
            try:
                job()
            except Exception:
                pass
    threading.Thread(target=warm, daemon=True, name="warm-caches").start()
    yield
    # Caches are saved at most once a minute while running – write the latest state on the way out.
    for flush in (insights._save_disk_cache, storage._save_disk_cache, peers.save_disk):
        try:
            flush()
        except Exception:
            pass
    engine.batch.close()
    engine.live.close()
    nightmare.close()
    endgames.close()


app = FastAPI(title="Anne's Chess Kit", version=__version__, lifespan=lifespan)
# Only answer requests addressed to this machine: a web page can't use DNS rebinding to reach the local API.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"])


def _foreign_origin(method: str, origin: str | None, fetch_site: str | None) -> bool:
    """A request that changes something, sent by another website's page (the browser says where it came from).

    The app's own window and the dev server are on this machine; a page from anywhere else has no business
    posting to the local API (stopping the app, queueing work, changing settings).
    """
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    if origin and origin != "null":
        host = urlsplit(origin).hostname or ""
        return host not in ("127.0.0.1", "localhost", "::1")
    if origin == "null":
        return True
    return (fetch_site or "").lower() == "cross-site"


@app.middleware("http")
async def own_pages_only(request: Request, call_next):
    if _foreign_origin(request.method, request.headers.get("origin"), request.headers.get("sec-fetch-site")):
        return JSONResponse({"detail": "Requests from other websites are not accepted."}, status_code=403)
    return await call_next(request)


def _bad_request(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Couldn't reach the server: {e}") from e


# --------------------------------------------------------------------------- #
#  Settings
# --------------------------------------------------------------------------- #

# When the app runs standalone (no console), it quits once its window is gone. The window
# pings every 15 s; run.py watches LAST_PING as a fallback when it can't watch the window process itself.
LAST_PING = [0.0]
# Set by POST /api/shutdown; run.py stops the server when it sees it (used to restart after an update).
SHUTDOWN = [False]
STARTED = time.time()
_CODE = Path(__file__).resolve().parent                       # backend/app
_WATCHED = (_CODE, _CODE.parent / "data" / "coach")


def _outdated() -> bool:
    """True when the app's code or the built UI changed after this server started: it needs a restart."""
    if FROZEN:  # the single-file app: replaced by a newer AnnesChessKit.exe
        try:
            return Path(sys.executable).stat().st_mtime > STARTED + 1
        except OSError:
            return False
    newest = 0.0
    for folder in _WATCHED:
        for f in folder.glob("*.py" if folder == _CODE else "*.yaml"):
            newest = max(newest, f.stat().st_mtime)
    for f in (_CODE.parent / "data" / "gambits.yaml", _CODE.parents[1] / "frontend" / "dist" / "index.html"):
        if f.exists():
            newest = max(newest, f.stat().st_mtime)
    return newest > STARTED + 1


@app.post("/api/shutdown")
def shutdown():
    """Stop the server (run.py restarts it when the app is started again after an update)."""
    SHUTDOWN[0] = True
    return {"ok": True}


@app.post("/api/ping")
def ping():
    LAST_PING[0] = time.monotonic()
    return {"ok": True}


@app.get("/api/health")
def health():
    path = None
    if not bundled.busy():  # while the engines are unpacked, answer at once instead of waiting for them
        try:
            path = str(engine.engine_path())
        except RuntimeError:
            path = None
    return {"version": __version__, "engine": path is not None, "enginePath": path,
            "maia": nightmare.available(), "tablebase": endgames.tablebase_ready(),
            "cpus": engine.CPUS, "autoEngines": engine.AUTO_ENGINES, "engines": engine.batch.size,
            "started": STARTED, "outdated": _outdated(), "preparing": bundled.busy(),
            # Which copy this is: a second copy (the portable folder, an install) uses the same address.
            "root": str(ROOT), "userdata": str(USERDATA)}


@app.get("/api/settings")
def get_settings():
    return load_settings()


@app.post("/api/settings")
def post_settings(patch: dict):
    settings = save_settings(patch)
    engine.batch.resize(engine.engines_for(settings["engine_threads"]))
    return settings


def _limits(depth: int | None = None, move_time: float | None = None) -> analysis.Limits:
    """Search limits for queued reviews: the request's own, or the ones from Settings.

    An explicit depth without a time means a fixed-depth review (e.g. "Re-analyze deeper").
    """
    s = load_settings()
    if depth is None and move_time is None and s["analysis_mode"] == "time":
        move_time = s["move_time"]
    if move_time:
        return analysis.Limits(depth=max(8, min(40, depth or s["max_depth"])), move_time=max(0.1, min(10.0, move_time)))
    return analysis.Limits(depth=max(8, min(30, depth or s["depth"])))


# --------------------------------------------------------------------------- #
#  Importing
# --------------------------------------------------------------------------- #

class PgnIn(BaseModel):
    pgn: str


@app.post("/api/pgn/parse")
def parse_pgn(body: PgnIn):
    text = body.pgn.strip()
    if text.startswith("http"):
        fetched = _bad_request(importers.from_url, text)
        if fetched is None:
            raise HTTPException(400, "Only Lichess game links can be imported directly. "
                                     "For Chess.com, use the username import or paste the PGN.")
        text = fetched
    games = analysis.read_games(text)
    if not games:
        raise HTTPException(400, "No games found in that PGN.")
    known = {s["id"] for s in storage.summaries()}
    out = []
    for g in games:
        exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        gid = analysis.game_id(g)
        out.append({**analysis.game_summary(g), "pgn": g.accept(exporter),
                    "analysedId": gid if gid in known else None})
    return out


class LibraryQueueIn(BaseModel):
    urls: list[str]
    depth: int | None = None
    moveTime: float | None = None  # noqa: N815 - API field name
    front: bool = False


@app.get("/api/library/{source}/{user}")
def library_list(source: str, user: str):
    return _bad_request(library.listing, source, user)


@app.post("/api/library/{source}/{user}/sync")
def library_sync(source: str, user: str, full: bool = False):
    return _bad_request(library.start_sync, source, user, full)


@app.post("/api/library/{source}/{user}/queue")
def library_queue(source: str, user: str, body: LibraryQueueIn):
    games = _bad_request(library.pgns, source, user, body.urls)
    return jobs.queue.add(games, _limits(body.depth, body.moveTime), front=body.front)


# --------------------------------------------------------------------------- #
#  Game review
# --------------------------------------------------------------------------- #

class QueueGame(BaseModel):
    pgn: str
    title: str | None = None
    source: str | None = None
    url: str | None = None


class QueueIn(BaseModel):
    games: list[QueueGame]
    depth: int | None = None
    moveTime: float | None = None  # noqa: N815 - API field name
    front: bool = False
    force: bool = False


@app.post("/api/queue")
def queue_add(body: QueueIn):
    return jobs.queue.add([g.model_dump() for g in body.games], _limits(body.depth, body.moveTime),
                          front=body.front, force=body.force)


@app.get("/api/queue")
def queue_list():
    return jobs.queue.list()


@app.get("/api/queue/{job_id}")
def queue_get(job_id: int):
    job = jobs.queue.get(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    return job


@app.delete("/api/queue/{job_id}")
def queue_cancel(job_id: int):
    jobs.queue.cancel(job_id)
    return {"ok": True}


@app.post("/api/queue/cancel-all")
def queue_cancel_all():
    jobs.queue.cancel(None)
    upgrade.stop()  # "cancel all" also ends a running re-analysis of old reviews
    return {"ok": True}


@app.post("/api/queue/clear")
def queue_clear():
    jobs.queue.clear_finished()
    return {"ok": True}


@app.get("/api/games")
def list_games(limit: int = 0):
    return storage.summaries(limit or None)


@app.get("/api/games/{game_id}")
def get_game(game_id: str):
    record = _bad_request(storage.load, game_id)
    if record is None:
        raise HTTPException(404, "Game not found")
    analysis.fill_mate_winner(record)
    record["end"] = analysis.game_end(record)
    record = coach.enrich(positional.enrich(tactics.enrich(record)), record["end"])
    record["habits"] = habits.game_habits(record)
    try:
        record["moveTimes"] = insights.move_times(record)
    except (ValueError, KeyError):
        record["moveTimes"] = None  # a PGN the clock reader can't follow: the review works without it
    return record


@app.get("/api/reviews/outdated")
def outdated_games():
    """Reviews made with an older analysis method (worth re-running for better ratings)."""
    old = upgrade.outdated()
    if not old and upgrade.active():
        upgrade.stop()  # all done
    return {"count": len(old), "plies": sum(s.get("plies") or 0 for s in old), "version": analysis.ANALYSIS_VERSION,
            "active": upgrade.active()}


@app.post("/api/reviews/upgrade")
def upgrade_games():
    """Queue every outdated review for re-analysis (background, same depth as before; resumes after a restart)."""
    return {"queued": upgrade.start()}


@app.get("/api/games/{game_id}/pgn")
def game_pgn(game_id: str):
    record = _bad_request(storage.load, game_id)
    if record is None:
        raise HTTPException(404, "Game not found")
    name = f"{record.get('white', 'white')}_vs_{record.get('black', 'black')}".replace(" ", "_")
    return PlainTextResponse(analysis.annotated_pgn(record), media_type="application/x-chess-pgn",
                             headers={"Content-Disposition": f'attachment; filename="{name}.pgn"'})


@app.delete("/api/games/{game_id}")
def delete_game(game_id: str):
    _bad_request(storage.delete, game_id)
    return {"ok": True}


@app.get("/api/insights")
def get_insights(tc: str = "all", color: str = "all", last: int = 0,
                 since: str | None = None, until: str | None = None, compare: bool = True):
    return _bad_request(insights.compute, tc=tc, color=color, last=max(0, last),
                        since=since, until=until, compare=compare)


@app.get("/api/stats")
def stats_report():
    """Progress dashboard: record, ratings, activity, when you play best, records, better/worse."""
    return stats.compute()


@app.get("/api/coach")
def coach_report():
    """Your recurring bad habits, the mistakes you repeat move for move, strengths, warning signs and a plan."""
    report = habits.compute()
    return {**report, **stats.coach_extras(report)}


@app.get("/api/insights/trend")
def get_trend(tc: str = "all", color: str = "all", bucket: str = "auto"):
    if bucket not in ("auto", "week", "month", "games"):
        raise HTTPException(400, "bucket must be auto, week, month or games")
    return insights.trend(tc=tc, color=color, bucket=bucket)


@app.get("/api/trophies")
def trophies(kind: str = "all", offset: int = 0, limit: int = 12):
    """Your brilliant/great moves, newest first, paged – plus totals for the Progress page."""
    special = storage.highlights(("brilliant", "great"))
    errors = sum(1 for _ in storage.highlights(("blunder", "mistake", "miss")))
    items = [h for h in special if kind == "all" or h["cls"] == kind]
    return {"total": len(items), "items": items[offset:offset + max(1, min(60, limit))],
            "counts": {"brilliant": sum(h["cls"] == "brilliant" for h in special),
                       "great": sum(h["cls"] == "great" for h in special), "mistakes": errors}}


class NightmareMoveIn(BaseModel):
    moves: list[str] = []   # the game so far, UCI from the start position
    strength: int = 100     # rating points above your level
    focus: float = 0.6      # 0 = plays like a human at that level, 1 = hunts your weaknesses
    gambits: list[str] = []  # gambit ids to play when the game allows ("all" = every one)
    variety: bool = False   # opening variety: vary between the moves players at that level often play
    fen: str | None = None  # start position (e.g. a won position from your games); moves are played from there


class NightmareFinishIn(BaseModel):
    result: str             # win | draw | loss (yours)
    color: str              # the colour you played
    level: int
    traps: int = 0
    fell: int = 0
    moves: int = 0
    pgn: str | None = None  # the game, so it can be listed and reviewed later
    strength: int = 0       # bot strength relative to your level (for XP)
    focus: float = 0.0
    takebacks: int = 0
    practice: bool = False  # "play on" games: listed, but no XP or statistics
    mode: str = "game"      # "game", or "convert" (converting a won position from one of your games)
    spot: str | None = None  # convert mode: which position (its XP is paid once)
    explored: bool = False  # used the analysis board during the game (counts like a takeback)
    marks: dict[int, dict] = {}  # ply -> live rating {uci, cls, loss} (missing ones are rated at the end)


@app.get("/api/nightmare")
def nightmare_summary():
    return nightmare.summary()


@app.post("/api/nightmare/move")
def nightmare_move(body: NightmareMoveIn):
    if not nightmare.available():
        raise HTTPException(503, "The Nightmare needs Lc0 and the Maia networks in engine/ (see README).")
    try:
        return nightmare.choose(body.moves, max(-300, min(500, body.strength)), body.focus, body.gambits, body.variety,
                                body.fen)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/nightmare/finish")
def nightmare_finish(body: NightmareFinishIn):
    if body.result not in ("win", "draw", "loss") or body.color not in ("w", "b"):
        raise HTTPException(400, "bad result")
    training.log("nightmare")
    out = nightmare.finish(body.result, body.color, body.level, body.traps, body.fell, body.moves, body.pgn)
    if not body.practice:
        out["progress"] = botprogress.record(body.result, body.color, body.level, body.strength, body.focus,
                                             body.pgn, body.marks, body.takebacks, body.mode, (body.spot or "")[:120] or None,
                                             body.explored)
    return out


@app.get("/api/bot/convert")
def bot_convert(min_win: float = nightmare.CONVERT_MIN, draws: bool = False):
    """Won positions you lost (not on time) – to practise converting them against the bot."""
    spots = nightmare.thrown_wins(max(55.0, min(98.0, min_win)), draws)
    status = botprogress.convert_status()
    return [{**s, "played": status.get(s["id"])} for s in spots]


@app.get("/api/bot/progress")
def bot_progress():
    return botprogress.summary()


# --------------------------------------------------------------------------- UI errors

class ClientErrorIn(BaseModel):
    message: str = ""
    stack: str = ""
    component: str = ""
    url: str = ""


@app.post("/api/client-error")
def client_error(body: ClientErrorIn):
    """A page crashed in the UI: write it to the log (userdata/app.log), so it can be looked into."""
    clip = lambda t, n: (t or "")[:n]  # noqa: E731
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] UI error on {clip(body.url, 200)}: {clip(body.message, 500)}\n"
          f"{clip(body.stack, 4000)}\n{clip(body.component, 3000)}", flush=True)
    return {"ok": True}


# --------------------------------------------------------------------------- piece sets

@app.get("/api/pieces")
def pieces_list():
    return pieces.listing()


@app.post("/api/pieces/{set_id}/download")
def pieces_download(set_id: str):
    try:
        return pieces.download(set_id)
    except KeyError:
        raise HTTPException(404, "Unknown piece set")
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.delete("/api/pieces/{set_id}")
def pieces_remove(set_id: str):
    try:
        pieces.remove(set_id)
    except KeyError:
        raise HTTPException(404, "Unknown piece set")
    return pieces.listing()


@app.get("/api/pieces/{set_id}/{name}.svg")
def pieces_file(set_id: str, name: str):
    f = pieces.file(set_id, name)
    if f is None:
        raise HTTPException(404, "Not downloaded")
    # Checked on download; the CSP is a second lock in case one is ever opened on its own.
    return FileResponse(f, media_type="image/svg+xml",
                        headers={"Cache-Control": "max-age=86400", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})


@app.delete("/api/bot/progress")
def bot_progress_reset():
    return botprogress.reset()


class BotRatingIn(BaseModel):
    rating: int | None = None  # Lichess scale; None = read it from your games again


@app.post("/api/nightmare/rating")
def nightmare_rating(body: BotRatingIn):
    return nightmare.set_rating(body.rating)


@app.get("/api/nightmare/gambits")
def nightmare_gambits():
    return nightmare.gambit_list()


@app.get("/api/bots/games")
def bot_games():
    return nightmare.bot_games()


# ----- you vs the players at your rating -----
@app.get("/api/progress")
def progress_report():
    """Slow library-wide jobs that are running right now (pages show them while they load)."""
    return {"tasks": progress.snapshot()}


@app.get("/api/peers")
def peers_report(tc: str = "all", last: int = 0, band: int = peers.BAND, platform: str = "all"):
    return peers.compute(tc=tc, last=last, band=band, platform=platform)


# --------------------------------------------------------------------------- #
#  Endgame trainer
# --------------------------------------------------------------------------- #

class EndgameNewIn(BaseModel):
    drill: str


class EndgamePlayIn(BaseModel):
    drill: str
    fen: str                # the drill's start position
    moves: list[str] = []   # UCI since then; the last one is yours
    mode: str = "perfect"   # perfect (Stockfish / tablebases) | human (Maia)
    level: int | None = None


class EndgameFinishIn(BaseModel):
    drill: str
    mode: str
    result: str             # success | fail
    moves: int = 0
    optimal: int | None = None
    takebacks: int = 0
    hints: int = 0


def _drill(drill_id: str):
    if drill_id not in endgames.BY_ID:
        raise HTTPException(404, "No such drill")
    return endgames.BY_ID[drill_id]


@app.get("/api/endgames")
def endgames_summary():
    return endgames.summary()


@app.post("/api/endgames/new")
def endgames_new(body: EndgameNewIn):
    _drill(body.drill)
    try:
        return endgames.new(body.drill)
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@app.post("/api/endgames/play")
def endgames_play(body: EndgamePlayIn):
    _drill(body.drill)
    if body.mode not in ("perfect", "human") or not body.moves:
        raise HTTPException(400, "bad request")
    try:
        return endgames.play(body.drill, body.fen, body.moves, body.mode, body.level)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/endgames/hint")
def endgames_hint(body: EndgamePlayIn):
    try:
        return endgames.hint(body.fen, body.moves)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/endgames/finish")
def endgames_finish(body: EndgameFinishIn):
    _drill(body.drill)
    if body.mode not in ("perfect", "human") or body.result not in ("success", "fail"):
        raise HTTPException(400, "bad result")
    training.log("endgame", won=int(body.result == "success"))
    return endgames.finish(body.drill, body.mode, body.result, body.moves, body.optimal, body.takebacks, body.hints)


class FenIn(BaseModel):
    fen: str
    depth: int = 18
    multipv: int = 3


class CheckIn(BaseModel):
    fen: str
    uci: str
    depth: int = 18
    k: float | None = None            # the game's rating-aware curve (as in its review)
    prevUci: str | None = None        # noqa: N815 - the opponent's move before (for "Miss")
    prevLoss: float | None = None     # noqa: N815
    book: bool = False                # the game started from the normal position: book moves count as Book


@app.post("/api/engine/lines")
def engine_lines(body: FenIn):
    return _bad_request(analysis.live_lines, body.fen, max(6, min(26, body.depth)), max(1, min(5, body.multipv)))


@app.post("/api/engine/check")
def engine_check(body: CheckIn):
    k = max(0.0005, min(0.01, body.k)) if body.k else None
    return _bad_request(analysis.check_move, body.fen, body.uci, max(6, min(26, body.depth)), k, body.prevUci, body.prevLoss,
                        body.book)


# --------------------------------------------------------------------------- #
#  Opening trainer & blunder check
# --------------------------------------------------------------------------- #

@app.get("/api/openings")
def openings_list():
    return repertoire.my_openings()


@app.get("/api/openings/repertoire")
def openings_repertoire(family: str, color: str, rebuild: bool = False):
    if color not in ("w", "b"):
        raise HTTPException(400, "color must be w or b")
    rep = _bad_request(repertoire.get, family, color, rebuild)
    return {**rep, "stats": repertoire.stats(family, color)}


class OpeningResultIn(BaseModel):
    family: str
    color: str
    epd: str
    ok: bool


@app.post("/api/openings/result")
def openings_result(body: OpeningResultIn):
    training.log("opening")
    return repertoire.record(body.family, body.color, body.epd, body.ok)


class OpeningDrillIn(BaseModel):
    family: str
    color: str
    amount: int = 30


@app.post("/api/openings/drill")
def openings_drill(body: OpeningDrillIn):
    return _bad_request(repertoire.drill, body.family, body.color, body.amount)


@app.get("/api/safety/deck")
def safety_deck(count: int = 20, mode: str = "mixed"):
    return {"cards": safety.deck(max(4, min(50, count)), "review" if mode == "review" else "mixed"),
            "summary": safety.summary()}


@app.get("/api/safety/hub")
def safety_hub():
    return safety.hub()


class SafetyAnswerIn(BaseModel):
    card: dict
    saidSafe: bool


@app.post("/api/safety/answer")
def safety_answer(body: SafetyAnswerIn):
    training.log("safety")
    return safety.answer(body.card, body.saidSafe)


class SafetyFinishIn(BaseModel):
    right: int
    total: int
    seconds: float
    mode: str = "mixed"


@app.post("/api/safety/finish")
def safety_finish(body: SafetyFinishIn):
    return safety.finish(body.right, body.total, body.seconds, body.mode)


# --------------------------------------------------------------------------- #
#  Woodpecker
# --------------------------------------------------------------------------- #

class MoveRef(BaseModel):
    gameId: str
    ply: int


class NewSetIn(BaseModel):
    kind: str = "lichess"  # or "mistakes" / "moves" / "pattern"
    name: str | None = None
    pattern: str | None = None  # kind "pattern": which recurring pattern (see woodpecker.PATTERN_LABELS)
    moves: list[MoveRef] | None = None
    amount: int = 100
    min_rating: int = 1000
    max_rating: int = 1500
    min_length: int = 2
    max_length: int = 50


# --------------------------------------------------------------------------- #
#  Training: daily goal, streak, pattern mastery
# --------------------------------------------------------------------------- #

@app.get("/api/training")
def training_summary():
    return training.summary()


class GoalIn(BaseModel):
    goal: int


@app.post("/api/training/goal")
def training_goal(body: GoalIn):
    return training.set_goal(body.goal)


# ----- coach: lesson cards and your verdicts on them -----
@app.get("/api/coach/cards")
def coach_cards():
    return [cards.public(c) for c in cards.load().values()]


class CardFeedbackIn(BaseModel):
    game: str
    ply: int
    concept: str
    fits: bool
    strength: float | None = None


@app.post("/api/coach/feedback")
def coach_feedback(body: CardFeedbackIn):
    """Your verdict on a principle shown in a review; enough "doesn't fit" makes that concept rarer."""
    return _bad_request(cards.feedback, body.game, body.ply, body.concept, body.fits, body.strength)


@app.get("/api/woodpecker/sets")
def wp_sets():
    return woodpecker.list_sets()


@app.post("/api/woodpecker/sets")
def wp_create(body: NewSetIn):
    if body.kind == "mistakes":
        return _bad_request(woodpecker.create_from_mistakes, body.amount)
    if body.kind == "pattern":
        return _bad_request(woodpecker.create_from_pattern, body.pattern or "", body.amount)
    if body.kind == "moves":
        refs = [(m.gameId, m.ply) for m in body.moves or []]
        return _bad_request(woodpecker.create_from_moves, refs, body.name or "Drill", body.amount)
    return _bad_request(woodpecker.create_from_csv, body.amount, body.min_rating, body.max_rating,
                        body.min_length, body.max_length)


@app.get("/api/woodpecker/sets/{set_id}")
def wp_get(set_id: str):
    try:
        return woodpecker.get_set(set_id)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, "Set not found") from e


@app.delete("/api/woodpecker/sets/{set_id}")
def wp_delete(set_id: str):
    _bad_request(woodpecker.delete_set, set_id)
    return {"ok": True}


@app.put("/api/woodpecker/sets/{set_id}/progress")
def wp_progress(set_id: str, progress: dict | None = None):
    _bad_request(woodpecker.save_progress, set_id, progress)
    return {"ok": True}


@app.post("/api/woodpecker/sets/{set_id}/complete")
def wp_complete(set_id: str, stats: dict):
    return _bad_request(woodpecker.complete_run, set_id, stats)


# --------------------------------------------------------------------------- #
#  Frontend
# --------------------------------------------------------------------------- #

_NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Anne's Chess Kit – build the UI</title>
<body style="font:16px/1.6 system-ui,sans-serif;background:#0b0c0f;color:#eeeff2;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.6rem">The web interface isn't built yet</h1>
<p>Anne's Chess Kit is running, but the web interface has to be built once (it needs <a style="color:#2ee6d1"
href="https://nodejs.org">Node.js</a> 20.19+ or 22+):</p>
<pre style="background:#16171c;padding:1rem;border-radius:8px">cd frontend
npm ci
npm run build</pre>
<p>Then reload this page. Or download a release zip, which comes with the UI already built.</p>
</body>"""


if (FRONTEND_DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        file = (FRONTEND_DIST / path).resolve()
        if path and file.is_file() and FRONTEND_DIST.resolve() in file.parents:
            return FileResponse(file)
        # Always revalidate the page itself, so an update is picked up on the next load
        # (the hashed files under /assets never change).
        return FileResponse(FRONTEND_DIST / "index.html", headers={"Cache-Control": "no-cache"})
else:
    @app.get("/{path:path}", include_in_schema=False)
    def not_built(path: str):
        return HTMLResponse(_NOT_BUILT, status_code=503)
