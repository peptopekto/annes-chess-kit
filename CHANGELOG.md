# Changelog

## 1.0.3

New:

- One file instead of an installer or a zip: the Windows download is now AnnesChessKit-1.0.3-windows.exe,
  with Python, the web UI, Stockfish, Lc0 and the Maia networks inside. Put it anywhere and double-click it.
  The first start unpacks the engines once into the data folder (a progress bar on the start page shows it);
  they are unpacked again only after an update, or when files are missing. The data goes to a userdata
  folder next to the exe if there is one (portable use), otherwise to %LOCALAPPDATA%\AnnesChessKit. The data
  of an installed 1.0.x is found and used automatically. The licence texts are copied into the data folder
  (licenses\). Build it yourself with scripts\build-exe.ps1.

Fixes:

- Renamed Chess.com or Lichess account: games reviewed under the old name showed as not reviewed in the
  game list, because Chess.com re-sends old games under the new name. Reviews are now also matched by the
  game's address, which never changes. Changing a username in Settings keeps the old one under "Other names
  you play as", so those games still count as yours in Coach, My mistakes and the statistics.

## 1.0.2

New:

- Move times in the review: a chart under the evaluation graph shows how long each move took (White above,
  Black below, key moves in their rating colour). Hover for the time a move took, click to jump to it.
  Toggle with the clock button or T. Needs clock data in the PGN (Chess.com and Lichess exports have it).
- Resizable board in every mode: drag the grip at the board's corner (or use the arrow keys on it);
  double-click resets. The size is shared by all pages and remembered.
- Loading notices with progress bars: pages that go through all your games (My mistakes, Coach, My
  progress, Compared to others, Openings, converting won positions) now say what they are doing and how
  far they are ("Reading your reviews: 812 of 2,712"), instead of showing empty placeholders.

Fixes:

- Time-control icons in the game library follow the usual symbols: a bullet for bullet, lightning for
  blitz, a rabbit for rapid, a turtle for classical (bullet used a rabbit and blitz a flame before).
- No emojis in the app's messages any more (the review summary and My mistakes had one each).

Project page and README:

- The review screenshot and the social preview image show a made-up opponent name instead of a real one.
- New project page and README: what the kit offers that is usually paid elsewhere, with new screenshots of
  the analysis pages and a new social preview image (upload `docs/img/social.png` under Settings > Social
  preview on GitHub after pushing).

Tests:

- New tests for move times and the progress reports.

## 1.0.1

Fixes:

- The re-check of Brilliant moves in older reviews crashed for every game, so those moves were never
  confirmed or downgraded. It runs again now (in the background after the start).
- "Drill these positions" in Coach and My mistakes found no puzzles for "Not punishing your opponent's
  mistakes": positions right after an opponent's error were always left out. Drills of chosen positions
  keep them now (the general puzzle sets still don't).
- Drills built only from the 60 newest examples, so most gave just a handful of puzzles. They now pick
  from up to 400 positions of the category. If none makes a clear puzzle, the message says why.
- The summary cache of your reviews is saved right after a reboot too (it waited a minute before).

Downloads and project:

- Building the Windows downloads works on a fresh PC: python-chess is built inside the bundled Python,
  and Inno Setup is found when installed just for you (winget). GitHub Actions use the Node 24 versions.
- New screenshots of the analysis pages.

## 1.0.0 – first public release, as Anne's Chess Kit

The project was developed under the working name "Brilliant". Data from that version (the `userdata` folder)
works unchanged; `BRILLIANT_USERDATA` is still read if `CHESSKIT_USERDATA` isn't set.

- Game review with Stockfish: accuracy, Brilliant / Great / Best … Mistake / Miss / Blunder ratings,
  coach explanations worded for whoever moved, best lines, retry your mistakes, annotated PGN export.
- Import from Chess.com and Lichess (full history, kept locally) or PGN; background batch analysis.
- Analysis to a fixed depth or for a fixed time per move, with adjustable CPU use.
- Progress dashboard, Insights and Coach: your record, rating, accuracy trends, recurring habits,
  repeated mistakes and a training plan.
- Training: opening trainer, Blunder check, Woodpecker puzzle sets (from your own mistakes or the Lichess
  puzzle database) with a calculation mode, Endgames trainer with explanations and a control overlay, and
  the Instructive bot – a human-like opponent (Maia) with live coaching, gambits, XP and a Nightmare mode
  that plays for your weaknesses.
- Board and piece themes (free piece sets can be downloaded in Settings), material difference on every
  board, premoves.
- Windows downloads: installer and portable zip with their own Python and the engines; licences of
  everything included travel with them.
