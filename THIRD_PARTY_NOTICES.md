# Third-party software and data

Anne's Chess Kit is licensed under the GNU General Public License v3.0 or later (see `LICENSE`). It builds on the
work below; thank you to all of these projects.

## Bundled in this repository

| Component | Used for | License |
|---|---|---|
| [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (`backend/data/openings.tsv`) | Opening names and book moves | CC0-1.0 |
| Sound effects by [Kenney](https://kenney.nl) (`frontend/public/sounds/`) | Move, capture and result sounds | CC0-1.0 |

## Installed as dependencies

Python (`requirements.txt`):

| Package | License |
|---|---|
| [python-chess](https://github.com/niklasf/python-chess) | GPL-3.0-or-later |
| [FastAPI](https://github.com/fastapi/fastapi), [Starlette](https://github.com/encode/starlette) | MIT, BSD-3-Clause |
| [Uvicorn](https://github.com/encode/uvicorn), [HTTPX](https://github.com/encode/httpx) | BSD-3-Clause |
| [PyYAML](https://github.com/yaml/pyyaml) | MIT |

Their own dependencies (Pydantic, AnyIO, h11, websockets, …) come under MIT, BSD or Apache-2.0 licences; each
package's licence is installed with it (`*.dist-info`).

Web UI (`frontend/package.json`), bundled into `frontend/dist` when built:

| Package | License |
|---|---|
| [chessground](https://github.com/lichess-org/chessground) – the board, including the cburnett piece set by Colin M.L. Burnett | GPL-3.0-or-later |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-2-Clause |
| [React](https://react.dev), [Recharts](https://recharts.org), [Motion](https://motion.dev), [cmdk](https://cmdk.paco.me), [clsx](https://github.com/lukeed/clsx), [TanStack Virtual](https://tanstack.com/virtual) | MIT |
| [Lucide](https://lucide.dev) icons, [canvas-confetti](https://github.com/catdad/canvas-confetti) | ISC |
| [Geist and Geist Mono](https://vercel.com/font) fonts (via Fontsource) | SIL Open Font License 1.1 |
| Their dependencies (Radix UI, D3 modules, Redux Toolkit, Immer, …) | MIT, ISC, BSD, Apache-2.0 |
| [Tailwind CSS](https://tailwindcss.com), [Vite](https://vite.dev), [TypeScript](https://www.typescriptlang.org), [oxlint](https://oxc.rs) (build tools only) | MIT, Apache-2.0 |

The full licence texts of every package bundled into the web UI are collected by
`scripts/collect-licenses.mjs` into `licenses/web-ui.txt` of the Windows download.

## Included in the Windows download (AnnesChessKit-X.Y.Z-windows.exe)

The release download is built by `scripts/build-exe.ps1` and contains, unchanged and in their original form:

| Component | Where | License | Source code |
|---|---|---|---|
| [Python](https://www.python.org) runtime and the packages listed above | inside the exe | PSF License; packages as above | [python.org](https://www.python.org/downloads/source/) |
| [PyInstaller](https://pyinstaller.org) bootloader (starts the exe and unpacks it) | inside the exe | GPL-2.0-or-later with the bootloader exception, which allows this use | [pyinstaller/pyinstaller](https://github.com/pyinstaller/pyinstaller) |
| [Stockfish](https://stockfishchess.org) | `engine/stockfish-*.exe` in the data folder | GPL-3.0 | [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish) |
| [Lc0 (Leela Chess Zero)](https://lczero.org) | `engine/lc0/` | GPL-3.0 | [LeelaChessZero/lc0](https://github.com/LeelaChessZero/lc0) |
| [Maia](https://maiachess.com) networks by the CSSLab, University of Toronto | `engine/maia/` | GPL-3.0 | [CSSLab/maia-chess](https://github.com/CSSLab/maia-chess) |

Anne's Chess Kit itself is GPL-3.0-or-later; its source is this repository. The engines run as separate
programs that the app talks to over the UCI protocol; they are distributed alongside it, unchanged, under their
own licences. The download says exactly which versions it contains and where their source is
(`engine/ENGINES.txt`, with the licence texts next to the engines), and every GitHub release has the source code
of those exact engine versions attached (`AnnesChessKit-<version>-engine-sources.zip`).

Where to find the licence texts: the exe carries them and copies them into its data folder on every new
version (`%LOCALAPPDATA%\AnnesChessKit`, or the folder next to the exe when you keep a `userdata` folder
there). In `licenses/`: `LICENSE` (the app and the GPL v3 text), `THIRD_PARTY_NOTICES.md` (this file),
`web-ui.txt` (web UI packages), `python-LICENSE.txt` (Python), `python-packages.txt` (Python packages, with
their licence texts) and `ENGINES.txt`; in `engine/`: `ENGINES.txt` and the licence files of the engines and
networks.

## Downloaded separately by you (not in this repository; a source checkout needs them)

| Component | Used for | License |
|---|---|---|
| [Stockfish](https://stockfishchess.org) – **required** | All analysis | GPL-3.0 |
| [Lc0 (Leela Chess Zero)](https://lczero.org) – optional | Runs the Maia networks | GPL-3.0 |
| [Maia](https://maiachess.com) networks by the CSSLab, University of Toronto – optional | Human-like opponents (Nightmare, Endgames) | GPL-3.0 |
| [Syzygy endgame tablebases](https://syzygy-tables.info) – optional | Perfect endgame defence | free to use and share |
| [Lichess puzzle database](https://database.lichess.org/#puzzles) – optional | Woodpecker puzzle sets | CC0-1.0 |

## Downloaded only when you ask for them in the app

| Component | Used for | License |
|---|---|---|
| Piece sets from [lichess-org/lila](https://github.com/lichess-org/lila/blob/master/COPYING.md) (Settings → Board and pieces → Download) | Other piece designs | per set, shown next to it: GPL, AGPL, Apache-2.0, MIT, CC0, CC BY, CC BY-SA, CC BY-NC-SA 4.0 |

These sets are not part of the repository or the downloads: the app fetches them for your own use into
`userdata/pieces/`. Several are CC BY-NC-SA (non-commercial); keep that in mind if you redistribute a folder
that contains them.

Games imported from Chess.com and Lichess are fetched from their public APIs and stay on your computer.
