# Engines

Using the Windows download (`AnnesChessKit-X.Y.Z-windows.exe`)? Then you don't need this folder: Stockfish, Lc0
and the Maia networks are inside the exe and are unpacked into the `engine` folder of its data folder
(`%LOCALAPPDATA%\AnnesChessKit\engine`, or `engine` next to the exe in portable use). Syzygy tablebases go
into `syzygy` there. This folder is for running from source and for building the exe.

Put the chess engines here. Only **Stockfish** is required; the rest unlocks optional features.
Nothing in this folder is part of the repository (it's in `.gitignore`). All of these are free software or free data
under their own licences (Stockfish, Lc0 and Maia: GPL v3) – see `THIRD_PARTY_NOTICES.md`.

| What | Where | Needed for |
|---|---|---|
| [Stockfish](https://stockfishchess.org/download/) 16 or newer | `engine/` – any file name starting with `stockfish`, e.g. `stockfish-windows-x86-64-avx2.exe` or `stockfish` | everything |
| [Lc0](https://github.com/LeelaChessZero/lc0/releases) | `engine/lc0/` (Windows: `lc0.exe` and its DLLs from the `cpu-dnnl` zip) or on your PATH | Nightmare, human opponents in Endgames |
| [Maia networks](https://github.com/CSSLab/maia-chess/tree/master/maia_weights) `maia-1100.pb.gz` … `maia-1900.pb.gz` | `engine/maia/` | same as Lc0 |
| [Syzygy tablebases](https://syzygy-tables.info) (3–5 pieces, `*.rtbw`/`*.rtbz`) | `engine/syzygy/` | exact play in the Endgames trainer (Stockfish alone is nearly as good) |

The app picks the fastest Stockfish build your CPU can run: it tries names containing `bmi2`, then `avx2`,
then the rest. You can keep several builds here. A Stockfish installed elsewhere is used if it's on your
PATH, or point to it with the environment variable `STOCKFISH_PATH`.
