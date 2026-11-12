"""Piece sets: the built-in one (cburnett, part of the board library) plus free sets you can download once.

The downloadable sets are the free ones Lichess uses (lichess-org/lila, public/piece – see its COPYING.md for
authors and licences). The app doesn't ship them: "Download" in Settings → Board and pieces fetches the 12 SVG
files of a set from GitHub into userdata/pieces/<set>/, and from then on they're served locally like everything
else. Downloaded files are checked to be plain SVG images (no scripts, no external references) before they're kept.
"""
from __future__ import annotations

import re
import shutil
import threading

from .config import USERDATA

DIR = USERDATA / "pieces"
FILES = [c + p for c in "wb" for p in "KQRBNP"]          # wK, wQ, …, bP
SOURCES = [
    "https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/{set}/{file}.svg",
    "https://lichess1.org/assets/piece/{set}/{file}.svg",
]
MAX_BYTES = 300_000
UA = {"User-Agent": "AnnesChessKit (local chess review; piece set download)"}

BUILTIN = {"id": "cburnett", "name": "Cburnett", "author": "Colin M.L. Burnett", "license": "GPLv2+"}

# Free sets from lila's COPYING.md (CC BY-NC-SA: fine for personal, non-commercial use).
CATALOG: list[dict] = [
    {"id": "merida", "name": "Merida", "author": "Armando Hernandez Marroquin", "license": "GPLv2+"},
    {"id": "california", "name": "California", "author": "Jerry S.", "license": "CC BY-NC-SA 4.0"},
    {"id": "cardinal", "name": "Cardinal", "author": "sadsnake1", "license": "CC BY-NC-SA 4.0"},
    {"id": "maestro", "name": "Maestro", "author": "sadsnake1", "license": "CC BY-NC-SA 4.0"},
    {"id": "staunty", "name": "Staunty", "author": "sadsnake1", "license": "CC BY-NC-SA 4.0"},
    {"id": "fresca", "name": "Fresca", "author": "sadsnake1", "license": "CC BY-NC-SA 4.0"},
    {"id": "tatiana", "name": "Tatiana", "author": "sadsnake1", "license": "CC BY-NC-SA 4.0"},
    {"id": "gioco", "name": "Gioco", "author": "sadsnake1", "license": "CC BY-NC-SA 4.0"},
    {"id": "icpieces", "name": "IC Pieces", "author": "sadsnake1", "license": "CC BY-NC-SA 4.0"},
    {"id": "chessnut", "name": "Chessnut", "author": "Alexis Luengas", "license": "Apache 2.0"},
    {"id": "pirouetti", "name": "Pirouetti", "author": "pirouetti", "license": "AGPLv3+"},
    {"id": "mpchess", "name": "MPChess", "author": "Maxime Chupin", "license": "GPLv3+"},
    {"id": "kiwen-suwi", "name": "Kiwen-suwi", "author": "neverRare", "license": "CC BY 4.0"},
    {"id": "fantasy", "name": "Fantasy", "author": "Maurizio Monge", "license": "MIT"},
    {"id": "celtic", "name": "Celtic", "author": "Maurizio Monge", "license": "MIT"},
    {"id": "spatial", "name": "Spatial", "author": "Maurizio Monge", "license": "MIT"},
    {"id": "rhosgfx", "name": "RhosGFX", "author": "RhosGFX", "license": "CC0 1.0"},
    {"id": "horsey", "name": "Horsey", "author": "cham, michael1241", "license": "CC BY-NC-SA 4.0"},
    {"id": "pixel", "name": "Pixel", "author": "therealqtpi", "license": "AGPLv3+"},
    {"id": "shapes", "name": "Shapes", "author": "flugsio", "license": "CC BY-SA 4.0"},
    {"id": "letter", "name": "Letter", "author": "usolando", "license": "AGPLv3+"},
]
BY_ID = {s["id"]: s for s in CATALOG}
_lock = threading.Lock()

# Anything that could run code or load something from elsewhere when the SVG is opened on its own.
_UNSAFE = re.compile(rb"<script|<foreignobject|javascript:|\son[a-z]+\s*=|<iframe|<embed|<object|xlink:href\s*=\s*[\"']\s*(?!#)"
                     rb"|href\s*=\s*[\"']\s*(?:https?:|//|data:text)", re.I)


def _is_svg(data: bytes) -> bool:
    head = data.lstrip(b"\xef\xbb\xbf \t\r\n")[:400].lower()
    return (head.startswith(b"<?xml") or head.startswith(b"<svg") or head.startswith(b"<!--")) and b"<svg" in data[:4000].lower()


def check_svg(data: bytes) -> bool:
    """A plain, self-contained SVG image of sensible size."""
    return 0 < len(data) <= MAX_BYTES and _is_svg(data) and not _UNSAFE.search(data)


def downloaded(set_id: str) -> bool:
    d = DIR / set_id
    return all((d / f"{f}.svg").is_file() for f in FILES)


def listing() -> dict:
    return {"builtin": BUILTIN,
            "sets": [{**s, "downloaded": downloaded(s["id"])} for s in CATALOG]}


def download(set_id: str) -> dict:
    """Fetch the 12 files of a set (all or nothing). Raises KeyError for an unknown set, RuntimeError on failure."""
    if set_id not in BY_ID:
        raise KeyError(set_id)
    import httpx  # only needed here (and keeps the module importable for the checks above)

    with _lock:
        if downloaded(set_id):
            return {**BY_ID[set_id], "downloaded": True}
        tmp = DIR / f".{set_id}.part"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        try:
            with httpx.Client(headers=UA, timeout=httpx.Timeout(20.0), follow_redirects=True) as client:
                for f in FILES:
                    data = None
                    for src in SOURCES:
                        try:
                            r = client.get(src.format(set=set_id, file=f))
                        except httpx.HTTPError:
                            continue
                        if r.status_code == 200 and check_svg(r.content):
                            data = r.content
                            break
                    if data is None:
                        raise RuntimeError(f"Couldn't download {f}.svg of {BY_ID[set_id]['name']} – are you online?")
                    (tmp / f"{f}.svg").write_bytes(data)
            final = DIR / set_id
            shutil.rmtree(final, ignore_errors=True)
            tmp.rename(final)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return {**BY_ID[set_id], "downloaded": True}


def remove(set_id: str) -> None:
    if set_id not in BY_ID:
        raise KeyError(set_id)
    shutil.rmtree(DIR / set_id, ignore_errors=True)


def file(set_id: str, name: str):
    """Path of one downloaded piece image, or None (only known sets and the 12 file names – no paths)."""
    if set_id not in BY_ID or name not in FILES:
        return None
    p = DIR / set_id / f"{name}.svg"
    return p if p.is_file() else None
